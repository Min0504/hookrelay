/**
 * 재시도 지연 — 지수 백오프 + 풀 지터.
 *
 * 수신자가 30분 다운됐다가 살아나는 순간, 그동안 쌓인 실패가 같은 시각에
 * 몰리면(thundering herd) 갓 복구한 서버를 다시 죽인다. 고정 간격은 장애
 * 길이에 적응하지 못하고, 지터 없는 지수는 2^n 시각에 재시도가 동기화된다.
 *
 * AWS Architecture Blog의 표준 권고를 따른다:
 *   delay = random(0, min(cap, base × 2^(attempt-1)))
 * attempt는 "방금 실패한 시도 번호"(1-based). 첫 재시도 상한은 base(30s),
 * 상한 cap(4h), 최대 8회 후 DEAD. 누적 대기는 최악의 경우 약 13시간.
 *
 * full jitter는 개별 배달의 정확한 시각 예측을 포기하는 대신 스파이크를 없앤다.
 * 그 공백은 next_retry_at 조회와 "최대 13시간 내 8회" SLA로 메운다.
 */

export const RETRY_DEFAULTS = {
  baseMs: 30_000,
  capMs: 4 * 60 * 60 * 1000,
  maxAttempts: 8,
} as const;

export interface RetryPolicy {
  baseMs: number;
  capMs: number;
  maxAttempts: number;
}

export class RetrySignal extends Error {
  constructor(public readonly delayMs: number) {
    super(`retry in ${delayMs}ms`);
    this.name = 'RetrySignal';
  }
}

/** 지터 없는 지수 — 비교용. 모든 실패가 같은 시각에 재시도된다. */
export function exponentialCeilingMs(failedAttemptNo: number, policy: RetryPolicy): number {
  const exp = Math.max(0, failedAttemptNo - 1);
  return Math.min(policy.capMs, policy.baseMs * 2 ** exp);
}

/**
 * 풀 지터 지연. random은 [0, 1) — 테스트에서 고정 시드를 주입한다.
 * ceiling이 0이면(테스트용 base=0) 즉시 재시도.
 */
export function fullJitterDelayMs(
  failedAttemptNo: number,
  policy: RetryPolicy,
  random: () => number = Math.random,
): number {
  const ceiling = exponentialCeilingMs(failedAttemptNo, policy);
  if (ceiling <= 0) return 0;
  return Math.floor(random() * ceiling);
}

/** BullMQ Worker settings.backoffStrategy — RetrySignal에 담아 둔 지연을 그대로 쓴다. */
export function backoffStrategy(
  _attemptsMade: number,
  _type: string | undefined,
  err: Error | undefined,
): number {
  if (err instanceof RetrySignal) return err.delayMs;
  // BullMQ가 에러를 감싸면 instanceof가 깨지므로 메시지에서 복구한다
  const match = err ? /^retry in (\d+)ms$/.exec(err.message) : null;
  return match ? Number(match[1]) : RETRY_DEFAULTS.baseMs;
}
