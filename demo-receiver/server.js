// HookRelay 수신자 모범 구현.
// 웹훅은 at-least-once로 도착한다 — 같은 X-Delivery-Id가 두 번 오면 두 번째는 무시해야 한다.
import express from 'express';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

const PORT = Number(process.env.PORT ?? 4100);
const SECRET = process.env.WEBHOOK_SECRET ?? 'whsec_demo';
const TOLERANCE_SEC = 300;

const db = new DatabaseSync(process.env.DB_PATH ?? ':memory:');
db.exec(`
  CREATE TABLE IF NOT EXISTS processed_delivery_ids (
    delivery_id TEXT PRIMARY KEY,
    event_id    TEXT NOT NULL,
    received_at TEXT NOT NULL DEFAULT (datetime('now'))
  )
`);

const app = express();

// 서명은 "받은 바이트 그대로" 검증해야 한다 — JSON 파싱 후 재직렬화하면 깨진다.
app.post('/hooks', express.raw({ type: 'application/json', limit: '128kb' }), (req, res) => {
  const deliveryId = req.header('x-delivery-id');
  const timestamp = req.header('x-hookrelay-timestamp');
  const signature = req.header('x-hookrelay-signature');
  if (!deliveryId || !timestamp || !signature) {
    return res.status(400).json({ error: 'missing HookRelay headers' });
  }

  // 리플레이 방어 — 서명된 시각이 허용 오차를 벗어나면 거절
  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > TOLERANCE_SEC) {
    return res.status(400).json({ error: 'timestamp out of tolerance' });
  }

  const expected = `v1=${createHmac('sha256', SECRET).update(`${timestamp}.${req.body}`).digest('hex')}`;
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return res.status(401).json({ error: 'invalid signature' });
  }

  const body = JSON.parse(req.body.toString('utf8'));

  // 멱등 소비의 핵심 — PRIMARY KEY 충돌이면 이미 처리한 배달의 재시도다.
  // 부수효과(주문 처리 등)를 실행하지 않고 200을 돌려줘 재시도 루프를 끊는다.
  try {
    db.prepare('INSERT INTO processed_delivery_ids (delivery_id, event_id) VALUES (?, ?)').run(
      deliveryId,
      body.eventId,
    );
  } catch {
    console.log(`[dup] delivery=${deliveryId} 이미 처리됨 — 무시`);
    return res.status(200).json({ ok: true, duplicate: true });
  }

  console.log(`[recv] delivery=${deliveryId} event=${body.eventId} type=${body.type}`);
  return res.status(200).json({ ok: true });
});

// 데모 확인용 — 지금까지 받은 배달 목록
app.get('/received', (_req, res) => {
  const rows = db
    .prepare('SELECT delivery_id, event_id, received_at FROM processed_delivery_ids ORDER BY received_at DESC LIMIT 50')
    .all();
  res.json(rows);
});

app.listen(PORT, () => {
  console.log(`demo-receiver listening on :${PORT} (secret=${SECRET === 'whsec_demo' ? 'whsec_demo (기본값)' : '설정됨'})`);
});
