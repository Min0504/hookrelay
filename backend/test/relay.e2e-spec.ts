import { INestApplicationContext } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { RedisContainer, StartedRedisContainer } from '@testcontainers/redis';
import { Queue } from 'bullmq';
import { randomUUID } from 'crypto';
import request from 'supertest';
import type { RelayService } from '../src/relay/relay.service';
import { DELIVERY_QUEUE } from '../src/queue/queue.constants';
import { redisConnectionFromUrl } from '../src/queue/redis-connection';
import { createTestApp, TEST_ADMIN_KEY, TestContext } from './helpers/test-app';

/**
 * Outbox Relay 정확성 — at-least-once의 실체를 검증한다.
 * 실제 PostgreSQL(발행 API 경유) + 실제 Redis(BullMQ) 위에서:
 *   유실 불가능(적재 실패 시 PENDING 유지), 중복 흡수(jobId 고정),
 *   크래시 시뮬레이션(적재 후 마킹 전 죽음 → 재적재돼도 잡은 하나).
 */
describe('Outbox Relay', () => {
  let ctx: TestContext;
  let redis: StartedRedisContainer;
  let relayCtx: INestApplicationContext;
  let relay: RelayService;
  let queue: Queue;

  beforeAll(async () => {
    redis = await new RedisContainer('redis:7-alpine').start();
    process.env.REDIS_URL = redis.getConnectionUrl();
    ctx = await createTestApp();

    // RelayModule도 env 세팅 이후 동적 import — ConfigModule이 import 시점에 validate를 실행하므로
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
    await ctx.stop();
    await redis.stop();
  });

  beforeEach(async () => {
    await queue.obliterate({ force: true });
  });

  async function seedTenantWithEndpoints(
    endpointCount: number,
  ): Promise<{ apiKey: string; endpointIds: string[] }> {
    const name = `relay-${randomUUID().slice(0, 8)}`;
    const tenantRes = await request(ctx.app.getHttpServer())
      .post('/tenants')
      .set('X-Admin-Key', TEST_ADMIN_KEY)
      .send({ name })
      .expect(201);
    const apiKey: string = tenantRes.body.apiKey;

    const endpointIds: string[] = [];
    for (let i = 0; i < endpointCount; i += 1) {
      const epRes = await request(ctx.app.getHttpServer())
        .post('/endpoints')
        .set('Authorization', `Bearer ${apiKey}`)
        .send({ url: `https://example.com/${name}/hooks-${i}` })
        .expect(201);
      await request(ctx.app.getHttpServer())
        .put(`/endpoints/${epRes.body.id}/subscriptions`)
        .set('Authorization', `Bearer ${apiKey}`)
        .send({ eventTypes: ['order.created'] })
        .expect(200);
      endpointIds.push(epRes.body.id);
    }
    return { apiKey, endpointIds };
  }

  async function publishEvent(apiKey: string): Promise<{ eventId: string; deliveryIds: string[] }> {
    const res = await request(ctx.app.getHttpServer())
      .post('/events')
      .set('Authorization', `Bearer ${apiKey}`)
      .set('Idempotency-Key', randomUUID())
      .send({ type: 'order.created', payload: { at: Date.now() } })
      .expect(202);
    return {
      eventId: res.body.eventId,
      deliveryIds: res.body.deliveries.map((d: { deliveryId: string }) => d.deliveryId),
    };
  }

  it('PENDING outbox를 적재하고 PUBLISHED로 마킹한다 — 배달당 잡 1개', async () => {
    const { apiKey } = await seedTenantWithEndpoints(2);
    const { eventId, deliveryIds } = await publishEvent(apiKey);

    const published = await relay.tick();
    expect(published).toBe(1);

    // 잡: 배달 수만큼, jobId는 deliveryId 기반
    const waiting = await queue.getJobs(['waiting']);
    expect(waiting).toHaveLength(2);
    const jobDeliveryIds = waiting.map((j) => (j.data as { deliveryId: string }).deliveryId);
    expect(jobDeliveryIds.sort()).toEqual([...deliveryIds].sort());

    // outbox: PUBLISHED + published_at 기록
    const outbox = await ctx.prisma.outboxMessage.findFirst({ where: { eventId } });
    expect(outbox!.status).toBe('PUBLISHED');
    expect(outbox!.publishedAt).not.toBeNull();

    // 두 번째 틱은 할 일이 없다
    expect(await relay.tick()).toBe(0);
  });

  it('크래시 시뮬레이션: 적재 후 마킹 전에 죽어도 재적재는 jobId 중복 제거로 흡수된다 — 유실도 중복도 없음', async () => {
    const { apiKey } = await seedTenantWithEndpoints(1);
    const { eventId } = await publishEvent(apiKey);

    await relay.tick();
    // "적재 성공 → 마킹 전 크래시"를 재현: 마킹을 강제로 되돌린다
    await ctx.prisma.outboxMessage.updateMany({
      where: { eventId },
      data: { status: 'PENDING', publishedAt: null },
    });

    // 재기동한 relay의 첫 틱 — 같은 행을 다시 적재하지만 jobId가 같아 잡은 늘지 않는다
    const published = await relay.tick();
    expect(published).toBe(1);
    expect(await queue.getJobs(['waiting'])).toHaveLength(1);

    const outbox = await ctx.prisma.outboxMessage.findFirst({ where: { eventId } });
    expect(outbox!.status).toBe('PUBLISHED');
  });

  it('적재 실패(Redis 장애) 시 outbox는 PENDING으로 남아 다음 틱에 재시도된다 — 유실 불가능', async () => {
    const { apiKey } = await seedTenantWithEndpoints(1);
    const { eventId } = await publishEvent(apiKey);

    const addBulkSpy = jest
      .spyOn(queueOf(relay), 'addBulk')
      .mockRejectedValueOnce(new Error('ECONNREFUSED (simulated redis down)'));

    // 장애 중 틱: 아무것도 적재·마킹되지 않는다
    expect(await relay.tick()).toBe(0);
    let outbox = await ctx.prisma.outboxMessage.findFirst({ where: { eventId } });
    expect(outbox!.status).toBe('PENDING');
    expect(await queue.getJobs(['waiting'])).toHaveLength(0);

    // 복구 후 틱: 그대로 이어서 적재된다
    expect(await relay.tick()).toBe(1);
    outbox = await ctx.prisma.outboxMessage.findFirst({ where: { eventId } });
    expect(outbox!.status).toBe('PUBLISHED');
    expect(await queue.getJobs(['waiting'])).toHaveLength(1);

    addBulkSpy.mockRestore();
  });

  it('부분 실패: 앞 행의 적재 성공은 뒤 행의 실패에 휩쓸리지 않고 마킹된다', async () => {
    const { apiKey } = await seedTenantWithEndpoints(1);
    const first = await publishEvent(apiKey);
    const second = await publishEvent(apiKey);

    const target = queueOf(relay);
    const original = target.addBulk.bind(target);
    let call = 0;
    const spy = jest.spyOn(target, 'addBulk').mockImplementation(async (jobs) => {
      call += 1;
      if (call === 2) throw new Error('simulated failure on 2nd row');
      return original(jobs);
    });

    // outbox id 순서 = 발행 순서이므로 first는 성공, second에서 실패
    expect(await relay.tick()).toBe(1);
    spy.mockRestore();

    const firstOutbox = await ctx.prisma.outboxMessage.findFirst({
      where: { eventId: first.eventId },
    });
    const secondOutbox = await ctx.prisma.outboxMessage.findFirst({
      where: { eventId: second.eventId },
    });
    expect(firstOutbox!.status).toBe('PUBLISHED');
    expect(secondOutbox!.status).toBe('PENDING');

    // 다음 틱이 남은 행을 마저 처리한다
    expect(await relay.tick()).toBe(1);
    expect(
      (await ctx.prisma.outboxMessage.findFirst({ where: { eventId: second.eventId } }))!.status,
    ).toBe('PUBLISHED');
  });
});

/** RelayService 내부의 Queue 핸들 — 장애 시뮬레이션(spy) 전용 접근자 */
function queueOf(relay: RelayService): Queue {
  return (relay as unknown as { queue: Queue }).queue;
}
