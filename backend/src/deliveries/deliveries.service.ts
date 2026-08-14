import { Injectable } from '@nestjs/common';
import { DeliveryStatus } from '@prisma/client';
import { Errors } from '../common/errors/errors';
import { PrismaService } from '../common/prisma/prisma.service';

const PAGE_SIZE = 20;

export interface DeliveryCursor {
  createdAt: string;
  id: string;
}

/**
 * 배달 조회·재배달.
 *
 * 재배달은 큐를 직접 만지지 않는다. 상태를 PENDING으로 되돌리고 outbox에
 * "이 배달만" 적재하라는 행을 넣어, Redis가 죽은 동안에도 예약이 남는다.
 * Relay가 복구되면 그 행부터 재개한다 — 발행 경로와 같은 원자성 모델.
 */
@Injectable()
export class DeliveriesService {
  constructor(private readonly prisma: PrismaService) {}

  async list(tenantId: string, status?: DeliveryStatus, cursor?: string) {
    const decoded = cursor ? decodeCursor(cursor) : null;
    const rows = await this.prisma.delivery.findMany({
      where: {
        event: { tenantId },
        ...(status ? { status } : {}),
        ...(decoded
          ? {
              OR: [
                { createdAt: { lt: new Date(decoded.createdAt) } },
                { createdAt: new Date(decoded.createdAt), id: { lt: decoded.id } },
              ],
            }
          : {}),
      },
      include: {
        endpoint: { select: { url: true } },
        event: { select: { type: true } },
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: PAGE_SIZE + 1,
    });

    const hasMore = rows.length > PAGE_SIZE;
    const page = hasMore ? rows.slice(0, PAGE_SIZE) : rows;
    const last = page[page.length - 1];
    return {
      deliveries: page.map((d) => this.toView(d)),
      nextCursor: hasMore && last ? encodeCursor({ createdAt: last.createdAt.toISOString(), id: last.id }) : null,
    };
  }

  async attempts(tenantId: string, deliveryId: string) {
    const delivery = await this.requireOwned(tenantId, deliveryId);
    const attempts = await this.prisma.deliveryAttempt.findMany({
      where: { deliveryId },
      orderBy: { attemptNo: 'asc' },
    });
    return {
      deliveryId: delivery.id,
      status: delivery.status,
      attemptCount: delivery.attemptCount,
      nextRetryAt: delivery.nextRetryAt,
      attempts: attempts.map((a) => ({
        attemptNo: a.attemptNo,
        responseStatus: a.responseStatus,
        responseBodyHead: a.responseBodyHead,
        errorClass: a.errorClass,
        durationMs: a.durationMs,
        requestHeadersDigest: a.requestHeadersDigest,
        attemptedAt: a.attemptedAt,
      })),
    };
  }

  async redeliver(tenantId: string, deliveryId: string) {
    const delivery = await this.requireOwned(tenantId, deliveryId);
    await this.prisma.$transaction([
      this.prisma.delivery.update({
        where: { id: delivery.id },
        data: { status: 'PENDING', nextRetryAt: null },
      }),
      this.prisma.outboxMessage.create({
        data: { eventId: delivery.eventId, deliveryId: delivery.id },
      }),
    ]);
    return { deliveryId: delivery.id, status: 'PENDING' as const };
  }

  private async requireOwned(tenantId: string, deliveryId: string) {
    const delivery = await this.prisma.delivery.findFirst({
      where: { id: deliveryId, event: { tenantId } },
    });
    if (!delivery) throw Errors.deliveryNotFound();
    return delivery;
  }

  private toView(d: {
    id: string;
    endpointId: string;
    status: DeliveryStatus;
    attemptCount: number;
    nextRetryAt: Date | null;
    createdAt: Date;
    updatedAt: Date;
    endpoint: { url: string };
    event: { type: string };
  }) {
    return {
      deliveryId: d.id,
      endpointId: d.endpointId,
      endpointUrl: d.endpoint.url,
      eventType: d.event.type,
      status: d.status,
      attemptCount: d.attemptCount,
      nextRetryAt: d.nextRetryAt,
      createdAt: d.createdAt,
      updatedAt: d.updatedAt,
    };
  }
}

function encodeCursor(c: DeliveryCursor): string {
  return Buffer.from(JSON.stringify(c), 'utf8').toString('base64url');
}

function decodeCursor(raw: string): DeliveryCursor {
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as DeliveryCursor;
    if (!parsed?.createdAt || !parsed?.id) throw new Error('bad');
    return parsed;
  } catch {
    throw Errors.invalidCursor();
  }
}
