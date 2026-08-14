import { createHmac, createHash } from 'crypto';

/**
 * 배달 요청 서명 — 수신자가 "정말 HookRelay가 보냈고, 본문이 변조되지 않았다"를
 * 검증하는 근거. 이 형식 자체가 수신자에게 제공되는 공개 계약이다.
 *
 *   X-HookRelay-Signature: v1=hex(HMAC-SHA256(secret, "{timestamp}.{body}"))
 *
 * timestamp를 서명에 포함하는 이유: 서명된 요청을 통째로 재전송하는 리플레이 공격을
 * 수신자가 시각 허용 오차(권장 5분)로 거절할 수 있게 하기 위함이다.
 */
export function signDeliveryBody(secret: string, timestampSec: number, body: string): string {
  const mac = createHmac('sha256', secret).update(`${timestampSec}.${body}`).digest('hex');
  return `v1=${mac}`;
}

export interface DeliveryHeaders extends Record<string, string> {
  'content-type': string;
  'user-agent': string;
  'x-hookrelay-event': string;
  'x-delivery-id': string;
  'x-hookrelay-timestamp': string;
  'x-hookrelay-signature': string;
}

export function buildDeliveryHeaders(params: {
  eventType: string;
  deliveryId: string;
  timestampSec: number;
  signature: string;
}): DeliveryHeaders {
  return {
    'content-type': 'application/json',
    'user-agent': 'HookRelay/1.0',
    'x-hookrelay-event': params.eventType,
    // 수신자 멱등 처리의 기준 — 같은 배달의 재시도는 항상 같은 ID로 온다
    'x-delivery-id': params.deliveryId,
    'x-hookrelay-timestamp': String(params.timestampSec),
    'x-hookrelay-signature': params.signature,
  };
}

/** 헤더 전송 증빙용 다이제스트 — 시크릿이 아니라 "서명이 포함된 헤더 집합"의 해시만 남긴다. */
export function digestHeaders(headers: Record<string, string>): string {
  const canonical = Object.keys(headers)
    .sort()
    .map((k) => `${k}:${headers[k]}`)
    .join('\n');
  return createHash('sha256').update(canonical).digest('hex');
}
