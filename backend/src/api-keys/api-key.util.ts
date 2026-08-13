import { createHash, randomBytes } from 'crypto';

/**
 * API 키 규격: sk_live_ + base64url 32바이트 (Stripe 관례).
 * 원문은 발급 응답에서 단 한 번 노출되고, DB에는 SHA-256 hex만 남는다 —
 * bcrypt가 아닌 이유: 키 자체가 256비트 무작위라 사전 공격이 무의미하고,
 * 요청마다 검증하므로 조회 비용이 일정해야 한다.
 */
export function generateApiKey(): { key: string; hash: string; last4: string } {
  const key = `sk_live_${randomBytes(32).toString('base64url')}`;
  return { key, hash: hashApiKey(key), last4: key.slice(-4) };
}

export function hashApiKey(key: string): string {
  return createHash('sha256').update(key).digest('hex');
}

/** endpoint HMAC 시크릿 규격: whsec_ + base64url 24바이트 */
export function generateEndpointSecret(): string {
  return `whsec_${randomBytes(24).toString('base64url')}`;
}
