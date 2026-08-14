import { INestApplication, ValidationPipe } from '@nestjs/common';
import { GlobalExceptionFilter } from './common/errors/global-exception.filter';
import { HttpMetricsInterceptor } from './metrics/http.interceptor';

/** main과 E2E 테스트가 같은 앱 구성을 쓰도록 분리한 공통 셋업. */
export function setupApp(app: INestApplication): INestApplication {
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );
  app.useGlobalFilters(new GlobalExceptionFilter());
  app.useGlobalInterceptors(new HttpMetricsInterceptor());
  // 콘솔은 nginx 같은 오리진이 기본. Vite 개발(:5173)만 CORS가 필요하다.
  app.enableCors({ origin: true });
  return app;
}
