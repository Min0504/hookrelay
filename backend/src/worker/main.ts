import { NestFactory } from '@nestjs/core';
import { WorkerModule } from './worker.module';
import { WorkerService } from './worker.service';

/** Delivery Worker 단독 부트스트랩 — 큐 소비 → HTTP 배달 → 결과 기록. */
async function bootstrap(): Promise<void> {
  const app = await NestFactory.createApplicationContext(WorkerModule);
  app.enableShutdownHooks();
  app.get(WorkerService).start();
}

void bootstrap();
