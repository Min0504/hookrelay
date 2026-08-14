/**
 * 시나리오 ③ — DLQ 일괄 재배달.
 *
 * DEAD 배달을 커서로 모아 재배달한다. 폭주 시 시스템 거동(202 유지, 큐 적체)을 본다.
 *
 *   k6 run -e BASE=... -e KEY=... bench/k6/dlq-redeliver.js
 */
import http from 'k6/http';
import { check } from 'k6';
import { Counter } from 'k6/metrics';

const redelivered = new Counter('redelivered');

export const options = {
  vus: 5,
  duration: __ENV.DURATION || '15s',
};

const BASE = (__ENV.BASE || 'http://localhost:3000').replace(/\/$/, '');
const KEY = __ENV.KEY;

export default function () {
  const list = http.get(`${BASE}/deliveries?status=DEAD`, {
    headers: { Authorization: `Bearer ${KEY}` },
  });
  if (list.status !== 200) return;
  const body = list.json();
  const rows = body.deliveries || [];
  if (rows.length === 0) return;
  const id = rows[Math.floor(Math.random() * rows.length)].deliveryId;
  const res = http.post(`${BASE}/deliveries/${id}/redeliver`, null, {
    headers: { Authorization: `Bearer ${KEY}` },
  });
  check(res, { 'redeliver 201/200': (r) => r.status === 201 || r.status === 200 });
  if (res.status === 201 || res.status === 200) redelivered.add(1);
}
