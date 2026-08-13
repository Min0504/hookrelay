import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';

/**
 * endpoint HMAC 시크릿의 저장용 암호화 (AES-256-GCM).
 *
 * 시크릿은 배달 때마다 서명 계산에 원문이 필요하므로 해시(단방향)로는 저장할 수 없다.
 * 대신 앱 레벨 암호화로 "DB 유출 ≠ 시크릿 유출"을 보장한다.
 * 마스터 키는 환경변수(HR_SECRET_KEY) — 운영에서는 KMS로 옮기는 발전 경로를 문서화.
 *
 * 포맷: v1:<iv b64>:<auth tag b64>:<ciphertext b64> — 버전 프리픽스는 키 회전 대비.
 */
@Injectable()
export class SecretCipher {
  private readonly key: Buffer;

  constructor(config: ConfigService) {
    this.key = Buffer.from(config.getOrThrow<string>('HR_SECRET_KEY'), 'base64');
  }

  encrypt(plaintext: string): string {
    // GCM의 IV는 12바이트가 표준 — 96비트를 넘기면 내부적으로 GHASH 한 번을 더 돈다
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `v1:${iv.toString('base64')}:${tag.toString('base64')}:${encrypted.toString('base64')}`;
  }

  decrypt(stored: string): string {
    const [version, ivB64, tagB64, dataB64] = stored.split(':');
    if (version !== 'v1' || !ivB64 || !tagB64 || !dataB64) {
      throw new Error('알 수 없는 시크릿 암호문 포맷입니다.');
    }
    const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(ivB64, 'base64'));
    decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64')), decipher.final()]).toString(
      'utf8',
    );
  }
}
