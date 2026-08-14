import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client';

/**
 * Prometheus 레지스트리 — 프로세스당 하나.
 *
 * 라벨 카디널리티 규칙: tenant_id / endpoint_id / event_type 은 붙이지 않는다.
 * 테넌트가 늘면 시계열이 폭증해 Prometheus 메모리와 Grafana 쿼리가 같이 죽는다.
 * 구분에 쓰는 라벨은 닫힌 집합(HTTP method/status, 배달 결과 enum, 에러 클래스)뿐이다.
 *
 * API·Worker·Relay가 한 테스트 프로세스에 같이 뜨므로 collectDefaultMetrics는
 * 한 번만 등록한다. 컴포넌트 라벨은 각 main.ts에서만 붙인다(E2E는 생략).
 */
export const registry = new Registry();

let defaultMetricsBound = false;

export function ensureDefaultMetrics(): void {
  if (defaultMetricsBound) return;
  collectDefaultMetrics({ register: registry });
  defaultMetricsBound = true;
}

export function labelComponent(component: 'api' | 'worker' | 'relay'): void {
  registry.setDefaultLabels({ component });
}

export const httpRequestsTotal = new Counter({
  name: 'hookrelay_http_requests_total',
  help: 'API HTTP 요청 수',
  labelNames: ['method', 'route', 'status'] as const,
  registers: [registry],
});

export const httpRequestDuration = new Histogram({
  name: 'hookrelay_http_request_duration_seconds',
  help: 'API HTTP 요청 지연',
  labelNames: ['method', 'route'] as const,
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5],
  registers: [registry],
});

export const eventsPublishedTotal = new Counter({
  name: 'hookrelay_events_published_total',
  help: '접수된 이벤트 수 (멱등 충돌 제외)',
  registers: [registry],
});

export const eventsRateLimitedTotal = new Counter({
  name: 'hookrelay_events_rate_limited_total',
  help: '발행 rate limit으로 거절된 요청',
  labelNames: ['plan'] as const,
  registers: [registry],
});

export const deliveriesTotal = new Counter({
  name: 'hookrelay_deliveries_total',
  help: '워커가 처리한 배달 결과',
  labelNames: ['result'] as const,
  registers: [registry],
});

export const deliveryDuration = new Histogram({
  name: 'hookrelay_delivery_duration_seconds',
  help: '배달 HTTP 왕복 시간 (서킷 생략은 기록하지 않음)',
  buckets: [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 15],
  registers: [registry],
});

export const deliveryErrorsTotal = new Counter({
  name: 'hookrelay_delivery_errors_total',
  help: '배달 실패 분류 (AttemptErrorClass)',
  labelNames: ['error_class'] as const,
  registers: [registry],
});

export const circuitOpenTotal = new Counter({
  name: 'hookrelay_circuit_open_total',
  help: '서킷 OPEN으로 HTTP를 생략한 횟수',
  registers: [registry],
});

export const tenantLimiterDeferredTotal = new Counter({
  name: 'hookrelay_tenant_limiter_deferred_total',
  help: '테넌트 세마포어 부족으로 잡을 미룬 횟수',
  registers: [registry],
});

export const outboxPublishedTotal = new Counter({
  name: 'hookrelay_outbox_published_total',
  help: 'Relay가 큐에 적재한 outbox 행 수',
  registers: [registry],
});

export const outboxPending = new Gauge({
  name: 'hookrelay_outbox_pending',
  help: '아직 큐에 안 올라간 PENDING outbox 행',
  registers: [registry],
});

export const queueJobs = new Gauge({
  name: 'hookrelay_queue_jobs',
  help: 'BullMQ delivery 큐 적체 (state=wait|active|delayed|failed)',
  labelNames: ['state'] as const,
  registers: [registry],
});
