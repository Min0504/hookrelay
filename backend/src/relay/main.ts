import { NestFactory } from '@nestjs/core';
import { RelayModule } from './relay.module';
import { RelayService } from './relay.service';

/** Outbox Relay 단독 부트스트랩 — HTTP 서버 없이 폴링 루프만 돈다. */
async function bootstrap(): Promise<void> {
  const app = await NestFactory.createApplicationContext(RelayModule);
  app.enableShutdownHooks();
  app.get(RelayService).start();
}

void bootstrap();
