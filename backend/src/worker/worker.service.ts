import { Injectable, Logger, OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Worker } from 'bullmq';
import { DELIVERY_QUEUE, DeliveryJobData } from '../queue/queue.constants';
import { redisConnectionFromUrl } from '../queue/redis-connection';
import { DeliveryProcessor } from './delivery.processor';

/**
 * BullMQ 소비자 수명주기 — 잡을 받아 DeliveryProcessor에 넘기는 껍데기.
 * 처리 로직과 큐 소비를 분리해 프로세서를 큐 없이 단독 테스트할 수 있게 한다.
 */
@Injectable()
export class WorkerService implements OnApplicationShutdown {
  private readonly logger = new Logger(WorkerService.name);
  private worker: Worker<DeliveryJobData> | null = null;

  constructor(
    private readonly processor: DeliveryProcessor,
    private readonly config: ConfigService,
  ) {}

  start(): void {
    const concurrency = this.config.get<number>('HR_WORKER_CONCURRENCY', 10);
    this.worker = new Worker<DeliveryJobData>(
      DELIVERY_QUEUE,
      async (job) => {
        const result = await this.processor.process(job.data.deliveryId);
        this.logger.log(`delivery ${job.data.deliveryId} → ${result}`);
        return result;
      },
      {
        connection: redisConnectionFromUrl(this.config.getOrThrow<string>('REDIS_URL')),
        // 배달은 외부 HTTP 대기가 지배하는 I/O 바운드 — 프로세스당 동시성을 수십으로
        // 올릴 수 있는 것이 Node 이벤트 루프의 장점이다
        concurrency,
      },
    );
    this.worker.on('failed', (job, error) => {
      this.logger.error(`잡 처리 실패 ${job?.id ?? '?'}: ${String(error)}`);
    });
    this.logger.log(`delivery worker 시작 — 동시성 ${concurrency}`);
  }

  async onApplicationShutdown(): Promise<void> {
    // 진행 중인 잡을 마저 끝내고 닫는다 — 강제 종료는 중복 배달만 늘린다
    await this.worker?.close();
  }
}
