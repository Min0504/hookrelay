import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { LoggerModule } from 'nestjs-pino';
import { ApiKeysModule } from './api-keys/api-keys.module';
import { validateEnv } from './common/config/env.validation';
import { PrismaModule } from './common/prisma/prisma.module';
import { DeliveriesModule } from './deliveries/deliveries.module';
import { EndpointsModule } from './endpoints/endpoints.module';
import { EventsModule } from './events/events.module';
import { TenantsModule } from './tenants/tenants.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      validate: validateEnv,
      // 테스트는 process.env가 유일한 진실이어야 한다 — .env 파일이 테스트 픽스처를 덮지 않게
      ignoreEnvFile: process.env.NODE_ENV === 'test',
    }),
    LoggerModule.forRoot({
      pinoHttp: {
        // 구조화 로그 — payload 본문은 로깅 금지 원칙이라 body 시리얼라이저를 두지 않는다
        level: process.env.LOG_LEVEL ?? 'info',
        transport: process.env.NODE_ENV === 'production' ? undefined : { target: 'pino-pretty' },
        redact: ['req.headers.authorization', 'req.headers["x-admin-key"]'],
      },
    }),
    PrismaModule,
    TenantsModule,
    ApiKeysModule,
    EndpointsModule,
    EventsModule,
    DeliveriesModule,
  ],
})
export class AppModule {}
