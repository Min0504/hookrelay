import { Inject, Injectable, Logger, OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DelayedError, Queue, Worker } from 'bullmq';
import Redis from 'ioredis';
import { PrismaService } from '../common/prisma/prisma.service';
import { DELIVERY_QUEUE, DeliveryJobData } from '../queue/queue.constants';
import { redisConnectionFromUrl } from '../queue/redis-connection';
import { DELIVERY_QUEUE_TOKEN } from '../relay/relay.service';
import { backoffStrategy, fullJitterDelayMs, RetryPolicy, RetrySignal } from './backoff';
import { WORKER_REDIS_TOKEN } from './circuit.store';
import { DeliveryProcessor } from './delivery.processor';
import { TenantLimiter } from './tenant-limiter';

/**
 * BullMQ 소비자 — 실패 시 예외를 던져 큐가 지연 재시도를 담당하게 한다.
 *
 * 테넌트 슬롯을 못 얻으면 DelayedError로 잡을 잠깐 미룬다. 이건 배달 실패가
 * 아니므로 attemptCount를 올리지 않는다. HTTP 실패만 RetrySignal → 백오프.
 */
@Injectable()
export class WorkerService implements OnApplicationShutdown {
  private readonly logger = new Logger(WorkerService.name);
  private worker: Worker<DeliveryJobData> | null = null;
  private readonly policy: RetryPolicy;
  private readonly tenantRetryMs: number;

  constructor(
    private readonly processor: DeliveryProcessor,
    private readonly prisma: PrismaService,
    private readonly limiter: TenantLimiter,
    private readonly config: ConfigService,
    @Inject(DELIVERY_QUEUE_TOKEN) private readonly queue: Queue<DeliveryJobData>,
    @Inject(WORKER_REDIS_TOKEN) private readonly redis: Redis,
  ) {
    this.policy = {
      baseMs: this.config.get<number>('HR_RETRY_BASE_MS', 30_000),
      capMs: this.config.get<number>('HR_RETRY_CAP_MS', 4 * 60 * 60 * 1000),
      maxAttempts: this.config.get<number>('HR_MAX_ATTEMPTS', 8),
    };
    this.tenantRetryMs = this.config.get<number>('HR_TENANT_RETRY_MS', 200);
  }

  start(): void {
    const concurrency = this.config.get<number>('HR_WORKER_CONCURRENCY', 10);
    this.worker = new Worker<DeliveryJobData>(
      DELIVERY_QUEUE,
      async (job) => {
        const tenantId =
          job.data.tenantId ??
          (
            await this.prisma.delivery.findUnique({
              where: { id: job.data.deliveryId },
              select: { event: { select: { tenantId: true } } },
            })
          )?.event.tenantId;
        if (!tenantId) return this.processor.process(job.data.deliveryId);

        const acquired = await this.limiter.acquire(tenantId);
        if (!acquired) {
          await job.moveToDelayed(Date.now() + this.tenantRetryMs, job.token);
          throw new DelayedError();
        }
        try {
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
        } finally {
          await this.limiter.release(tenantId);
        }
      },
      {
        connection: redisConnectionFromUrl(this.config.getOrThrow<string>('REDIS_URL')),
        concurrency,
        settings: { backoffStrategy },
      },
    );
    this.worker.on('failed', (job, error) => {
      if (error instanceof RetrySignal || error instanceof DelayedError) return;
      this.logger.error(`잡 처리 실패 ${job?.id ?? '?'}: ${String(error)}`);
    });
    this.logger.log(
      `delivery worker 시작 — 동시성 ${concurrency}, 테넌트 상한 ${this.config.get('HR_TENANT_CONCURRENCY', 3)}`,
    );
  }

  async onApplicationShutdown(): Promise<void> {
    await this.worker?.close();
    await this.queue.close();
    this.redis.disconnect();
  }
}
