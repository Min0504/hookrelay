import { RedisContainer, StartedRedisContainer } from '@testcontainers/redis';
import { randomUUID } from 'crypto';
import request from 'supertest';
import { createTestApp, TEST_ADMIN_KEY, TestContext } from './helpers/test-app';

describe('Observability + publish rate limit', () => {
  let ctx: TestContext;
  let redis: StartedRedisContainer;

  beforeAll(async () => {
    redis = await new RedisContainer('redis:7-alpine').start();
    ctx = await createTestApp({
      REDIS_URL: redis.getConnectionUrl(),
      HR_RATE_LIMIT_FREE_PER_MIN: '2',
      HR_RATE_LIMIT_PRO_PER_MIN: '1000',
    });
  }, 120_000);

  afterAll(async () => {
    await ctx.stop();
    await redis.stop();
  });

  it('GET /metrics 는 인증 없이 Prometheus 텍스트를 돌려준다', async () => {
    await request(ctx.app.getHttpServer()).post('/tenants').send({ name: 'nope' }).expect(401);
    const res = await request(ctx.app.getHttpServer()).get('/metrics').expect(200);
    expect(res.text).toContain('hookrelay_http_requests_total');
    expect(res.text).not.toMatch(/tenant_id=/);
  });

  it('FREE 플랜은 분당 한도를 넘으면 429 + Retry-After', async () => {
    const tenant = await request(ctx.app.getHttpServer())
      .post('/tenants')
      .set('X-Admin-Key', TEST_ADMIN_KEY)
      .send({ name: `rl-${randomUUID().slice(0, 8)}`, plan: 'FREE' })
      .expect(201);
    const key = tenant.body.apiKey as string;

    const publish = () =>
      request(ctx.app.getHttpServer())
        .post('/events')
        .set('Authorization', `Bearer ${key}`)
        .set('Idempotency-Key', randomUUID())
        .send({ type: 'order.created', payload: {} });

    await publish().expect(202);
    await publish().expect(202);
    const limited = await publish().expect(429);
    expect(limited.body.code).toBe('RATE_LIMITED');
    expect(limited.headers['retry-after']).toBeDefined();
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
  });
});
