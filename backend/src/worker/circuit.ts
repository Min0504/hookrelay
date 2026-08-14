/**
 * endpoint 서킷 브레이커 — 순수 상태 기계.
 *
 * 죽은 endpoint가 워커 슬롯을 10초씩 붙잡고 있으면 다른 테넌트까지 지연된다.
 * 연속 실패가 임계치를 넘으면 OPEN: HTTP를 생략하고 즉시 실패 처리한 뒤
 * 재시도 스케줄로 넘긴다. "빨리 실패하고 나중에 재시도"가 "느리게 전부 시도"보다
 * 시스템 전체에 이롭다.
 *
 * CLOSED  --(연속 실패 N회)--> OPEN --(cooldown 후 1건)--> HALF_OPEN
 *   ^                                                    |
 *   +---------------------- 성공 ------------------------+
 * HALF_OPEN 실패는 다시 OPEN. 연속 실패 M회면 DISABLED_AUTO는 호출측이 처리.
 *
 * 워커 간 공유가 필수라 상태는 Redis에 둔다. 이 파일은 전이만 담당해 단위 테스트한다.
 */

export type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

export interface CircuitSnapshot {
  state: CircuitState;
  failures: number;
  openedAt: number;
}

export interface CircuitConfig {
  openAfter: number;
  cooldownMs: number;
  disableAfter: number;
}

export const CIRCUIT_DEFAULTS: CircuitConfig = {
  openAfter: 10,
  cooldownMs: 5 * 60 * 1000,
  disableAfter: 50,
};

export const EMPTY_CIRCUIT: CircuitSnapshot = { state: 'CLOSED', failures: 0, openedAt: 0 };

export function decideAttempt(
  snapshot: CircuitSnapshot,
  now: number,
  cfg: CircuitConfig,
): { allow: boolean; next: CircuitSnapshot } {
  if (snapshot.state === 'CLOSED') return { allow: true, next: snapshot };
  if (snapshot.state === 'OPEN') {
    if (now < snapshot.openedAt + cfg.cooldownMs) return { allow: false, next: snapshot };
    return { allow: true, next: { ...snapshot, state: 'HALF_OPEN' } };
  }
  // HALF_OPEN: 동시에 여러 워커가 들어오면 저장소가 SET NX로 1건만 통과시킨다.
  // 순수 함수는 "프로브 허용"만 표현하고, 잠금은 CircuitStore가 담당한다.
  return { allow: true, next: snapshot };
}

export function onSuccess(): CircuitSnapshot {
  return { ...EMPTY_CIRCUIT };
}

export function onFailure(
  snapshot: CircuitSnapshot,
  now: number,
  cfg: CircuitConfig,
): { next: CircuitSnapshot; disable: boolean } {
  const failures = snapshot.failures + 1;
  const disable = failures >= cfg.disableAfter;
  if (failures >= cfg.openAfter) {
    return { next: { state: 'OPEN', failures, openedAt: now }, disable };
  }
  return { next: { state: 'CLOSED', failures, openedAt: 0 }, disable };
}
