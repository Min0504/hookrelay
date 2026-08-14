import { Injectable } from '@nestjs/common';
import { EndpointStatus } from '@prisma/client';
import { SecretCipher } from '../common/crypto/secret-cipher';
import { PrismaService } from '../common/prisma/prisma.service';

export interface EndpointConfig {
  url: string;
  secret: string;
  status: EndpointStatus;
}

/**
 * endpoint 설정의 워커 메모리 캐시 (TTL 30초).
 *
 * 배달마다 endpoint 조회 + 시크릿 복호화를 반복하면 DB와 CPU를 모두 낭비한다 —
 * endpoint 설정은 거의 변하지 않으므로 짧은 TTL 캐시로 배달 경로에서 제거한다.
 * 트레이드오프: URL·상태 변경이 최대 30초 늦게 반영된다. 배달은 at-least-once
 * 세계라 이 지연은 수용 가능하고, 캐시 무효화 브로드캐스트보다 훨씬 단순하다.
 */
@Injectable()
export class EndpointCache {
  private static readonly TTL_MS = 30_000;
  private readonly entries = new Map<string, { value: EndpointConfig; expiresAt: number }>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly cipher: SecretCipher,
  ) {}

  async get(endpointId: string): Promise<EndpointConfig | null> {
    const cached = this.entries.get(endpointId);
    if (cached && cached.expiresAt > Date.now()) return cached.value;

    const endpoint = await this.prisma.endpoint.findUnique({
      where: { id: endpointId },
      select: { url: true, secretEnc: true, status: true },
    });
    if (!endpoint) return null;

    const value: EndpointConfig = {
      url: endpoint.url,
      secret: this.cipher.decrypt(endpoint.secretEnc),
      status: endpoint.status,
    };
    this.entries.set(endpointId, { value, expiresAt: Date.now() + EndpointCache.TTL_MS });
    return value;
  }

  /** 테스트·수동 무효화용 */
  invalidate(endpointId?: string): void {
    if (endpointId) this.entries.delete(endpointId);
    else this.entries.clear();
  }
}
