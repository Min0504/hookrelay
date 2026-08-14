import { Injectable, OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AttemptErrorClass } from '@prisma/client';
import { lookup as dnsLookup } from 'dns';
import { isIP } from 'net';
import { Agent, request } from 'undici';
import { blockedIpReason } from '../security/ssrf.service';

/** SSRF 재검증 실패 — 연결 자체가 차단됐다는 명시적 신호 */
export class SsrfBlockedError extends Error {
  constructor(public readonly reason: string) {
    super(`SSRF 차단: ${reason}`);
    this.name = 'SsrfBlockedError';
  }
}

export type AttemptOutcome =
  | { ok: true; status: number; bodyHead: string; durationMs: number }
  | {
      ok: false;
      errorClass: AttemptErrorClass;
      status: number | null;
      bodyHead: string | null;
      durationMs: number;
    };

/**
 * 실패 분류 — 재시도 정책과 통계의 기준이 되는 어휘.
 * 연결류 오류(DNS 실패·거부·TLS 등)는 CONN_REFUSED로 묶는다: 수신자 입장에서
 * "요청이 도달하지 못했다"는 같은 사건이고, 세부 원인은 body_head에 남는다.
 */
export function classifyFailure(error: unknown): AttemptErrorClass {
  if (error instanceof SsrfBlockedError) return AttemptErrorClass.SSRF_BLOCKED;
  const err = error as { name?: string; code?: string; cause?: unknown };
  // AbortSignal.timeout()은 'TimeoutError', 수동 abort는 'AbortError'로 온다
  if (err.name === 'TimeoutError' || err.name === 'AbortError' || err.code === 'UND_ERR_ABORTED') {
    return AttemptErrorClass.TIMEOUT;
  }
  if (err.cause) return classifyFailure(err.cause);
  return AttemptErrorClass.CONN_REFUSED;
}

const BODY_HEAD_LIMIT = 1024;

/**
 * 배달 전용 HTTP 클라이언트 — 등록 시 1회 SSRF 검증만 믿지 않는다.
 *
 * DNS rebinding: 등록 땐 공인 IP를 돌려주고 배달 땐 내부 IP로 바꾸는 공격.
 * 이를 막으려면 "검증한 IP"와 "연결하는 IP"가 같아야 하므로, undici Agent의
 * connect 단계 lookup 훅에서 해석된 실제 IP를 검사한다 — 검사를 통과한
 * 주소로만 소켓이 열린다(TOCTOU 없음).
 */
@Injectable()
export class DeliveryHttpClient implements OnApplicationShutdown {
  private readonly agent: Agent;
  private readonly allowPrivate: boolean;

  constructor(config: ConfigService) {
    this.allowPrivate = config.get<boolean>('HR_ALLOW_PRIVATE_DESTINATIONS', false);
    this.agent = new Agent({
      connect: {
        lookup: (hostname, options, callback) => {
          dnsLookup(hostname, { ...options, all: true }, (error, addresses) => {
            if (error) {
              callback(error, []);
              return;
            }
            for (const address of addresses) {
              const reason = this.allowPrivate ? null : blockedIpReason(address.address);
              if (reason) {
                callback(new SsrfBlockedError(`${address.address} — ${reason}`), []);
                return;
              }
            }
            callback(null, addresses);
          });
        },
      },
    });
  }

  /** 한 번의 배달 시도. 예외를 던지지 않고 항상 분류된 결과를 반환한다. */
  async send(
    url: string,
    headers: Record<string, string>,
    body: string,
    timeoutMs: number,
  ): Promise<AttemptOutcome> {
    const startedAt = Date.now();
    try {
      // IP 리터럴 호스트는 DNS 조회가 없어 lookup 훅을 타지 않는다 — 여기서 직접 검사.
      // (호스트명 URL은 아래 Agent의 lookup 훅이 해석된 실제 IP를 검사한다)
      if (!this.allowPrivate) {
        const hostname = new URL(url).hostname.replace(/^\[|\]$/g, '');
        if (isIP(hostname) !== 0) {
          const reason = blockedIpReason(hostname);
          if (reason) throw new SsrfBlockedError(`${hostname} — ${reason}`);
        }
      }
      const res = await request(url, {
        method: 'POST',
        headers,
        body,
        dispatcher: this.agent,
        signal: AbortSignal.timeout(timeoutMs),
      });
      // 본문은 앞 1KB만 보존 — 소켓 반환을 위해 항상 끝까지 소비한다
      const text = await res.body.text();
      const bodyHead = text.slice(0, BODY_HEAD_LIMIT);
      const durationMs = Date.now() - startedAt;

      // 2xx만 성공 — 3xx 리다이렉트는 따라가지 않는다(서명된 POST의 행선지가
      // 바뀌는 것은 보안상 수용 불가). 2xx 외 전부를 상태 코드 대역으로 분류한다.
      if (res.statusCode >= 200 && res.statusCode < 300) {
        return { ok: true, status: res.statusCode, bodyHead, durationMs };
      }
      return {
        ok: false,
        errorClass: res.statusCode >= 500 ? AttemptErrorClass.HTTP_5XX : AttemptErrorClass.HTTP_4XX,
        status: res.statusCode,
        bodyHead,
        durationMs,
      };
    } catch (error) {
      return {
        ok: false,
        errorClass: classifyFailure(error),
        status: null,
        bodyHead: String(error).slice(0, BODY_HEAD_LIMIT),
        durationMs: Date.now() - startedAt,
      };
    }
  }

  async onApplicationShutdown(): Promise<void> {
    await this.agent.close();
  }
}
