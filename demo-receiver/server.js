// HookRelay 수신자 모범 구현.
// 웹훅은 at-least-once로 도착한다 — 같은 X-Delivery-Id가 두 번 오면 두 번째는 무시해야 한다.
import express from 'express';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

const PORT = Number(process.env.PORT ?? 4100);
let secrets = new Set([process.env.WEBHOOK_SECRET ?? 'whsec_demo']);
const TOLERANCE_SEC = 300;
const SLOW_MS = Number(process.env.SLOW_MS ?? 800);

const db = new DatabaseSync(process.env.DB_PATH ?? ':memory:');
db.exec(`
  CREATE TABLE IF NOT EXISTS processed_delivery_ids (
    delivery_id TEXT PRIMARY KEY,
    event_id    TEXT NOT NULL,
    received_at TEXT NOT NULL DEFAULT (datetime('now'))
  )
`);

/** 라이브 데모 SSE 구독자 */
const sseClients = new Set();

function broadcast(payload) {
  const line = `data: ${JSON.stringify(payload)}\n\n`;
  for (const res of sseClients) {
    res.write(line);
  }
}

function verify(req) {
  const deliveryId = req.header('x-delivery-id');
  const timestamp = req.header('x-hookrelay-timestamp');
  const signature = req.header('x-hookrelay-signature');
  if (!deliveryId || !timestamp || !signature) {
    return { ok: false, status: 400, error: 'missing HookRelay headers' };
  }
  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > TOLERANCE_SEC) {
    return { ok: false, status: 400, error: 'timestamp out of tolerance' };
  }
  let matched = false;
  for (const s of secrets) {
    const expected = `v1=${createHmac('sha256', s).update(`${timestamp}.${req.body}`).digest('hex')}`;
    const a = Buffer.from(expected);
    const b = Buffer.from(signature);
    if (a.length === b.length && timingSafeEqual(a, b)) {
      matched = true;
      break;
    }
  }
  if (!matched) {
    return { ok: false, status: 401, error: 'invalid signature' };
  }
  return { ok: true, deliveryId, body: JSON.parse(req.body.toString('utf8')) };
}

function consume(deliveryId, eventId) {
  try {
    db.prepare('INSERT INTO processed_delivery_ids (delivery_id, event_id) VALUES (?, ?)').run(
      deliveryId,
      eventId,
    );
    return { duplicate: false };
  } catch {
    return { duplicate: true };
  }
}

const app = express();
app.use((_req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Delivery-Id');
  next();
});

// 서명은 "받은 바이트 그대로" 검증해야 한다 — JSON 파싱 후 재직렬화하면 깨진다.
app.post('/hooks', express.raw({ type: 'application/json', limit: '128kb' }), (req, res) => {
  const checked = verify(req);
  if (!checked.ok) return res.status(checked.status).json({ error: checked.error });

  const { deliveryId, body } = checked;
  const { duplicate } = consume(deliveryId, body.eventId);
  if (duplicate) {
    console.log(`[dup] delivery=${deliveryId} 이미 처리됨 — 무시`);
    broadcast({ kind: 'duplicate', deliveryId, eventId: body.eventId, type: body.type, at: new Date().toISOString() });
    return res.status(200).json({ ok: true, duplicate: true });
  }
  console.log(`[recv] delivery=${deliveryId} event=${body.eventId} type=${body.type}`);
  broadcast({ kind: 'received', deliveryId, eventId: body.eventId, type: body.type, payload: body.payload, at: new Date().toISOString() });
  return res.status(200).json({ ok: true });
});

app.post('/hooks/fail', express.raw({ type: 'application/json', limit: '128kb' }), (req, res) => {
  const checked = verify(req);
  if (!checked.ok) return res.status(checked.status).json({ error: checked.error });
  broadcast({ kind: 'fail', deliveryId: checked.deliveryId, at: new Date().toISOString() });
  return res.status(500).json({ error: 'injected failure' });
});

app.post('/hooks/slow', express.raw({ type: 'application/json', limit: '128kb' }), (req, res) => {
  const checked = verify(req);
  if (!checked.ok) return res.status(checked.status).json({ error: checked.error });
  setTimeout(() => {
    const { duplicate } = consume(checked.deliveryId, checked.body.eventId);
    broadcast({
      kind: duplicate ? 'duplicate' : 'slow',
      deliveryId: checked.deliveryId,
      eventId: checked.body.eventId,
      at: new Date().toISOString(),
    });
    res.status(200).json({ ok: true, slow: true, duplicate });
  }, SLOW_MS);
});

app.get('/received', (_req, res) => {
  const rows = db
    .prepare('SELECT delivery_id, event_id, received_at FROM processed_delivery_ids ORDER BY received_at DESC LIMIT 50')
    .all();
  res.json(rows);
});

app.get('/stream', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'Access-Control-Allow-Origin': '*',
  });
  res.write(':\n\n');
  sseClients.add(res);
  req.on('close', () => sseClients.delete(res));
});

/** 콘솔·k6 시드가 endpoint secret을 런타임에 맞춘다 */
app.post('/config', express.json(), (req, res) => {
  if (typeof req.body?.secret === 'string' && req.body.secret.length > 0) {
    secrets.add(req.body.secret);
  }
  res.json({ ok: true, secrets: secrets.size });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`demo-receiver listening on :${PORT}`);
});
