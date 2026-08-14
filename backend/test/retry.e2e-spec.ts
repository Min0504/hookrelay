import { INestApplicationContext } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { RedisContainer, StartedRedisContainer } from '@testcontainers/redis';
import { randomUUID } from 'crypto';
import * as http from 'http';
import { AddressInfo } from 'net';
import request from 'supertest';
import type { DeliveryProcessor } from '../src/worker/delivery.processor';
import type { RelayService } from '../src/relay/relay.service';
import { createTestApp, TEST_ADMIN_KEY, TestContext } from './helpers/test-app';

/**
 * 재시도·DLQ·수동 재배달.
 * 프로세서는 시도 한 번의 결과만 기록하고, 8회(테스트에선 3회) 후 DEAD가 된다.
 * 재배달은 큐를 직접 만지지 않고 outbox에 "이 배달만" 행을 넣어 Redis 장애에도 예약이 남는다.
 */
describe('Retry / DLQ / redeliver', () => {
  let ctx: TestContext;
  let redis: StartedRedisContainer;
  let workerCtx: INestApplicationContext;
  let relayCtx: INestApplicationContext;
  let processor: DeliveryProcessor;
  let relay: RelayService;
  let receiver: http.Server;
  let receiverPort: number;
  const received: string[] = [];

  beforeAll(async () => {
    receiver = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        received.push(req.url ?? '');
        if (req.url === '/fail') {
          res.writeHead(500);
          res.end('down');
        } else {
          res.writeHead(200);
          res.end('ok');
        }
      });
    });
    await new Promise<void>((resolve) => receiver.listen(0, '127.0.0.1', resolve));
    receiverPort = (receiver.address() as AddressInfo).port;

    redis = await new RedisContainer('redis:7-alpine').start();
    process.env.REDIS_URL = redis.getConnectionUrl();
    ctx = await createTestApp({
      HR_ALLOW_INSECURE_HTTP: 'true',
      HR_ALLOW_PRIVATE_DESTINATIONS: 'true',
      HR_MAX_ATTEMPTS: '3',
      HR_RETRY_BASE_MS: '0',
    });

    const { WorkerModule } = await import('../src/worker/worker.module');
    const { DeliveryProcessor } = await import('../src/worker/delivery.processor');
    workerCtx = await Test.createTestingModule({ imports: [WorkerModule] }).compile();
    await workerCtx.init();
    processor = workerCtx.get(DeliveryProcessor);

    const { RelayModule } = await import('../src/relay/relay.module');
    const { RelayService } = await import('../src/relay/relay.service');
    relayCtx = await Test.createTestingModule({ imports: [RelayModule] }).compile();
    await relayCtx.init();
    relay = relayCtx.get(RelayService);
  }, 240_000);

  afterAll(async () => {
    await relayCtx.close();
    await workerCtx.close();
    await ctx.stop();
    await redis.stop();
    await new Promise<void>((resolve, reject) =>
      receiver.close((e) => (e ? reject(e) : resolve())),
    );
  });

  beforeEach(() => {
    received.length = 0;
  });

  async function seed(path: string): Promise<{ apiKey: string; endpointId: string }> {
    const name = `rt-${randomUUID().slice(0, 8)}`;
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
    return { apiKey, endpointId: epRes.body.id };
  }

  async function publish(apiKey: string): Promise<string> {
    const res = await request(ctx.app.getHttpServer())
      .post('/events')
      .set('Authorization', `Bearer ${apiKey}`)
      .set('Idempotency-Key', randomUUID())
      .send({ type: 'order.created', payload: { n: 1 } })
      .expect(202);
    return res.body.deliveries[0].deliveryId;
  }

  it('3회 실패 후 DEAD — 네 번째 잡은 시도 없이 스킵되고 DLQ 목록에 나타난다', async () => {
    const { apiKey } = await seed('/fail');
    const deliveryId = await publish(apiKey);

    expect(await processor.process(deliveryId)).toBe('FAILED');
    expect(await processor.process(deliveryId)).toBe('FAILED');
    expect(await processor.process(deliveryId)).toBe('DEAD');
    expect(await processor.process(deliveryId)).toBe('SKIPPED_ALREADY_DONE');
    expect(received.filter((p) => p === '/fail')).toHaveLength(3);

    const dlq = await request(ctx.app.getHttpServer())
      .get('/deliveries?status=DEAD')
      .set('Authorization', `Bearer ${apiKey}`)
      .expect(200);
    expect(dlq.body.deliveries.map((d: { deliveryId: string }) => d.deliveryId)).toContain(deliveryId);

    const attempts = await request(ctx.app.getHttpServer())
      .get(`/deliveries/${deliveryId}/attempts`)
      .set('Authorization', `Bearer ${apiKey}`)
      .expect(200);
    expect(attempts.body.status).toBe('DEAD');
    expect(attempts.body.attempts).toHaveLength(3);
    expect(attempts.body.attempts.every((a: { errorClass: string }) => a.errorClass === 'HTTP_5XX')).toBe(
      true,
    );
  });

  it('SUCCEEDED 재배달 — 같은 X-Delivery-Id로 다시 보내 수신자 디버깅을 가능하게 한다', async () => {
    const { apiKey } = await seed('/ok');
    const deliveryId = await publish(apiKey);
    expect(await processor.process(deliveryId)).toBe('SUCCEEDED');

    const re = await request(ctx.app.getHttpServer())
      .post(`/deliveries/${deliveryId}/redeliver`)
      .set('Authorization', `Bearer ${apiKey}`)
      .expect(201);
    expect(re.body.status).toBe('PENDING');

    const outbox = await ctx.prisma.outboxMessage.findFirst({
      where: { deliveryId, status: 'PENDING' },
    });
    expect(outbox).not.toBeNull();

    expect(await relay.tick()).toBeGreaterThanOrEqual(1);
    expect(await processor.process(deliveryId)).toBe('SUCCEEDED');
    expect(received.filter((p) => p === '/ok')).toHaveLength(2);

    const attempts = await request(ctx.app.getHttpServer())
      .get(`/deliveries/${deliveryId}/attempts`)
      .set('Authorization', `Bearer ${apiKey}`)
      .expect(200);
    expect(attempts.body.attempts).toHaveLength(2);
  });

  it('DEAD 재배달도 PENDING으로 되돌리고 outbox에만 예약한다 — 큐를 직접 만지지 않는다', async () => {
    const { apiKey } = await seed('/fail');
    const deliveryId = await publish(apiKey);
    await processor.process(deliveryId);
    await processor.process(deliveryId);
    await processor.process(deliveryId);

    await request(ctx.app.getHttpServer())
      .post(`/deliveries/${deliveryId}/redeliver`)
      .set('Authorization', `Bearer ${apiKey}`)
      .expect(201);

    const delivery = await ctx.prisma.delivery.findUnique({ where: { id: deliveryId } });
    expect(delivery!.status).toBe('PENDING');
    const pending = await ctx.prisma.outboxMessage.count({
      where: { deliveryId, status: 'PENDING' },
    });
    expect(pending).toBe(1);
  });

  it('ping은 구독과 무관하게 해당 endpoint 한 곳으로만 테스트 이벤트를 예약한다', async () => {
    const { apiKey, endpointId } = await seed('/ok');
    const ping = await request(ctx.app.getHttpServer())
      .post(`/endpoints/${endpointId}/ping`)
      .set('Authorization', `Bearer ${apiKey}`)
      .expect(201);

    expect(ping.body.endpointId).toBe(endpointId);
    const event = await ctx.prisma.event.findUnique({ where: { id: ping.body.eventId } });
    expect(event!.type).toBe('endpoint.ping');
    const deliveries = await ctx.prisma.delivery.findMany({ where: { eventId: ping.body.eventId } });
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0].endpointId).toBe(endpointId);
  });

  it('다른 테넌트의 배달은 404 — 존재 여부조차 숨긴다', async () => {
    const a = await seed('/ok');
    const b = await seed('/ok');
    const deliveryId = await publish(a.apiKey);

    await request(ctx.app.getHttpServer())
      .get(`/deliveries/${deliveryId}/attempts`)
      .set('Authorization', `Bearer ${b.apiKey}`)
      .expect(404);
    await request(ctx.app.getHttpServer())
      .post(`/deliveries/${deliveryId}/redeliver`)
      .set('Authorization', `Bearer ${b.apiKey}`)
      .expect(404);
  });
});
