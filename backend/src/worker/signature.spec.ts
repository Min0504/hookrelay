import { createHmac } from 'crypto';
import { buildDeliveryHeaders, digestHeaders, signDeliveryBody } from './signature';

describe('signDeliveryBody', () => {
  const secret = 'whsec_test_secret';
  const body = JSON.stringify({ eventId: 'e-1', type: 'order.created', payload: { n: 1 } });

  it('v1=hex(HMAC-SHA256(secret, "{timestamp}.{body}")) 형식으로 서명한다 — 수신자 검증 계약', () => {
    const ts = 1755075600;
    const expected = `v1=${createHmac('sha256', secret).update(`${ts}.${body}`).digest('hex')}`;
    expect(signDeliveryBody(secret, ts, body)).toBe(expected);
  });

  it('같은 입력은 같은 서명 — 재시도에도 검증 결과가 흔들리지 않는다', () => {
    expect(signDeliveryBody(secret, 1, body)).toBe(signDeliveryBody(secret, 1, body));
  });

  it('timestamp가 다르면 서명이 달라진다 — 리플레이 방어의 근거', () => {
    expect(signDeliveryBody(secret, 1, body)).not.toBe(signDeliveryBody(secret, 2, body));
  });

  it('본문 1바이트만 바뀌어도 서명이 달라진다', () => {
    expect(signDeliveryBody(secret, 1, body)).not.toBe(signDeliveryBody(secret, 1, `${body} `));
  });

  it('시크릿이 다르면 서명이 달라진다', () => {
    expect(signDeliveryBody('whsec_other', 1, body)).not.toBe(signDeliveryBody(secret, 1, body));
  });
});

describe('buildDeliveryHeaders / digestHeaders', () => {
  it('배달 계약 헤더를 모두 포함한다', () => {
    const headers = buildDeliveryHeaders({
      eventType: 'order.created',
      deliveryId: 'd-1',
      timestampSec: 1755075600,
      signature: 'v1=abc',
    });
    expect(headers['x-hookrelay-event']).toBe('order.created');
    expect(headers['x-delivery-id']).toBe('d-1');
    expect(headers['x-hookrelay-timestamp']).toBe('1755075600');
    expect(headers['x-hookrelay-signature']).toBe('v1=abc');
    expect(headers['content-type']).toBe('application/json');
  });

  it('digest는 키 순서와 무관하게 결정적이다', () => {
    const a = digestHeaders({ b: '2', a: '1' });
    const b = digestHeaders({ a: '1', b: '2' });
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });
});
