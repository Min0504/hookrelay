/**
 * 시나리오 ① — 발행 RPS 유지 시 API 지연.
 *
 * 배달 완료 지연은 워커·수신자 왕복이라 이 스크립트는 "접수 202"의 p95를 본다.
 * 배달 E2E 지연은 noisy-neighbor.js가 폴링으로 측정한다.
 *
 *   k6 run -e BASE=http://localhost:8080/api -e KEY=$API_KEY bench/k6/publish.js
 */
import http from 'k6/http';
import { check, sleep } from 'k6';
import { Trend, Rate } from 'k6/metrics';
import { uuidv4 } from 'https://jslib.k6.io/k6-utils/1.4.0/index.js';

const publishMs = new Trend('publish_ms', true);
const okRate = new Rate('publish_ok');

export const options = {
  scenarios: {
    publish: {
      executor: 'constant-arrival-rate',
      rate: Number(__ENV.RPS || 100),
      timeUnit: '1s',
      duration: __ENV.DURATION || '30s',
      preAllocatedVUs: 50,
      maxVUs: 200,
    },
  },
  thresholds: {
    publish_ok: ['rate>0.95'],
    http_req_duration: ['p(95)<500'],
  },
};

const BASE = (__ENV.BASE || 'http://localhost:3000').replace(/\/$/, '');
const KEY = __ENV.KEY;

export default function () {
  const res = http.post(
    `${BASE}/events`,
    JSON.stringify({ type: 'order.created', payload: { orderId: uuidv4() } }),
    {
      headers: {
        Authorization: `Bearer ${KEY}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': uuidv4(),
      },
    },
  );
  publishMs.add(res.timings.duration);
  okRate.add(res.status === 202);
  check(res, { '202 accepted': (r) => r.status === 202 });
  sleep(0.001);
}
