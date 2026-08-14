import { AttemptErrorClass } from '@prisma/client';
import { classifyFailure, SsrfBlockedError } from './delivery-http.client';

describe('classifyFailure — 실패 어휘의 경계', () => {
  it('SSRF 차단은 별도 분류로 남긴다 — 보안 이벤트는 네트워크 오류에 묻히면 안 된다', () => {
    expect(classifyFailure(new SsrfBlockedError('10.0.0.5 — 사설 대역'))).toBe(
      AttemptErrorClass.SSRF_BLOCKED,
    );
  });

  it('타임아웃(TimeoutError / AbortError / UND_ERR_ABORTED)은 TIMEOUT', () => {
    // AbortSignal.timeout()이 던지는 것은 AbortError가 아니라 TimeoutError다
    const timeout = new Error('timed out');
    timeout.name = 'TimeoutError';
    expect(classifyFailure(timeout)).toBe(AttemptErrorClass.TIMEOUT);

    const abort = new Error('aborted');
    abort.name = 'AbortError';
    expect(classifyFailure(abort)).toBe(AttemptErrorClass.TIMEOUT);

    const undici = Object.assign(new Error('aborted'), { code: 'UND_ERR_ABORTED' });
    expect(classifyFailure(undici)).toBe(AttemptErrorClass.TIMEOUT);
  });

  it('cause 체인을 따라 내려가 분류한다 — undici는 원인을 감싸서 던진다', () => {
    const inner = new SsrfBlockedError('169.254.169.254 — 링크로컬');
    const wrapped = Object.assign(new Error('fetch failed'), { cause: inner });
    expect(classifyFailure(wrapped)).toBe(AttemptErrorClass.SSRF_BLOCKED);
  });

  it('연결류 오류(ECONNREFUSED·DNS 실패 등)는 CONN_REFUSED로 묶는다', () => {
    expect(classifyFailure(Object.assign(new Error('refused'), { code: 'ECONNREFUSED' }))).toBe(
      AttemptErrorClass.CONN_REFUSED,
    );
    expect(classifyFailure(new Error('getaddrinfo ENOTFOUND nope.invalid'))).toBe(
      AttemptErrorClass.CONN_REFUSED,
    );
  });
});
