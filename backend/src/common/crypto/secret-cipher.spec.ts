import { ConfigService } from '@nestjs/config';
import { randomBytes } from 'crypto';
import { SecretCipher } from './secret-cipher';

describe('SecretCipher (AES-256-GCM)', () => {
  function makeCipher(key?: string): SecretCipher {
    return new SecretCipher(
      new ConfigService({ HR_SECRET_KEY: key ?? randomBytes(32).toString('base64') }),
    );
  }

  it('암호화 후 복호화하면 원문이 나온다', () => {
    const cipher = makeCipher();
    const secret = 'whsec_0123456789abcdef';
    expect(cipher.decrypt(cipher.encrypt(secret))).toBe(secret);
  });

  it('같은 평문도 매번 다른 암호문이 된다 (IV 무작위)', () => {
    const cipher = makeCipher();
    expect(cipher.encrypt('whsec_x')).not.toBe(cipher.encrypt('whsec_x'));
  });

  it('암호문이 변조되면 복호화가 실패한다 (GCM 무결성)', () => {
    const cipher = makeCipher();
    const stored = cipher.encrypt('whsec_x');
    const parts = stored.split(':');
    const tampered = Buffer.from(parts[3], 'base64');
    tampered[0] = tampered[0] ^ 0xff;
    parts[3] = tampered.toString('base64');
    expect(() => cipher.decrypt(parts.join(':'))).toThrow();
  });

  it('다른 마스터 키로는 복호화할 수 없다', () => {
    const stored = makeCipher().encrypt('whsec_x');
    expect(() => makeCipher().decrypt(stored)).toThrow();
  });
});
