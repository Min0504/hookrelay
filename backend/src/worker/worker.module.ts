import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { validateEnv } from '../common/config/env.validation';
import { SecretCipher } from '../common/crypto/secret-cipher';
import { PrismaModule } from '../common/prisma/prisma.module';
import { DeliveryHttpClient } from './delivery-http.client';
import { DeliveryProcessor } from './delivery.processor';
import { EndpointCache } from './endpoint-cache';
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
  providers: [SecretCipher, EndpointCache, DeliveryHttpClient, DeliveryProcessor, WorkerService],
  exports: [WorkerService, DeliveryProcessor, EndpointCache],
})
export class WorkerModule {}
