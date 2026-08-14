import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../common/prisma/prisma.service';
import { DeliveryHttpClient } from './delivery-http.client';
import { EndpointCache } from './endpoint-cache';
import { buildDeliveryHeaders, digestHeaders, signDeliveryBody } from './signature';

export type ProcessResult =
  | 'SUCCEEDED'
  | 'FAILED'
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
 *      워커가 시도 후 결과 기록 전에 죽으면 결과 없는 claim 행이 남아
 *      "여기서 크래시로 인한 중복 시도가 있었다"는 증거가 된다.
 */
@Injectable()
export class DeliveryProcessor {
  private readonly logger = new Logger(DeliveryProcessor.name);
  private readonly timeoutMs: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly endpointCache: EndpointCache,
    private readonly httpClient: DeliveryHttpClient,
    config: ConfigService,
  ) {
    this.timeoutMs = config.get<number>('HR_DELIVERY_TIMEOUT_MS', 10_000);
  }

  async process(deliveryId: string): Promise<ProcessResult> {
    const delivery = await this.prisma.delivery.findUnique({
      where: { id: deliveryId },
      include: { event: { select: { id: true, type: true, payload: true, createdAt: true } } },
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
    // 비활성 endpoint로는 시도 자체를 만들지 않는다 — 배달은 PENDING으로 남아
    // 재활성화 후 수동 재배달로 살릴 수 있다(자동 비활성·서킷은 이후 PR의 영역).
    if (endpoint.status !== 'ACTIVE') return 'SKIPPED_ENDPOINT_INACTIVE';

    // 수신자가 받는 본문 — 이벤트의 사실만 담는다. 서명은 이 직렬화 결과 기준이므로
    // 재시도에도 바이트가 동일해야 한다(같은 배달 = 같은 본문 = 같은 서명 검증 결과).
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
    let attemptId: bigint;
    try {
      const attempt = await this.prisma.deliveryAttempt.create({
        data: {
          deliveryId: delivery.id,
          attemptNo,
          requestHeadersDigest: digestHeaders(headers),
        },
        select: { id: true },
      });
      attemptId = attempt.id;
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        // 다른 워커가 같은 시도 번호를 이미 claim — 중복 소비이므로 조용히 물러난다
        return 'SKIPPED_DUPLICATE_CLAIM';
      }
      throw error;
    }

    const outcome = await this.httpClient.send(endpoint.url, headers, body, this.timeoutMs);

    // claim 행을 결과로 완결 — 성공/실패 어느 쪽이든 시도당 정확히 1행의 불변 이력
    await this.prisma.deliveryAttempt.update({
      where: { id: attemptId },
      data: {
        responseStatus: outcome.status,
        responseBodyHead: outcome.bodyHead,
        errorClass: outcome.ok ? null : outcome.errorClass,
        durationMs: outcome.durationMs,
      },
    });

    if (outcome.ok) {
      await this.prisma.delivery.update({
        where: { id: delivery.id },
        data: { status: 'SUCCEEDED', attemptCount: attemptNo },
      });
      return 'SUCCEEDED';
    }

    // 재시도 스케줄(백오프·DEAD 전이)은 다음 단계의 영역 — 여기서는 사실만 기록한다
    await this.prisma.delivery.update({
      where: { id: delivery.id },
      data: { status: 'FAILED_RETRYING', attemptCount: attemptNo },
    });
    return 'FAILED';
  }
}
