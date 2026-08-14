import { Controller, Get, Header } from '@nestjs/common';
import { ensureDefaultMetrics, registry } from './registry';

/**
 * Prometheus 스크레이프 엔드포인트.
 * 인증 없음 — 운영에서는 내부망/스크레이프 전용 포트로만 연다.
 */
@Controller()
export class MetricsController {
  @Get('metrics')
  @Header('Content-Type', 'text/plain; version=0.0.4; charset=utf-8')
  async metrics(): Promise<string> {
    ensureDefaultMetrics();
    return registry.metrics();
  }
}
