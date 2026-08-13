import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'crypto';
import { Errors } from '../common/errors/errors';
import { PrismaService } from '../common/prisma/prisma.service';
import { PublishEventDto } from './dto/publish-event.dto';

/** payload 상한 64KB — 웹훅은 알림이지 데이터 전송 채널이 아니다. 큰 본문은 URL로 참조시킨다. */
export const MAX_PAYLOAD_BYTES = 64 * 1024;

export interface PublishResult {
  eventId: string;
  deliveries: { deliveryId: string; endpointId: string }[];
}

@Injectable()
export class EventsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * 이벤트 발행 — Transactional Outbox의 쓰기 절반.
   *
   * events INSERT 커밋 후 큐에 적재하는 사이에 프로세스가 죽으면 그 이벤트는 영원히
   * 배달되지 않는다(이중 쓰기 문제). DB와 Redis를 하나의 트랜잭션으로 묶을 수 없으므로,
   * 이벤트·배달(팬아웃)·outbox 행을 "같은 DB 트랜잭션"으로 기록하는 것까지만 API의 책임으로
   * 하고, 큐 적재는 별도 Relay가 outbox를 폴링해 수행한다. DB 커밋 = 배달 예약 확정.
   */
  async publish(
    tenantId: string,
    dto: PublishEventDto,
    idempotencyKey: string,
  ): Promise<PublishResult> {
    const sizeBytes = Buffer.byteLength(JSON.stringify(dto.payload), 'utf8');
    if (sizeBytes > MAX_PAYLOAD_BYTES) {
      throw Errors.payloadTooLarge(sizeBytes, MAX_PAYLOAD_BYTES);
    }

    try {
      return await this.prisma.$transaction(async (tx) => {
        const event = await tx.event.create({
          data: {
            tenantId,
            type: dto.type,
            payload: dto.payload as Prisma.InputJsonValue,
            idempotencyKey,
          },
        });

        // 팬아웃 대상: 이 타입을 구독 중인 ACTIVE endpoint.
        // DISABLED(수동/서킷) endpoint는 배달 자체를 만들지 않는다 — 복구 후 재발행이 계약.
        const targets = await tx.endpoint.findMany({
          where: {
            tenantId,
            status: 'ACTIVE',
            subscriptions: { some: { eventType: dto.type } },
          },
          select: { id: true },
          orderBy: { createdAt: 'asc' },
        });

        // createMany는 생성된 행을 돌려주지 않으므로 X-Delivery-Id가 될 UUID를 앱에서 채번한다.
        const deliveries = targets.map((endpoint) => ({
          id: randomUUID(),
          eventId: event.id,
          endpointId: endpoint.id,
        }));
        if (deliveries.length > 0) {
          await tx.delivery.createMany({ data: deliveries });
          // outbox 행은 "적재할 배달이 있다"는 표시 — 구독자가 없으면 만들지 않는다.
          await tx.outboxMessage.create({ data: { eventId: event.id } });
        }

        return {
          eventId: event.id,
          deliveries: deliveries.map((d) => ({ deliveryId: d.id, endpointId: d.endpointId })),
        };
      });
    } catch (error) {
      // 발행 멱등성 — UNIQUE(tenant_id, idempotency_key) 충돌이면 기존 eventId를 돌려준다.
      // "먼저 조회 후 삽입"은 동시 요청에 레이스가 있으므로 제약 충돌을 정상 경로로 취급한다.
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        const existing = await this.prisma.event.findUnique({
          where: { tenantId_idempotencyKey: { tenantId, idempotencyKey } },
          select: { id: true },
        });
        if (existing) throw Errors.duplicateEvent(existing.id);
      }
      throw error;
    }
  }

  /** 이벤트의 배달 현황 — 202로 접수된 발행의 "그 후"를 조회하는 창구. */
  async getDeliveries(tenantId: string, eventId: string) {
    const event = await this.prisma.event.findFirst({
      where: { id: eventId, tenantId },
      select: { id: true, type: true, createdAt: true },
    });
    if (!event) throw Errors.eventNotFound();

    const deliveries = await this.prisma.delivery.findMany({
      where: { eventId },
      include: { endpoint: { select: { url: true } } },
      orderBy: { createdAt: 'asc' },
    });

    return {
      eventId: event.id,
      type: event.type,
      createdAt: event.createdAt,
      deliveries: deliveries.map((d) => ({
        deliveryId: d.id,
        endpointId: d.endpointId,
        endpointUrl: d.endpoint.url,
        status: d.status,
        attemptCount: d.attemptCount,
        nextRetryAt: d.nextRetryAt,
        updatedAt: d.updatedAt,
      })),
    };
  }
}
