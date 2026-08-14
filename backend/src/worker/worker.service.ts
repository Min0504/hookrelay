import { Inject, Injectable, Logger, OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Queue, Worker } from 'bullmq';
import { PrismaService } from '../common/prisma/prisma.service';
import { DELIVERY_QUEUE, DeliveryJobData } from '../queue/queue.constants';
import { redisConnectionFromUrl } from '../queue/redis-connection';
import { DELIVERY_QUEUE_TOKEN } from '../relay/relay.service';
import { backoffStrategy, fullJitterDelayMs, RetryPolicy, RetrySignal } from './backoff';
import { DeliveryProcessor } from './delivery.processor';

/**
 * BullMQ 소비자 — 실패 시 예외를 던져 큐가 지연 재시도를 담당하게 한다.
 *
 * 프로세서는 "이번 시도의 결과"만 기록한다. 언제 다시 시도할지는 이 레이어가
 * next_retry_at을 남기고 RetrySignal을 던져, Worker settings.backoffStrategy가
 * 그 지연을 그대로 쓰게 한다. 잡이 Redis delayed set에 남아 워커 크래시에도
 * 재시도가 유실되지 않는다(Redis 전소 시의 복원은 outbox/FAILED_RETRYING 스윕
 * 영역 — 카오스 PR에서 다룬다).
 */
@Injectable()
export class WorkerService implements OnApplicationShutdown {
  private readonly logger = new Logger(WorkerService.name);
  private worker: Worker<DeliveryJobData> | null = null;
  private readonly policy: RetryPolicy;

  constructor(
    private readonly processor: DeliveryProcessor,
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    @Inject(DELIVERY_QUEUE_TOKEN) private readonly queue: Queue<DeliveryJobData>,
  ) {
    this.policy = {
      baseMs: this.config.get<number>('HR_RETRY_BASE_MS', 30_000),
      capMs: this.config.get<number>('HR_RETRY_CAP_MS', 4 * 60 * 60 * 1000),
      maxAttempts: this.config.get<number>('HR_MAX_ATTEMPTS', 8),
    };
  }

  start(): void {
    const concurrency = this.config.get<number>('HR_WORKER_CONCURRENCY', 10);
    this.worker = new Worker<DeliveryJobData>(
      DELIVERY_QUEUE,
      async (job) => {
        const result = await this.processor.process(job.data.deliveryId);
        this.logger.log(`delivery ${job.data.deliveryId} → ${result}`);
        if (result === 'FAILED') {
          const delivery = await this.prisma.delivery.findUnique({
            where: { id: job.data.deliveryId },
            select: { attemptCount: true },
          });
          const delayMs = fullJitterDelayMs(delivery?.attemptCount ?? 1, this.policy);
          await this.prisma.delivery.update({
            where: { id: job.data.deliveryId },
            data: { nextRetryAt: new Date(Date.now() + delayMs) },
          });
          throw new RetrySignal(delayMs);
        }
        return result;
      },
      {
        connection: redisConnectionFromUrl(this.config.getOrThrow<string>('REDIS_URL')),
        concurrency,
        settings: { backoffStrategy },
      },
    );
    this.worker.on('failed', (job, error) => {
      if (error instanceof RetrySignal) return;
      this.logger.error(`잡 처리 실패 ${job?.id ?? '?'}: ${String(error)}`);
    });
    this.logger.log(`delivery worker 시작 — 동시성 ${concurrency}, 최대 ${this.policy.maxAttempts}회`);
  }

  async onApplicationShutdown(): Promise<void> {
    await this.worker?.close();
    await this.queue.close();
  }
}
