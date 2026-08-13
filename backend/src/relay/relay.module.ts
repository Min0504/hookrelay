import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { Queue } from 'bullmq';
import { validateEnv } from '../common/config/env.validation';
import { PrismaModule } from '../common/prisma/prisma.module';
import { DELIVERY_QUEUE } from '../queue/queue.constants';
import { redisConnectionFromUrl } from '../queue/redis-connection';
import { DELIVERY_QUEUE_TOKEN, RelayService } from './relay.service';

/**
 * Relay 전용 모듈 — API 서버와 별도 프로세스로 부팅된다(src/relay/main.ts).
 * API는 outbox까지만 쓰므로 Redis 연결은 이 프로세스에만 존재한다.
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
    RelayService,
  ],
  exports: [RelayService],
})
export class RelayModule {}
