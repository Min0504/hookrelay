import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import {
  CircuitConfig,
  CircuitSnapshot,
  CIRCUIT_DEFAULTS,
  decideAttempt,
  EMPTY_CIRCUIT,
  onFailure,
  onSuccess,
} from './circuit';

export const WORKER_REDIS_TOKEN = Symbol('WORKER_REDIS');

const PROBE_TTL_SEC = 30;

function keyOf(endpointId: string): string {
  return `hr:cb:${endpointId}`;
}

function probeKey(endpointId: string): string {
  return `hr:cb:${endpointId}:probe`;
}

/**
 * 서킷 스냅샷의 워커 간 공유 저장소.
 *
 * 메모리에 두면 워커 N대일 때 각각 10번씩 두들긴 뒤에야 OPEN된다.
 * Redis가 전소하면 CLOSED로 돌아가 다시 열리기까지 실패가 쌓인다(fail-open) —
 * 배달을 멈추는 쪽보다 일시적으로 죽은 endpoint를 다시 두드리는 편이 낫다.
 */
@Injectable()
export class CircuitStore {
  private readonly cfg: CircuitConfig;

  constructor(
    @Inject(WORKER_REDIS_TOKEN) private readonly redis: Redis,
    config: ConfigService,
  ) {
    this.cfg = {
      openAfter: config.get<number>('HR_CIRCUIT_OPEN_AFTER', CIRCUIT_DEFAULTS.openAfter),
      cooldownMs: config.get<number>('HR_CIRCUIT_COOLDOWN_MS', CIRCUIT_DEFAULTS.cooldownMs),
      disableAfter: config.get<number>('HR_CIRCUIT_DISABLE_AFTER', CIRCUIT_DEFAULTS.disableAfter),
    };
  }

  async allow(endpointId: string, now = Date.now()): Promise<boolean> {
    try {
      const current = await this.read(endpointId);
      const { allow, next } = decideAttempt(current, now, this.cfg);
      if (!allow) return false;
      if (next.state === 'HALF_OPEN') {
        // 프로브는 전 워커 합쳐 1건 — SET NX가 진 워커는 HTTP를 생략한다
        const won = await this.redis.set(probeKey(endpointId), '1', 'EX', PROBE_TTL_SEC, 'NX');
        if (won !== 'OK') return false;
        await this.write(endpointId, next);
        return true;
      }
      return true;
    } catch {
      // Redis 전소 시 CLOSED로 간주 — 배달을 멈추는 쪽보다 죽은 endpoint를 다시 두드리는 편이 낫다
      return true;
    }
  }

  async success(endpointId: string): Promise<void> {
    try {
      await this.write(endpointId, onSuccess());
      await this.redis.del(probeKey(endpointId));
    } catch {
      /* fail-open: 상태 갱신 실패는 다음 시도에서 재동기화 */
    }
  }

  async failure(endpointId: string, now = Date.now()): Promise<{ disable: boolean; failures: number }> {
    try {
      const current = await this.read(endpointId);
      const { next, disable } = onFailure(current, now, this.cfg);
      await this.write(endpointId, next);
      await this.redis.del(probeKey(endpointId));
      return { disable, failures: next.failures };
    } catch {
      return { disable: false, failures: 0 };
    }
  }

  private async read(endpointId: string): Promise<CircuitSnapshot> {
    const raw = await this.redis.get(keyOf(endpointId));
    if (!raw) return { ...EMPTY_CIRCUIT };
    try {
      return JSON.parse(raw) as CircuitSnapshot;
    } catch {
      return { ...EMPTY_CIRCUIT };
    }
  }

  private async write(endpointId: string, snapshot: CircuitSnapshot): Promise<void> {
    await this.redis.set(keyOf(endpointId), JSON.stringify(snapshot));
  }
}
