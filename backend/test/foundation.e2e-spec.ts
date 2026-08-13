import request from 'supertest';
import { createTestApp, TEST_ADMIN_KEY, TestContext } from './helpers/test-app';

/**
 * Foundation E2E — 테넌트·API 키·endpoint·구독의 전체 계약.
 * 검증 핵심: ① 비밀값 원문 미저장 ② 키 회전 유예 ③ SSRF 등록 차단 ④ 크로스 테넌트 격리.
 */
describe('Foundation (tenants / api-keys / endpoints)', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await createTestApp();
  });

  afterAll(async () => {
    await ctx.stop();
  });

  function http(): ReturnType<typeof request> {
    return request(ctx.app.getHttpServer());
  }

  async function createTenant(name: string): Promise<{ tenantId: string; apiKey: string }> {
    const res = await http()
      .post('/tenants')
      .set('X-Admin-Key', TEST_ADMIN_KEY)
      .send({ name })
      .expect(201);
    return { tenantId: res.body.tenantId, apiKey: res.body.apiKey };
  }

  describe('테넌트 생성 (admin)', () => {
    it('관리자 키 없이는 401 — 응답에 존재 힌트를 남기지 않는다', async () => {
      const res = await http().post('/tenants').send({ name: 'no-auth' }).expect(401);
      expect(res.body.code).toBe('ADMIN_KEY_REQUIRED');
    });

    it('생성 응답은 sk_live_ 원문 키를 단 한 번 노출하고, DB에는 해시만 남는다', async () => {
      const res = await http()
        .post('/tenants')
        .set('X-Admin-Key', TEST_ADMIN_KEY)
        .send({ name: 'acme', plan: 'PRO' })
        .expect(201);

      expect(res.body.apiKey).toMatch(/^sk_live_/);
      expect(res.body.apiKeyLast4).toBe(res.body.apiKey.slice(-4));

      const stored = await ctx.prisma.apiKey.findFirst({ where: { tenantId: res.body.tenantId } });
      expect(stored!.keyHash).toHaveLength(64);
      expect(stored!.keyHash).not.toContain('sk_live_');
    });

    it('같은 이름은 409', async () => {
      await createTenant('dup-name');
      const res = await http()
        .post('/tenants')
        .set('X-Admin-Key', TEST_ADMIN_KEY)
        .send({ name: 'dup-name' })
        .expect(409);
      expect(res.body.code).toBe('TENANT_NAME_EXISTS');
    });
  });

  describe('API 키 인증·회전', () => {
    it('잘못된 키는 401', async () => {
      await http().get('/endpoints').set('Authorization', 'Bearer sk_live_wrong').expect(401);
      await http().get('/endpoints').set('Authorization', 'Bearer not-a-key').expect(401);
      await http().get('/endpoints').expect(401);
    });

    it('회전: 새 키 발급 + 구 키는 24시간 유예(GRACE) 후 만료된다', async () => {
      const { apiKey: oldKey } = await createTenant('rotator');

      const rotated = await http()
        .post('/api-keys/rotate')
        .set('Authorization', `Bearer ${oldKey}`)
        .expect(201);
      const newKey = rotated.body.apiKey;
      expect(newKey).toMatch(/^sk_live_/);
      expect(newKey).not.toBe(oldKey);
      expect(rotated.body.graceHours).toBe(24);

      // 유예 기간 중에는 구 키·새 키 모두 유효 — 배포 전환 공백에서 401 사고를 막는 창
      await http().get('/endpoints').set('Authorization', `Bearer ${oldKey}`).expect(200);
      await http().get('/endpoints').set('Authorization', `Bearer ${newKey}`).expect(200);

      // 유예 만료를 시뮬레이션 — 만료된 GRACE 키는 조회 시점에 REVOKED로 확정(lazy)
      await ctx.prisma.apiKey.updateMany({
        where: { status: 'GRACE' },
        data: { expiresAt: new Date(Date.now() - 1000) },
      });
      await http().get('/endpoints').set('Authorization', `Bearer ${oldKey}`).expect(401);
      await http().get('/endpoints').set('Authorization', `Bearer ${newKey}`).expect(200);

      const revoked = await ctx.prisma.apiKey.findMany({ where: { status: 'REVOKED' } });
      expect(revoked.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('endpoint 등록 — SSRF 방어', () => {
    let apiKey: string;

    beforeAll(async () => {
      ({ apiKey } = await createTenant('ssrf-tester'));
    });

    async function tryRegister(url: string): Promise<{ status: number; code?: string }> {
      const res = await http().post('/endpoints').set('Authorization', `Bearer ${apiKey}`).send({ url });
      return { status: res.status, code: res.body.code };
    }

    it('http URL은 기본 설정에서 거부한다', async () => {
      const res = await tryRegister('http://receiver.example.com/hooks');
      expect(res.status).toBe(400);
      expect(res.code).toBe('UNSAFE_ENDPOINT_URL');
    });

    it('사설·루프백·메타데이터 IP를 거부한다', async () => {
      for (const url of [
        'https://10.0.0.5/hooks',
        'https://127.0.0.1/hooks',
        'https://192.168.1.1/hooks',
        'https://169.254.169.254/latest/meta-data',
        'https://[::1]/hooks',
      ]) {
        const res = await tryRegister(url);
        expect(res).toEqual({ status: 400, code: 'UNSAFE_ENDPOINT_URL' });
      }
    });

    it('공인 호스트는 등록되고, 시크릿 원문은 생성 응답에만 있다', async () => {
      const res = await http()
        .post('/endpoints')
        .set('Authorization', `Bearer ${apiKey}`)
        .send({ url: 'https://example.com/hooks', description: '주문 수신' })
        .expect(201);

      expect(res.body.secret).toMatch(/^whsec_/);
      expect(res.body.status).toBe('ACTIVE');

      // 저장값은 암호문 — 평문도, 해시도 아니다(배달 서명에 원문이 필요하므로 복호화 가능해야 한다)
      const stored = await ctx.prisma.endpoint.findUnique({ where: { id: res.body.id } });
      expect(stored!.secretEnc).toMatch(/^v1:/);
      expect(stored!.secretEnc).not.toContain(res.body.secret);

      // 이후 조회에서는 시크릿이 내려오지 않는다
      const detail = await http()
        .get(`/endpoints/${res.body.id}`)
        .set('Authorization', `Bearer ${apiKey}`)
        .expect(200);
      expect(detail.body.secret).toBeUndefined();
    });

    it('같은 URL 중복 등록은 409', async () => {
      const res = await tryRegister('https://example.com/hooks');
      expect(res).toEqual({ status: 409, code: 'ENDPOINT_URL_EXISTS' });
    });
  });

  describe('구독 설정', () => {
    let apiKey: string;
    let endpointId: string;

    beforeAll(async () => {
      ({ apiKey } = await createTenant('subscriber'));
      const res = await http()
        .post('/endpoints')
        .set('Authorization', `Bearer ${apiKey}`)
        .send({ url: 'https://example.com/sub-hooks' })
        .expect(201);
      endpointId = res.body.id;
    });

    it('PUT은 전체 교체 의미론 — 두 번째 호출이 첫 설정을 대체한다', async () => {
      await http()
        .put(`/endpoints/${endpointId}/subscriptions`)
        .set('Authorization', `Bearer ${apiKey}`)
        .send({ eventTypes: ['order.created', 'order.cancelled'] })
        .expect(200);

      const replaced = await http()
        .put(`/endpoints/${endpointId}/subscriptions`)
        .set('Authorization', `Bearer ${apiKey}`)
        .send({ eventTypes: ['payment.captured'] })
        .expect(200);
      expect(replaced.body.eventTypes).toEqual(['payment.captured']);

      const detail = await http()
        .get(`/endpoints/${endpointId}`)
        .set('Authorization', `Bearer ${apiKey}`)
        .expect(200);
      expect(detail.body.eventTypes).toEqual(['payment.captured']);
    });

    it('점 표기가 아닌 이벤트 타입은 400', async () => {
      await http()
        .put(`/endpoints/${endpointId}/subscriptions`)
        .set('Authorization', `Bearer ${apiKey}`)
        .send({ eventTypes: ['OrderCreated'] })
        .expect(400);
    });
  });

  describe('크로스 테넌트 격리 (IDOR)', () => {
    it('다른 테넌트의 endpoint는 조회·수정·구독 설정 모두 404 — 존재조차 알리지 않는다', async () => {
      const a = await createTenant('tenant-a');
      const b = await createTenant('tenant-b');

      const created = await http()
        .post('/endpoints')
        .set('Authorization', `Bearer ${a.apiKey}`)
        .send({ url: 'https://example.com/tenant-a-hooks' })
        .expect(201);
      const endpointId = created.body.id;

      const get = await http()
        .get(`/endpoints/${endpointId}`)
        .set('Authorization', `Bearer ${b.apiKey}`)
        .expect(404);
      expect(get.body.code).toBe('ENDPOINT_NOT_FOUND');

      await http()
        .patch(`/endpoints/${endpointId}`)
        .set('Authorization', `Bearer ${b.apiKey}`)
        .send({ status: 'DISABLED_MANUAL' })
        .expect(404);

      await http()
        .put(`/endpoints/${endpointId}/subscriptions`)
        .set('Authorization', `Bearer ${b.apiKey}`)
        .send({ eventTypes: ['order.created'] })
        .expect(404);

      // A 자신에게는 그대로 보인다
      await http()
        .get(`/endpoints/${endpointId}`)
        .set('Authorization', `Bearer ${a.apiKey}`)
        .expect(200);
    });
  });
});
