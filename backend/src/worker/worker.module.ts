import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { Queue } from 'bullmq';
import Redis from 'ioredis';
import { validateEnv } from '../common/config/env.validation';
import { SecretCipher } from '../common/crypto/secret-cipher';
import { PrismaModule } from '../common/prisma/prisma.module';
import { DELIVERY_QUEUE } from '../queue/queue.constants';
import { redisConnectionFromUrl } from '../queue/redis-connection';
import { DELIVERY_QUEUE_TOKEN } from '../relay/relay.service';
import { CircuitStore, WORKER_REDIS_TOKEN } from './circuit.store';
import { DeliveryHttpClient } from './delivery-http.client';
import { DeliveryProcessor } from './delivery.processor';
import { EndpointCache } from './endpoint-cache';
import { TenantLimiter } from './tenant-limiter';
import { WorkerService } from './worker.service';

/**
 * Worker 전용 모듈 — API 서버와 별도 프로세스로 부팅되며(src/worker/main.ts)
 * N대로 수평 확장하는 대상이다. HTTP 서버 없이 큐 소비만 한다.
 */
@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      validate: validateEnv,
      ignoreEnvFile: process.env.NODE_ENV === 'test',
    }),
    PrismaModule,
  ],
  providers: [
    {
      provide: DELIVERY_QUEUE_TOKEN,
      useFactory: (config: ConfigService) =>
        new Queue(DELIVERY_QUEUE, {
          connection: redisConnectionFromUrl(config.getOrThrow<string>('REDIS_URL')),
        }),
      inject: [ConfigService],
    },
    {
      provide: WORKER_REDIS_TOKEN,
      // BullMQ 연결과는 별도. maxRetriesPerRequest:null 이면 Redis 다운 시 GET이 영원히 막힌다.
      // 서킷/세마포어는 fail-open이므로 짧게 실패해야 한다.
      useFactory: (config: ConfigService) =>
        new Redis(config.getOrThrow<string>('REDIS_URL'), {
          maxRetriesPerRequest: 2,
          enableOfflineQueue: false,
        }),
      inject: [ConfigService],
    },
    SecretCipher,
    EndpointCache,
    DeliveryHttpClient,
    CircuitStore,
    TenantLimiter,
    DeliveryProcessor,
    WorkerService,
  ],
  exports: [WorkerService, DeliveryProcessor, EndpointCache, CircuitStore, TenantLimiter],
})
export class WorkerModule {}
