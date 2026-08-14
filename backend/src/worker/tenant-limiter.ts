import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { WORKER_REDIS_TOKEN } from './circuit.store';

/**
 * 테넌트별 동시 배달 상한.
 *
 * BullMQ Group은 Pro 기능이라 이 규모에서 도입하지 않는다. 같은 효과 — "테넌트 A가
 * 워커 슬롯을 전부 점유하지 못하게" — 를 Redis INCR 세마포어로 구현한다.
 * 슬롯을 못 얻으면 워커는 HTTP를 시작하지 않고 잡을 짧게 지연시킨다. 시도 횟수는
 * 늘지 않는다(점유 실패는 배달 실패가 아니다).
 *
 * TTL은 워커가 release 전에 죽었을 때의 누수 방지용이다.
 */
const ACQUIRE_LUA = `
local key = KEYS[1]
local max = tonumber(ARGV[1])
local ttl = tonumber(ARGV[2])
local n = redis.call('INCR', key)
if n == 1 then redis.call('EXPIRE', key, ttl) end
if n > max then
  redis.call('DECR', key)
  return 0
end
return 1
`;

@Injectable()
export class TenantLimiter {
  private readonly max: number;
  private readonly ttlSec: number;

  constructor(
    @Inject(WORKER_REDIS_TOKEN) private readonly redis: Redis,
    config: ConfigService,
  ) {
    this.max = config.get<number>('HR_TENANT_CONCURRENCY', 3);
    this.ttlSec = config.get<number>('HR_TENANT_SLOT_TTL_SEC', 60);
  }

  async acquire(tenantId: string): Promise<boolean> {
    if (this.max <= 0) return true;
    try {
      const result = await this.redis.eval(ACQUIRE_LUA, 1, this.key(tenantId), this.max, this.ttlSec);
      return result === 1 || result === '1';
    } catch {
      // Redis가 죽으면 격리를 잠시 포기한다 — 슬롯 대기로 배달 전체가 멈추는 쪽이 더 나쁘다
      return true;
    }
  }

  async release(tenantId: string): Promise<void> {
    if (this.max <= 0) return;
    try {
      const n = await this.redis.decr(this.key(tenantId));
      if (n <= 0) await this.redis.del(this.key(tenantId));
    } catch {
      /* TTL이 누수를 회수한다 */
    }
  }

  private key(tenantId: string): string {
    return `hr:tenant:${tenantId}:inflight`;
  }
}
