import {
  RETRY_DEFAULTS,
  backoffStrategy,
  exponentialCeilingMs,
  fullJitterDelayMs,
  RetryPolicy,
  RetrySignal,
} from './backoff';

describe('full jitter backoff', () => {
  const policy: RetryPolicy = { ...RETRY_DEFAULTS };

  it('첫 실패의 상한은 base(30s) — 2^(attempt-1)라서 attempt=1일 때 2^0=1', () => {
    expect(exponentialCeilingMs(1, policy)).toBe(30_000);
    expect(exponentialCeilingMs(2, policy)).toBe(60_000);
    expect(exponentialCeilingMs(3, policy)).toBe(120_000);
  });

  it('cap(4h)를 넘지 않는다', () => {
    expect(exponentialCeilingMs(20, policy)).toBe(policy.capMs);
  });

  it('random=0이면 지연 0, random이 1에 가까우면 상한 직전', () => {
    expect(fullJitterDelayMs(1, policy, () => 0)).toBe(0);
    expect(fullJitterDelayMs(1, policy, () => 0.999999)).toBe(29_999);
  });

  it('base=0이면 항상 0 — 테스트가 재시도 전이를 대기 없이 검증할 수 있다', () => {
    expect(fullJitterDelayMs(5, { ...policy, baseMs: 0 }, () => 0.5)).toBe(0);
  });

  it('RetrySignal이 감싸져도 메시지에서 지연을 복구한다', () => {
    expect(backoffStrategy(1, 'custom', new RetrySignal(1234))).toBe(1234);
    expect(backoffStrategy(1, 'custom', new Error('retry in 500ms'))).toBe(500);
    expect(backoffStrategy(1, 'custom', new Error('boom'))).toBe(30_000);
    expect(backoffStrategy(1, undefined, undefined)).toBe(30_000);
  });

  it('풀 지터는 [0, ceiling)에 흩어지고, 지터 없는 지수는 한 점에 모인다', () => {
    const samples = 2_000;
    const jitter = Array.from({ length: samples }, () => fullJitterDelayMs(3, policy));
    const clustered = Array.from({ length: samples }, () => exponentialCeilingMs(3, policy));

    expect(new Set(clustered).size).toBe(1);
    expect(Math.min(...jitter)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...jitter)).toBeLessThan(exponentialCeilingMs(3, policy));
    // 2^n 시각에 동기화되지 않았다는 증거 — 고유값이 충분히 많다
    expect(new Set(jitter).size).toBeGreaterThan(200);

    const mean = jitter.reduce((a, b) => a + b, 0) / samples;
    const ceiling = exponentialCeilingMs(3, policy);
    // uniform[0, ceiling)의 기댓값은 ceiling/2. 큰 표본에서 20% 안에 들어오면 충분하다.
    expect(mean).toBeGreaterThan(ceiling * 0.3);
    expect(mean).toBeLessThan(ceiling * 0.7);
  });
});
