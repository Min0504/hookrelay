import { Injectable, Logger, OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { DomainException } from '../common/errors/domain.exception';
import { Errors } from '../common/errors/errors';
import { eventsRateLimitedTotal } from '../metrics/registry';

/**
 * 테넌트 plan별 발행 한도 — Redis 고정 윈도 카운터.
 *
 * API는 배달 큐를 만지지 않는다. 이 연결은 rate limit 전용이다.
 * Redis가 죽으면 fail-open: 한도를 잠시 포기하고 발행을 받는다.
 * "큐가 죽어도 이벤트는 안 잃는다"와 같은 이유 — 429가 발행 경로를 막으면 안 된다.
 *
 * 한도 0은 비활성(테스트 기본). 연결 자체를 열지 않는다.
 */
const CONSUME_LUA = `
local n = redis.call('INCR', KEYS[1])
if n == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end
local ttl = redis.call('TTL', KEYS[1])
return { n, ttl }
`;

@Injectable()
export class PublishRateLimiter implements OnApplicationShutdown {
  private readonly logger = new Logger(PublishRateLimiter.name);
  private redis: Redis | null = null;
  private readonly windowSec = 60;
  private readonly limits: Record<'FREE' | 'PRO', number>;

  constructor(config: ConfigService) {
    this.limits = {
      FREE: config.get<number>('HR_RATE_LIMIT_FREE_PER_MIN', 60),
      PRO: config.get<number>('HR_RATE_LIMIT_PRO_PER_MIN', 600),
    };
    if (this.limits.FREE <= 0 && this.limits.PRO <= 0) return;
    this.redis = new Redis(config.getOrThrow<string>('REDIS_URL'), {
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
      lazyConnect: true,
      connectTimeout: 500,
    });
    this.redis.on('error', (error) => {
      this.logger.warn(`rate-limit redis: ${error.message}`);
    });
  }

  async consume(tenantId: string, plan: string): Promise<void> {
    const cap = plan === 'PRO' ? this.limits.PRO : this.limits.FREE;
    if (cap <= 0 || !this.redis) return;

    try {
      if (this.redis.status === 'wait') await this.redis.connect();
      const key = `hr:rl:${tenantId}`;
      const raw = (await this.redis.eval(CONSUME_LUA, 1, key, this.windowSec)) as [number, number];
      const used = Number(raw[0]);
      const ttl = Number(raw[1]);
      if (used > cap) {
        eventsRateLimitedTotal.inc({ plan: plan === 'PRO' ? 'PRO' : 'FREE' });
        throw Errors.rateLimited(Math.max(1, ttl));
      }
    } catch (error) {
      if (error instanceof DomainException) throw error;
      this.logger.warn(`rate-limit fail-open: ${String(error)}`);
    }
  }

  async onApplicationShutdown(): Promise<void> {
    this.redis?.disconnect();
  }
}
