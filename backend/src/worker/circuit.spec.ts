import {
  CIRCUIT_DEFAULTS,
  CircuitSnapshot,
  decideAttempt,
  EMPTY_CIRCUIT,
  onFailure,
  onSuccess,
} from './circuit';

describe('circuit state machine', () => {
  const cfg = { ...CIRCUIT_DEFAULTS, openAfter: 3, cooldownMs: 1_000, disableAfter: 5 };
  const now = 1_000_000;

  it('CLOSED에서 임계치 미만 실패는 상태를 유지한다', () => {
    let s = EMPTY_CIRCUIT;
    s = onFailure(s, now, cfg).next;
    s = onFailure(s, now, cfg).next;
    expect(s.state).toBe('CLOSED');
    expect(s.failures).toBe(2);
    expect(decideAttempt(s, now, cfg).allow).toBe(true);
  });

  it('연속 실패 openAfter회에 OPEN — 쿨다운 전에는 HTTP를 생략한다', () => {
    let s = EMPTY_CIRCUIT;
    for (let i = 0; i < 3; i += 1) s = onFailure(s, now, cfg).next;
    expect(s.state).toBe('OPEN');
    expect(decideAttempt(s, now, cfg).allow).toBe(false);
    expect(decideAttempt(s, now + 999, cfg).allow).toBe(false);
  });

  it('쿨다운이 끝나면 HALF_OPEN 프로브 1건을 허용한다', () => {
    const open: CircuitSnapshot = { state: 'OPEN', failures: 3, openedAt: now };
    const decided = decideAttempt(open, now + 1_000, cfg);
    expect(decided.allow).toBe(true);
    expect(decided.next.state).toBe('HALF_OPEN');
  });

  it('HALF_OPEN 성공은 CLOSED로 리셋한다', () => {
    expect(onSuccess()).toEqual(EMPTY_CIRCUIT);
  });

  it('HALF_OPEN 실패는 다시 OPEN이다', () => {
    const half: CircuitSnapshot = { state: 'HALF_OPEN', failures: 3, openedAt: now };
    const { next, disable } = onFailure(half, now + 2_000, cfg);
    expect(next.state).toBe('OPEN');
    expect(next.openedAt).toBe(now + 2_000);
    expect(disable).toBe(false);
  });

  it('disableAfter에 도달하면 호출측이 DISABLED_AUTO로 내릴 신호다', () => {
    let s = EMPTY_CIRCUIT;
    let disable = false;
    for (let i = 0; i < 5; i += 1) {
      const r = onFailure(s, now, cfg);
      s = r.next;
      disable = r.disable;
    }
    expect(disable).toBe(true);
    expect(s.failures).toBe(5);
  });
});
