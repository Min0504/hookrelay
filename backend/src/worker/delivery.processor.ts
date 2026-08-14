import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AttemptErrorClass, Prisma } from '@prisma/client';
import { PrismaService } from '../common/prisma/prisma.service';
import { CircuitStore } from './circuit.store';
import { DeliveryHttpClient } from './delivery-http.client';
import { EndpointCache } from './endpoint-cache';
import { buildDeliveryHeaders, digestHeaders, signDeliveryBody } from './signature';

export type ProcessResult =
  | 'SUCCEEDED'
  | 'FAILED'
  | 'DEAD'
  | 'SKIPPED_ALREADY_DONE'
  | 'SKIPPED_ENDPOINT_INACTIVE'
  | 'SKIPPED_DUPLICATE_CLAIM'
  | 'SKIPPED_MISSING';

/**
 * 배달 1건의 실제 처리 — at-least-once 세계에서 안전하게 동작하도록 설계한다.
 *
 * 잡은 중복 도착할 수 있다(outbox 재적재, 수동 재배달, 워커 크래시 후 재소비).
 * 방어는 두 겹이다:
 *   1) 상태 가드 — 이미 SUCCEEDED/DEAD인 배달은 시도하지 않는다.
 *   2) 시도 claim — delivery_attempts에 UNIQUE(delivery_id, attempt_no)로
 *      "시도 전 INSERT"를 걸어, 같은 시도 번호의 동시 실행을 DB가 차단한다.
 *
 * 서킷 OPEN이면 HTTP를 생략하고 CIRCUIT_OPEN으로 즉시 실패 처리한다.
 * 시도는 소모되지만 워커는 10초를 기다리지 않는다.
 */
@Injectable()
export class DeliveryProcessor {
  private readonly logger = new Logger(DeliveryProcessor.name);
  private readonly timeoutMs: number;
  private readonly maxAttempts: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly endpointCache: EndpointCache,
    private readonly httpClient: DeliveryHttpClient,
    private readonly circuit: CircuitStore,
    config: ConfigService,
  ) {
    this.timeoutMs = config.get<number>('HR_DELIVERY_TIMEOUT_MS', 10_000);
    this.maxAttempts = config.get<number>('HR_MAX_ATTEMPTS', 8);
  }

  async process(deliveryId: string): Promise<ProcessResult> {
    const delivery = await this.prisma.delivery.findUnique({
      where: { id: deliveryId },
      include: { event: { select: { id: true, type: true, payload: true, createdAt: true, tenantId: true } } },
    });
    if (!delivery) {
      this.logger.warn(`존재하지 않는 배달 잡 수신: ${deliveryId}`);
      return 'SKIPPED_MISSING';
    }
    if (delivery.status === 'SUCCEEDED' || delivery.status === 'DEAD') {
      return 'SKIPPED_ALREADY_DONE';
    }

    const endpoint = await this.endpointCache.get(delivery.endpointId);
    if (!endpoint) return 'SKIPPED_MISSING';
    if (endpoint.status !== 'ACTIVE') return 'SKIPPED_ENDPOINT_INACTIVE';

    const body = JSON.stringify({
      eventId: delivery.event.id,
      type: delivery.event.type,
      occurredAt: delivery.event.createdAt.toISOString(),
      payload: delivery.event.payload,
    });
    const timestampSec = Math.floor(Date.now() / 1000);
    const headers = buildDeliveryHeaders({
      eventType: delivery.event.type,
      deliveryId: delivery.id,
      timestampSec,
      signature: signDeliveryBody(endpoint.secret, timestampSec, body),
    });

    const attemptNo = delivery.attemptCount + 1;
    const claimed = await this.claim(delivery.id, attemptNo, digestHeaders(headers));
    if (claimed === 'duplicate') return 'SKIPPED_DUPLICATE_CLAIM';

    const allowed = await this.circuit.allow(delivery.endpointId);
    if (!allowed) {
      return this.finishFailure(delivery.id, claimed, attemptNo, {
        errorClass: AttemptErrorClass.CIRCUIT_OPEN,
        bodyHead: 'circuit open — HTTP skipped',
        durationMs: 0,
      });
    }

    const outcome = await this.httpClient.send(endpoint.url, headers, body, this.timeoutMs);

    await this.prisma.deliveryAttempt.update({
      where: { id: claimed },
      data: {
        responseStatus: outcome.status,
        responseBodyHead: outcome.bodyHead,
        errorClass: outcome.ok ? null : outcome.errorClass,
        durationMs: outcome.durationMs,
      },
    });

    if (outcome.ok) {
      await this.circuit.success(delivery.endpointId);
      await this.prisma.endpoint.update({
        where: { id: delivery.endpointId },
        data: { consecutiveFailures: 0 },
      });
      await this.prisma.delivery.update({
        where: { id: delivery.id },
        data: { status: 'SUCCEEDED', attemptCount: attemptNo, nextRetryAt: null },
      });
      return 'SUCCEEDED';
    }

    const { disable } = await this.circuit.failure(delivery.endpointId);
    await this.prisma.endpoint.update({
      where: { id: delivery.endpointId },
      data: {
        consecutiveFailures: { increment: 1 },
        ...(disable ? { status: 'DISABLED_AUTO' as const } : {}),
      },
    });
    if (disable) this.endpointCache.invalidate(delivery.endpointId);

    const dead = attemptNo >= this.maxAttempts;
    await this.prisma.delivery.update({
      where: { id: delivery.id },
      data: { status: dead ? 'DEAD' : 'FAILED_RETRYING', attemptCount: attemptNo },
    });
    return dead ? 'DEAD' : 'FAILED';
  }

  private async claim(
    deliveryId: string,
    attemptNo: number,
    digest: string,
  ): Promise<bigint | 'duplicate'> {
    try {
      const attempt = await this.prisma.deliveryAttempt.create({
        data: { deliveryId, attemptNo, requestHeadersDigest: digest },
        select: { id: true },
      });
      return attempt.id;
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        return 'duplicate';
      }
      throw error;
    }
  }

  private async finishFailure(
    deliveryId: string,
    attemptId: bigint,
    attemptNo: number,
    rec: { errorClass: AttemptErrorClass; bodyHead: string; durationMs: number },
  ): Promise<ProcessResult> {
    await this.prisma.deliveryAttempt.update({
      where: { id: attemptId },
      data: {
        errorClass: rec.errorClass,
        responseBodyHead: rec.bodyHead,
        durationMs: rec.durationMs,
      },
    });
    const dead = attemptNo >= this.maxAttempts;
    await this.prisma.delivery.update({
      where: { id: deliveryId },
      data: { status: dead ? 'DEAD' : 'FAILED_RETRYING', attemptCount: attemptNo },
    });
    return dead ? 'DEAD' : 'FAILED';
  }
}
