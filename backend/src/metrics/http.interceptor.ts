import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { Request, Response } from 'express';
import { Observable, finalize } from 'rxjs';
import { httpRequestDuration, httpRequestsTotal } from './registry';

/**
 * RED의 Rate/Errors/Duration 중 API 쪽.
 * 라우트 템플릿(req.route.path)만 라벨로 쓴다 — 실제 URL의 UUID를 붙이면 카디널리티 폭발.
 */
@Injectable()
export class HttpMetricsInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const http = context.switchToHttp();
    const req = http.getRequest<Request>();
    if (req.path === '/metrics') return next.handle();

    const method = req.method;
    const started = process.hrtime.bigint();
    return next.handle().pipe(
      finalize(() => {
        const res = http.getResponse<Response>();
        const route = (req.route as { path?: string } | undefined)?.path ?? 'unmatched';
        httpRequestsTotal.inc({ method, route, status: String(res.statusCode) });
        httpRequestDuration.observe({ method, route }, Number(process.hrtime.bigint() - started) / 1e9);
      }),
    );
  }
}
