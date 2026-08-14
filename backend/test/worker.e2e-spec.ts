import { INestApplicationContext } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { RedisContainer, StartedRedisContainer } from '@testcontainers/redis';
import { Queue } from 'bullmq';
import { createHmac, randomUUID } from 'crypto';
import * as http from 'http';
import { AddressInfo } from 'net';
import request from 'supertest';
import type { DeliveryProcessor } from '../src/worker/delivery.processor';
import type { EndpointCache } from '../src/worker/endpoint-cache';
import type { RelayService } from '../src/relay/relay.service';
import { DELIVERY_QUEUE } from '../src/queue/queue.constants';
import { redisConnectionFromUrl } from '../src/queue/redis-connection';
import { createTestApp, TEST_ADMIN_KEY, TestContext } from './helpers/test-app';

interface ReceivedRequest {
  path: string;
  headers: http.IncomingHttpHeaders;
  rawBody: string;
}

/**
 * Worker 배달 E2E — 발행부터 수신자의 손까지.
 * 실제 로컬 HTTP 수신 서버를 띄워 HMAC 서명·헤더 계약을 바이트 수준으로 검증하고,
 * 실패 분류(5xx/타임아웃/연결 거부/SSRF)와 시도 이력(claim→결과)의 정확성을 확인한다.
 */
