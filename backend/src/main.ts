import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module';
import { setupApp } from './app.setup';
import { ensureDefaultMetrics, labelComponent } from './metrics/registry';

async function bootstrap(): Promise<void> {
  labelComponent('api');
  ensureDefaultMetrics();
  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  app.useLogger(app.get(Logger));
  setupApp(app);
  const port = app.get(ConfigService).get<number>('PORT', 3000);
  await app.listen(port);
}

void bootstrap();
