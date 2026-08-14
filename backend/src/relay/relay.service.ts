import { Inject, Injectable, Logger, OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Queue } from 'bullmq';
import { PrismaService } from '../common/prisma/prisma.service';
import { DeliveryJobData, deliveryJobId } from '../queue/queue.constants';

export const DELIVERY_QUEUE_TOKEN = Symbol('DELIVERY_QUEUE');

/**
 * Outbox Relay — "DB 커밋 = 배달 예약 확정"을 지키는 다리.
 *
 * PENDING outbox 행을 폴링해 배달 잡을 큐에 적재한 뒤 PUBLISHED로 마킹한다.
 * 순서가 핵심이다: 적재 → 마킹. 적재 후 마킹 전에 죽으면 다음 틱이 같은 행을
 * 다시 적재하므로 "중복은 가능, 유실은 불가능" = at-least-once.
 * 중복 적재는 jobId(deliveryId) 고정으로 큐 레벨에서 흡수한다(best-effort).
 */
@Injectable()
export class RelayService implements OnApplicationShutdown {
  private readonly logger = new Logger(RelayService.name);
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    @Inject(DELIVERY_QUEUE_TOKEN) private readonly queue: Queue<DeliveryJobData>,
  ) {}

  /** 폴링 루프 시작 — 이전 틱이 끝나지 않았으면 건너뛰어 틱 중첩을 막는다. */
  start(): void {
    const intervalMs = this.config.get<number>('HR_OUTBOX_POLL_MS', 500);
    this.timer = setInterval(() => {
      if (this.ticking) return;
      this.ticking = true;
      this.tick()
        .catch((error: unknown) => {
          // 폴링 실패(예: Redis 다운)는 치명적이지 않다 — outbox가 남아 있으므로
          // 다음 틱에 재시도된다. 이것이 "Redis가 죽어도 이벤트는 안 잃는" 이유.
          this.logger.error(`relay tick 실패: ${String(error)}`);
        })
        .finally(() => {
          this.ticking = false;
        });
    }, intervalMs);
    this.logger.log(`outbox relay 시작 — 폴링 주기 ${intervalMs}ms`);
  }

  /**
   * 한 번의 폴링 패스. 적재에 성공한 outbox 행 수를 반환한다.
   *
   * 마킹은 `status='PENDING'` 조건부 UPDATE로 원자화한다 — 릴레이가 이중 실행돼도
   * (배포 겹침 등) 두 번째 마킹은 0행에 적용될 뿐이고, 중복 적재는 at-least-once
   * 명세 안이다.
   */
  async tick(batchSize = 100): Promise<number> {
    const batch = await this.prisma.outboxMessage.findMany({
      where: { status: 'PENDING' },
      orderBy: { id: 'asc' },
      take: batchSize,
      include: { event: { select: { tenantId: true, deliveries: { select: { id: true } } } } },
    });
    if (batch.length === 0) return 0;

    const publishedIds: bigint[] = [];
    for (const message of batch) {
      try {
        await this.queue.addBulk(
          this.targetsOf(message).map((deliveryId) => ({
            name: 'deliver',
            data: { deliveryId, tenantId: message.event.tenantId },
            opts: {
              jobId: message.deliveryId
                ? deliveryJobId(deliveryId, `obx-${message.id}`)
                : deliveryJobId(deliveryId),
              attempts: this.config.get<number>('HR_MAX_ATTEMPTS', 8),
              backoff: { type: 'custom' },
              removeOnComplete: true,
              removeOnFail: true,
            },
          })),
        );
        publishedIds.push(message.id);
      } catch (error) {
        // 적재 실패(Redis 다운 등)면 남은 행은 시도하지 않는다 — 대신 이미 성공한
        // 행의 마킹은 반드시 진행해 다음 틱의 불필요한 재적재를 줄인다.
        this.logger.warn(`outbox #${message.id} 적재 실패, 다음 틱에 재시도: ${String(error)}`);
        break;
      }
    }
    if (publishedIds.length === 0) return 0;

    await this.prisma.outboxMessage.updateMany({
      where: { id: { in: publishedIds }, status: 'PENDING' },
      data: { status: 'PUBLISHED', publishedAt: new Date() },
    });
    return publishedIds.length;
  }

  /** 최초 발행은 이벤트 팬아웃, 재배달/ping은 지정된 배달 한 건만. */
  private targetsOf(message: {
    deliveryId: string | null;
    event: { tenantId: string; deliveries: { id: string }[] };
  }): string[] {
    if (message.deliveryId) return [message.deliveryId];
    return message.event.deliveries.map((d) => d.id);
  }

  async onApplicationShutdown(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    await this.queue.close();
  }
}
