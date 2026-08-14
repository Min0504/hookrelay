/**
 * 시나리오 ② — noisy neighbor 격리.
 *
 * 테넌트 A는 /hooks/slow (800ms), 테넌트 B는 /hooks (즉시 200).
 * 같은 워커 풀에서 B의 배달 완료 시간(발행→SUCCEEDED) p95를 잰다.
 *
 * 격리 전: HR_TENANT_CONCURRENCY=0 (상한 없음) 으로 워커를 재기동한 뒤 이 스크립트.
 * 격리 후: 기본값 3. 두 결과의 B p95 차이가 이 프로젝트의 킬러 수치.
 *
 *   k6 run -e BASE=... -e KEY_A=... -e KEY_B=... bench/k6/noisy-neighbor.js
 */
import http from 'k6/http';
import { check, sleep } from 'k6';
import { Trend } from 'k6/metrics';
import { uuidv4 } from 'https://jslib.k6.io/k6-utils/1.4.0/index.js';

const deliveryB = new Trend('tenant_b_delivery_ms', true);
const deliveryA = new Trend('tenant_a_delivery_ms', true);

export const options = {
  scenarios: {
    neighbor: {
      executor: 'constant-arrival-rate',
      rate: Number(__ENV.RPS || 20),
      timeUnit: '1s',
      duration: __ENV.DURATION || '20s',
      preAllocatedVUs: 30,
      maxVUs: 80,
    },
  },
};

const BASE = (__ENV.BASE || 'http://localhost:3000').replace(/\/$/, '');

function publish(key) {
  return http.post(
    `${BASE}/events`,
    JSON.stringify({ type: 'order.created', payload: { id: uuidv4() } }),
    {
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': uuidv4(),
      },
    },
  );
}

function waitSucceeded(key, eventId, trend) {
  const started = Date.now();
  for (let i = 0; i < 40; i += 1) {
    const res = http.get(`${BASE}/events/${eventId}/deliveries`, {
      headers: { Authorization: `Bearer ${key}` },
    });
    if (res.status === 200) {
      const body = res.json();
      const st = body.deliveries && body.deliveries[0] && body.deliveries[0].status;
      if (st === 'SUCCEEDED') {
        trend.add(Date.now() - started);
        return;
      }
    }
    sleep(0.2);
  }
}

export default function () {
  const a = publish(__ENV.KEY_A);
  const b = publish(__ENV.KEY_B);
  check(a, { 'A 202': (r) => r.status === 202 });
  check(b, { 'B 202': (r) => r.status === 202 });
  if (a.status === 202) waitSucceeded(__ENV.KEY_A, a.json('eventId'), deliveryA);
  if (b.status === 202) waitSucceeded(__ENV.KEY_B, b.json('eventId'), deliveryB);
}
