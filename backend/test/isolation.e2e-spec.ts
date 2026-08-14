import { INestApplicationContext } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { RedisContainer, StartedRedisContainer } from '@testcontainers/redis';
import { randomUUID } from 'crypto';
import * as http from 'http';
import { AddressInfo } from 'net';
import request from 'supertest';
import type { DeliveryProcessor } from '../src/worker/delivery.processor';
import type { EndpointCache } from '../src/worker/endpoint-cache';
import type { TenantLimiter } from '../src/worker/tenant-limiter';
import { createTestApp, TEST_ADMIN_KEY, TestContext } from './helpers/test-app';

/**
 * 서킷 + 테넌트 세마포어.
 * WorkerModule은 파일당 한 번만 띄운다 — ConfigModule이 REDIS_URL을 캐시하므로
 * describe마다 컨테이너를 갈면 두 번째 스위트가 죽은 Redis에 붙는다.
 */
describe('Circuit + tenant isolation', () => {
  let ctx: TestContext;
  let redis: StartedRedisContainer;
  let workerCtx: INestApplicationContext;
  let processor: DeliveryProcessor;
  let cache: EndpointCache;
  let limiter: TenantLimiter;
  let receiver: http.Server;
  let hits = 0;

  beforeAll(async () => {
    receiver = http.createServer((_req, res) => {
      if (_req.headers['user-agent'] === 'HookRelay/1.0') hits += 1;
      res.writeHead(500);
      res.end('down');
    });
    await new Promise<void>((resolve) => receiver.listen(0, '127.0.0.1', resolve));
    const port = (receiver.address() as AddressInfo).port;

    redis = await new RedisContainer('redis:7-alpine').start();
    process.env.REDIS_URL = redis.getConnectionUrl();
    ctx = await createTestApp({
      HR_ALLOW_INSECURE_HTTP: 'true',
      HR_ALLOW_PRIVATE_DESTINATIONS: 'true',
      HR_MAX_ATTEMPTS: '20',
      HR_CIRCUIT_OPEN_AFTER: '3',
      HR_CIRCUIT_COOLDOWN_MS: '400',
      HR_CIRCUIT_DISABLE_AFTER: '4',
      HR_TENANT_CONCURRENCY: '1',
    });

    const { WorkerModule } = await import('../src/worker/worker.module');
    const { DeliveryProcessor } = await import('../src/worker/delivery.processor');
    const { EndpointCache } = await import('../src/worker/endpoint-cache');
    const { TenantLimiter } = await import('../src/worker/tenant-limiter');
    workerCtx = await Test.createTestingModule({ imports: [WorkerModule] }).compile();
    await workerCtx.init();
    processor = workerCtx.get(DeliveryProcessor);
    cache = workerCtx.get(EndpointCache);
    limiter = workerCtx.get(TenantLimiter);

    (global as unknown as { __port: number }).__port = port;
  }, 240_000);

  afterAll(async () => {
    await workerCtx.close();
    await ctx.stop();
    await redis.stop();
    await new Promise<void>((resolve, reject) =>
      receiver.close((e) => (e ? reject(e) : resolve())),
    );
  });

  async function seed(): Promise<{ apiKey: string; deliveryId: string; endpointId: string }> {
    const port = (global as unknown as { __port: number }).__port;
    const name = `cb-${randomUUID().slice(0, 8)}`;
    const tenantRes = await request(ctx.app.getHttpServer())
      .post('/tenants')
      .set('X-Admin-Key', TEST_ADMIN_KEY)
      .send({ name })
      .expect(201);
    const apiKey: string = tenantRes.body.apiKey;
    const epRes = await request(ctx.app.getHttpServer())
      .post('/endpoints')
      .set('Authorization', `Bearer ${apiKey}`)
      .send({ url: `http://127.0.0.1:${port}/hooks` })
      .expect(201);
    await request(ctx.app.getHttpServer())
      .put(`/endpoints/${epRes.body.id}/subscriptions`)
      .set('Authorization', `Bearer ${apiKey}`)
      .send({ eventTypes: ['order.created'] })
      .expect(200);
    const pub = await request(ctx.app.getHttpServer())
      .post('/events')
      .set('Authorization', `Bearer ${apiKey}`)
      .set('Idempotency-Key', randomUUID())
      .send({ type: 'order.created', payload: {} })
      .expect(202);
    return { apiKey, deliveryId: pub.body.deliveries[0].deliveryId, endpointId: epRes.body.id };
  }

  it('연속 실패 3회 후 OPEN — 네 번째는 HTTP 없이 CIRCUIT_OPEN', async () => {
    hits = 0;
    const { deliveryId } = await seed();
    expect(await processor.process(deliveryId)).toBe('FAILED');
    expect(await processor.process(deliveryId)).toBe('FAILED');
    expect(await processor.process(deliveryId)).toBe('FAILED');
    expect(hits).toBe(3);

    expect(await processor.process(deliveryId)).toBe('FAILED');
    expect(hits).toBe(3);
    const attempt = await ctx.prisma.deliveryAttempt.findFirst({
      where: { deliveryId },
      orderBy: { attemptNo: 'desc' },
    });
    expect(attempt!.errorClass).toBe('CIRCUIT_OPEN');
  });

  it('쿨다운 후 HALF_OPEN 프로브 1건을 보내고, disableAfter면 DISABLED_AUTO', async () => {
    hits = 0;
    const { deliveryId, endpointId } = await seed();
    await processor.process(deliveryId);
    await processor.process(deliveryId);
    await processor.process(deliveryId);
    await processor.process(deliveryId);
    expect(hits).toBe(3);

    await new Promise((r) => setTimeout(r, 450));
    expect(await processor.process(deliveryId)).toBe('FAILED');
    expect(hits).toBe(4);

    cache.invalidate(endpointId);
    const endpoint = await ctx.prisma.endpoint.findUnique({ where: { id: endpointId } });
    expect(endpoint!.status).toBe('DISABLED_AUTO');
    expect(endpoint!.consecutiveFailures).toBe(4);

    expect(await processor.process(deliveryId)).toBe('SKIPPED_ENDPOINT_INACTIVE');
    expect(hits).toBe(4);
  });

  it('테넌트 세마포어 — 같은 테넌트는 1슬롯, 다른 테넌트는 막히지 않는다', async () => {
    const a = randomUUID();
    const b = randomUUID();
    expect(await limiter.acquire(a)).toBe(true);
    expect(await limiter.acquire(a)).toBe(false);
    expect(await limiter.acquire(b)).toBe(true);
    await limiter.release(a);
    expect(await limiter.acquire(a)).toBe(true);
    await limiter.release(a);
    await limiter.release(b);
  });
});