describe('Delivery Worker', () => {
  let ctx: TestContext;
  let redis: StartedRedisContainer;
  let workerCtx: INestApplicationContext;
  let relayCtx: INestApplicationContext;
  let processor: DeliveryProcessor;
  let endpointCache: EndpointCache;
  let relay: RelayService;
  let queue: Queue;

  let receiver: http.Server;
  let receiverPort: number;
  const received: ReceivedRequest[] = [];

  beforeAll(async () => {
    // 테스트 수신 서버 — 경로별로 성공/실패/지연을 연기한다
    receiver = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        const rawBody = Buffer.concat(chunks).toString('utf8');
        if (req.headers['user-agent'] === 'HookRelay/1.0') {
          received.push({ path: req.url ?? '', headers: req.headers, rawBody });
        }
        if (req.url === '/fail-500') {
          res.writeHead(500, { 'content-type': 'application/json' });
          res.end('{"error":"receiver exploded"}');
        } else if (req.url === '/slow') {
          setTimeout(() => {
            res.writeHead(200);
            res.end('late');
          }, 3000);
        } else {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end('{"ok":true}');
        }
      });
    });
    await new Promise<void>((resolve) => receiver.listen(0, '127.0.0.1', resolve));
    receiverPort = (receiver.address() as AddressInfo).port;

    redis = await new RedisContainer('redis:7-alpine').start();
    process.env.REDIS_URL = redis.getConnectionUrl();
    // 수신자가 127.0.0.1 http이므로 로컬 데모 플래그로 완화 — SSRF 가드 자체는
    // 별도 케이스에서 allowPrivate=false 클라이언트로 직접 검증한다
    ctx = await createTestApp({
      HR_ALLOW_INSECURE_HTTP: 'true',
      HR_ALLOW_PRIVATE_DESTINATIONS: 'true',
      HR_DELIVERY_TIMEOUT_MS: '1000',
    });

    const { WorkerModule } = await import('../src/worker/worker.module');
    const { DeliveryProcessor } = await import('../src/worker/delivery.processor');
    const { EndpointCache } = await import('../src/worker/endpoint-cache');
    workerCtx = await Test.createTestingModule({ imports: [WorkerModule] }).compile();
    await workerCtx.init();
    processor = workerCtx.get(DeliveryProcessor);
    endpointCache = workerCtx.get(EndpointCache);

    const { RelayModule } = await import('../src/relay/relay.module');
    const { RelayService } = await import('../src/relay/relay.service');
    relayCtx = await Test.createTestingModule({ imports: [RelayModule] }).compile();
    await relayCtx.init();
    relay = relayCtx.get(RelayService);

    queue = new Queue(DELIVERY_QUEUE, {
      connection: redisConnectionFromUrl(redis.getConnectionUrl()),
    });
  }, 240_000);

  afterAll(async () => {
    await queue.close();
    await relayCtx.close();
    await workerCtx.close();
    await ctx.stop();
    await redis.stop();
    await new Promise<void>((resolve, reject) =>
      receiver.close((e) => (e ? reject(e) : resolve())),
    );
  });

  beforeEach(async () => {
    received.length = 0;
    await queue.obliterate({ force: true });
  });

  async function seed(path: string): Promise<{ apiKey: string; endpointId: string; secret: string }> {
    const name = `wk-${randomUUID().slice(0, 8)}`;
    const tenantRes = await request(ctx.app.getHttpServer())
      .post('/tenants')
      .set('X-Admin-Key', TEST_ADMIN_KEY)
      .send({ name })
      .expect(201);
    const apiKey: string = tenantRes.body.apiKey;

    const epRes = await request(ctx.app.getHttpServer())
      .post('/endpoints')
      .set('Authorization', `Bearer ${apiKey}`)
      .send({ url: `http://127.0.0.1:${receiverPort}${path}` })
      .expect(201);
    await request(ctx.app.getHttpServer())
      .put(`/endpoints/${epRes.body.id}/subscriptions`)
      .set('Authorization', `Bearer ${apiKey}`)
      .send({ eventTypes: ['order.created'] })
      .expect(200);
    return { apiKey, endpointId: epRes.body.id, secret: epRes.body.secret };
  }

  async function publish(apiKey: string): Promise<{ eventId: string; deliveryId: string }> {
    const res = await request(ctx.app.getHttpServer())
      .post('/events')
      .set('Authorization', `Bearer ${apiKey}`)
      .set('Idempotency-Key', randomUUID())
      .send({ type: 'order.created', payload: { orderId: 'ord-1', amount: 12000 } })
      .expect(202);
    return { eventId: res.body.eventId, deliveryId: res.body.deliveries[0].deliveryId };
  }

  it('성공 배달 — 서명·헤더 계약을 지키고 SUCCEEDED + 시도 1행을 남긴다', async () => {
    const { apiKey, secret } = await seed('/ok');
    const { eventId, deliveryId } = await publish(apiKey);

    expect(await processor.process(deliveryId)).toBe('SUCCEEDED');

    // 수신자가 받은 것: 계약 헤더 + 유효한 서명
    expect(received).toHaveLength(1);
    const r = received[0];
    expect(r.headers['x-hookrelay-event']).toBe('order.created');
    expect(r.headers['x-delivery-id']).toBe(deliveryId);
    const ts = r.headers['x-hookrelay-timestamp'] as string;
    const expectedSig = `v1=${createHmac('sha256', secret).update(`${ts}.${r.rawBody}`).digest('hex')}`;
    expect(r.headers['x-hookrelay-signature']).toBe(expectedSig);
    // 본문에는 이벤트 사실이 담긴다
    const parsed = JSON.parse(r.rawBody);
    expect(parsed.eventId).toBe(eventId);
    expect(parsed.payload).toEqual({ orderId: 'ord-1', amount: 12000 });

    // DB 상태: SUCCEEDED + 완결된 시도 1행
    const delivery = await ctx.prisma.delivery.findUnique({ where: { id: deliveryId } });
    expect(delivery!.status).toBe('SUCCEEDED');
    expect(delivery!.attemptCount).toBe(1);
    const attempts = await ctx.prisma.deliveryAttempt.findMany({ where: { deliveryId } });
    expect(attempts).toHaveLength(1);
    expect(attempts[0].responseStatus).toBe(200);
    expect(attempts[0].errorClass).toBeNull();
    expect(attempts[0].requestHeadersDigest).toMatch(/^[0-9a-f]{64}$/);
  });

  it('멱등 가드 — 이미 SUCCEEDED인 배달의 중복 잡은 재전송 없이 스킵된다', async () => {
    const { apiKey } = await seed('/ok');
    const { deliveryId } = await publish(apiKey);

    expect(await processor.process(deliveryId)).toBe('SUCCEEDED');
    expect(await processor.process(deliveryId)).toBe('SKIPPED_ALREADY_DONE');

    expect(received).toHaveLength(1);
    expect(await ctx.prisma.deliveryAttempt.count({ where: { deliveryId } })).toBe(1);
  });

  it('동시 중복 소비 — UNIQUE claim이 한쪽의 시도 자체를 차단한다', async () => {
    const { apiKey } = await seed('/ok');
    const { deliveryId } = await publish(apiKey);

    const results = await Promise.all([
      processor.process(deliveryId),
      processor.process(deliveryId),
    ]);

    expect(results).toContain('SUCCEEDED');
    expect(results.filter((r) => r === 'SUCCEEDED')).toHaveLength(1);
    expect(received).toHaveLength(1);
    expect(await ctx.prisma.deliveryAttempt.count({ where: { deliveryId } })).toBe(1);
  });

  it('수신자 500 — FAILED_RETRYING + HTTP_5XX 분류, 응답 본문 머리를 증거로 남긴다', async () => {
    const { apiKey } = await seed('/fail-500');
    const { deliveryId } = await publish(apiKey);

    expect(await processor.process(deliveryId)).toBe('FAILED');

    const delivery = await ctx.prisma.delivery.findUnique({ where: { id: deliveryId } });
    expect(delivery!.status).toBe('FAILED_RETRYING');
    const attempt = await ctx.prisma.deliveryAttempt.findFirst({ where: { deliveryId } });
    expect(attempt!.errorClass).toBe('HTTP_5XX');
    expect(attempt!.responseStatus).toBe(500);
    expect(attempt!.responseBodyHead).toContain('receiver exploded');
  });

  it('응답 지연 — 타임아웃(1s) 초과는 TIMEOUT으로 분류된다', async () => {
    const { apiKey } = await seed('/slow');
    const { deliveryId } = await publish(apiKey);

    expect(await processor.process(deliveryId)).toBe('FAILED');

    const attempt = await ctx.prisma.deliveryAttempt.findFirst({ where: { deliveryId } });
    expect(attempt!.errorClass).toBe('TIMEOUT');
    expect(attempt!.responseStatus).toBeNull();
  });

  it('연결 거부 — 닫힌 포트는 CONN_REFUSED로 분류된다', async () => {
    // 임시 서버로 포트를 얻고 닫아 "확실히 닫힌 포트"를 만든다
    const tmp = http.createServer();
    await new Promise<void>((resolve) => tmp.listen(0, '127.0.0.1', resolve));
    const closedPort = (tmp.address() as AddressInfo).port;
    await new Promise<void>((resolve, reject) => tmp.close((e) => (e ? reject(e) : resolve())));

    const name = `wk-${randomUUID().slice(0, 8)}`;
    const tenantRes = await request(ctx.app.getHttpServer())
      .post('/tenants')
      .set('X-Admin-Key', TEST_ADMIN_KEY)
      .send({ name })
      .expect(201);
    const apiKey: string = tenantRes.body.apiKey;
    const epRes = await request(ctx.app.getHttpServer())
      .post('/endpoints')
      .set('Authorization', `Bearer ${apiKey}`)
      .send({ url: `http://127.0.0.1:${closedPort}/hooks` })
      .expect(201);
    await request(ctx.app.getHttpServer())
      .put(`/endpoints/${epRes.body.id}/subscriptions`)
      .set('Authorization', `Bearer ${apiKey}`)
      .send({ eventTypes: ['order.created'] })
      .expect(200);
    const { deliveryId } = await publish(apiKey);

    expect(await processor.process(deliveryId)).toBe('FAILED');
    const attempt = await ctx.prisma.deliveryAttempt.findFirst({ where: { deliveryId } });
    expect(attempt!.errorClass).toBe('CONN_REFUSED');
  });

  it('배달 시 SSRF 재검증 — 사설 IP로 풀리는 호스트는 연결 단계에서 차단된다 (DNS rebinding 방어)', async () => {
    // allowPrivate=false 클라이언트를 직접 구성 — 등록 검증을 통과한 뒤 DNS가
    // 내부 IP로 바뀌는 rebinding 상황을 "127.0.0.1로 풀리는 URL"로 재현한다
    const { DeliveryHttpClient } = await import('../src/worker/delivery-http.client');
    const client = new DeliveryHttpClient(
      new ConfigService({ HR_ALLOW_PRIVATE_DESTINATIONS: false }),
    );

    // 경로 1: IP 리터럴 — DNS 조회가 없어 lookup 훅을 타지 않으므로 사전 검사가 막는다
    const ipLiteral = await client.send(
      `http://127.0.0.1:${receiverPort}/ok`,
      { 'content-type': 'application/json' },
      '{}',
      1000,
    );
    expect(ipLiteral.ok).toBe(false);
    if (!ipLiteral.ok) expect(ipLiteral.errorClass).toBe('SSRF_BLOCKED');

    // 경로 2: 호스트명이 사설 IP로 해석 — 연결 단계 lookup 훅이 막는다 (rebinding 재현)
    const rebound = await client.send(
      `http://localhost:${receiverPort}/ok`,
      { 'content-type': 'application/json' },
      '{}',
      1000,
    );
    expect(rebound.ok).toBe(false);
    if (!rebound.ok) expect(rebound.errorClass).toBe('SSRF_BLOCKED');

    // 어느 경로도 수신자에 도달하지 않았다 — 검사와 연결이 같은 단계이므로 우회 불가
    expect(received).toHaveLength(0);
    await client.onApplicationShutdown();
  });

  it('비활성 endpoint — 시도 자체를 만들지 않고 배달은 PENDING으로 남는다', async () => {
    const { apiKey, endpointId } = await seed('/ok');
    const { deliveryId } = await publish(apiKey);

    await request(ctx.app.getHttpServer())
      .patch(`/endpoints/${endpointId}`)
      .set('Authorization', `Bearer ${apiKey}`)
      .send({ status: 'DISABLED_MANUAL' })
      .expect(200);
    endpointCache.invalidate(endpointId);

    expect(await processor.process(deliveryId)).toBe('SKIPPED_ENDPOINT_INACTIVE');
    expect(received).toHaveLength(0);
    expect(await ctx.prisma.deliveryAttempt.count({ where: { deliveryId } })).toBe(0);
    expect(
      (await ctx.prisma.delivery.findUnique({ where: { id: deliveryId } }))!.status,
    ).toBe('PENDING');
  });

  it('풀 파이프라인 — 발행 → relay 적재 → 워커 소비 → 수신자 도달까지 자동으로 흐른다', async () => {
    const { WorkerService } = await import('../src/worker/worker.service');
    const workerService = workerCtx.get(WorkerService);
    workerService.start();

    try {
      // 앞선 테스트들이 남긴 PENDING outbox를 정리해 이 테스트의 틱을 결정적으로 만든다
      await ctx.prisma.outboxMessage.updateMany({
        where: { status: 'PENDING' },
        data: { status: 'PUBLISHED', publishedAt: new Date() },
      });

      const { apiKey } = await seed('/ok');
      const { deliveryId } = await publish(apiKey);

      expect(await relay.tick()).toBe(1);

      await waitFor(async () => {
        const d = await ctx.prisma.delivery.findUnique({ where: { id: deliveryId } });
        return d?.status === 'SUCCEEDED';
      }, 15_000);

      expect(received.some((r) => r.headers['x-delivery-id'] === deliveryId)).toBe(true);
    } finally {
      await workerService.onApplicationShutdown();
    }
  }, 30_000);
});

async function waitFor(cond: () => Promise<boolean>, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`조건이 ${timeoutMs}ms 안에 충족되지 않았습니다`);
}
