import request from 'supertest';
import { randomUUID } from 'crypto';
import { createTestApp, TEST_ADMIN_KEY, TestContext } from './helpers/test-app';

/**
 * POST /events 발행 계약 — Transactional Outbox의 쓰기 절반.
 * Redis 없이 검증한다: API는 큐를 만지지 않고 outbox까지만 쓰는 것이 설계이므로,
 * 이 스펙이 Redis를 요구하지 않는다는 사실 자체가 설계의 증명이다.
 */
describe('Events publish (outbox 쓰기 절반)', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await createTestApp();
  }, 180_000);

  afterAll(async () => {
    await ctx.stop();
  });

  async function seedTenant(name: string): Promise<{ tenantId: string; apiKey: string }> {
    const res = await request(ctx.app.getHttpServer())
      .post('/tenants')
      .set('X-Admin-Key', TEST_ADMIN_KEY)
      .send({ name })
      .expect(201);
    return { tenantId: res.body.tenantId, apiKey: res.body.apiKey };
  }

  async function seedEndpoint(
    apiKey: string,
    url: string,
    eventTypes: string[],
  ): Promise<string> {
    const res = await request(ctx.app.getHttpServer())
      .post('/endpoints')
      .set('Authorization', `Bearer ${apiKey}`)
      .send({ url })
      .expect(201);
    await request(ctx.app.getHttpServer())
      .put(`/endpoints/${res.body.id}/subscriptions`)
      .set('Authorization', `Bearer ${apiKey}`)
      .send({ eventTypes })
      .expect(200);
    return res.body.id;
  }

  function publish(apiKey: string, body: object, idemKey: string = randomUUID()) {
    return request(ctx.app.getHttpServer())
      .post('/events')
      .set('Authorization', `Bearer ${apiKey}`)
      .set('Idempotency-Key', idemKey)
      .send(body);
  }

  describe('발행과 팬아웃', () => {
    it('202 — 구독 중인 ACTIVE endpoint 수만큼 deliveries가 만들어지고, 같은 트랜잭션으로 outbox 행이 남는다', async () => {
      const { apiKey } = await seedTenant('pub-fanout');
      const ep1 = await seedEndpoint(apiKey, 'https://example.com/hooks-1', ['order.created']);
      const ep2 = await seedEndpoint(apiKey, 'https://example.com/hooks-2', [
        'order.created',
        'order.cancelled',
      ]);
      // 다른 타입만 구독 — 팬아웃 대상이 아니어야 한다
      await seedEndpoint(apiKey, 'https://example.com/hooks-3', ['payment.captured']);

      const res = await publish(apiKey, {
        type: 'order.created',
        payload: { orderId: 'ord-1', amount: 12000 },
      }).expect(202);

      expect(res.body.eventId).toBeDefined();
      const endpointIds = res.body.deliveries.map((d: { endpointId: string }) => d.endpointId);
      expect(endpointIds.sort()).toEqual([ep1, ep2].sort());

      // DB 검증: events·deliveries·outbox가 원자적으로 함께 기록됐다
      const outbox = await ctx.prisma.outboxMessage.findMany({
        where: { eventId: res.body.eventId },
      });
      expect(outbox).toHaveLength(1);
      expect(outbox[0].status).toBe('PENDING');
      const deliveries = await ctx.prisma.delivery.findMany({
        where: { eventId: res.body.eventId },
      });
      expect(deliveries).toHaveLength(2);
      expect(deliveries.every((d) => d.status === 'PENDING')).toBe(true);
    });

    it('DISABLED endpoint는 팬아웃에서 제외된다', async () => {
      const { apiKey } = await seedTenant('pub-disabled');
      const epId = await seedEndpoint(apiKey, 'https://example.com/hooks', ['order.created']);
      await request(ctx.app.getHttpServer())
        .patch(`/endpoints/${epId}`)
        .set('Authorization', `Bearer ${apiKey}`)
        .send({ status: 'DISABLED_MANUAL' })
        .expect(200);

      const res = await publish(apiKey, { type: 'order.created', payload: {} }).expect(202);
      expect(res.body.deliveries).toEqual([]);
    });

    it('구독자가 없으면 deliveries는 비고 outbox 행도 만들지 않는다', async () => {
      const { apiKey } = await seedTenant('pub-nosub');

      const res = await publish(apiKey, { type: 'order.created', payload: {} }).expect(202);

      expect(res.body.deliveries).toEqual([]);
      const outbox = await ctx.prisma.outboxMessage.findMany({
        where: { eventId: res.body.eventId },
      });
      expect(outbox).toHaveLength(0);
    });
  });

  describe('발행 멱등성', () => {
    it('같은 Idempotency-Key 재발행은 409 DUPLICATE_EVENT + 기존 eventId를 돌려준다', async () => {
      const { apiKey } = await seedTenant('pub-idem');
      await seedEndpoint(apiKey, 'https://example.com/hooks', ['order.created']);

      const idemKey = 'client-retry-001';
      const first = await publish(apiKey, { type: 'order.created', payload: { n: 1 } }, idemKey)
        .expect(202);
      const second = await publish(apiKey, { type: 'order.created', payload: { n: 1 } }, idemKey)
        .expect(409);

      expect(second.body.code).toBe('DUPLICATE_EVENT');
      expect(second.body.details.eventId).toBe(first.body.eventId);

      // 이벤트도 배달도 한 번만 만들어졌다
      const events = await ctx.prisma.event.count({ where: { id: first.body.eventId } });
      expect(events).toBe(1);
    });

    it('다른 테넌트는 같은 Idempotency-Key를 써도 서로 충돌하지 않는다', async () => {
      const a = await seedTenant('pub-idem-a');
      const b = await seedTenant('pub-idem-b');
      const idemKey = 'shared-key';

      await publish(a.apiKey, { type: 'order.created', payload: {} }, idemKey).expect(202);
      await publish(b.apiKey, { type: 'order.created', payload: {} }, idemKey).expect(202);
    });

    it('Idempotency-Key 헤더가 없으면 400', async () => {
      const { apiKey } = await seedTenant('pub-nokey');
      const res = await request(ctx.app.getHttpServer())
        .post('/events')
        .set('Authorization', `Bearer ${apiKey}`)
        .send({ type: 'order.created', payload: {} })
        .expect(400);
      expect(res.body.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
    });
  });

  describe('입력 검증', () => {
    it('payload가 64KB를 넘으면 413', async () => {
      const { apiKey } = await seedTenant('pub-large');
      const res = await publish(apiKey, {
        type: 'order.created',
        payload: { blob: 'x'.repeat(64 * 1024 + 1) },
      }).expect(413);
      expect(res.body.code).toBe('PAYLOAD_TOO_LARGE');
    });

    it('점 표기가 아닌 이벤트 타입은 400', async () => {
      const { apiKey } = await seedTenant('pub-badtype');
      await publish(apiKey, { type: 'OrderCreated!', payload: {} }).expect(400);
    });
  });

  describe('GET /events/:id/deliveries', () => {
    it('발행한 이벤트의 배달 현황을 조회한다', async () => {
      const { apiKey } = await seedTenant('pub-query');
      await seedEndpoint(apiKey, 'https://example.com/hooks', ['order.created']);
      const pub = await publish(apiKey, { type: 'order.created', payload: {} }).expect(202);

      const res = await request(ctx.app.getHttpServer())
        .get(`/events/${pub.body.eventId}/deliveries`)
        .set('Authorization', `Bearer ${apiKey}`)
        .expect(200);

      expect(res.body.eventId).toBe(pub.body.eventId);
      expect(res.body.deliveries).toHaveLength(1);
      expect(res.body.deliveries[0].status).toBe('PENDING');
      expect(res.body.deliveries[0].endpointUrl).toBe('https://example.com/hooks');
    });

    it('다른 테넌트의 이벤트는 404 — 존재 여부조차 숨긴다', async () => {
      const a = await seedTenant('pub-iso-a');
      const b = await seedTenant('pub-iso-b');
      const pub = await publish(a.apiKey, { type: 'order.created', payload: {} }).expect(202);

      await request(ctx.app.getHttpServer())
        .get(`/events/${pub.body.eventId}/deliveries`)
        .set('Authorization', `Bearer ${b.apiKey}`)
        .expect(404);
    });
  });
});
