import { Injectable } from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';
import { generateApiKey } from './api-key.util';

const GRACE_PERIOD_MS = 24 * 60 * 60 * 1000;

@Injectable()
export class ApiKeysService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * 키 회전 — 새 키를 발급하고 기존 ACTIVE 키를 GRACE(24h)로 강등한다.
   *
   * 즉시 REVOKED가 아닌 이유: 테넌트의 배포가 새 키로 전환되기 전까지의 공백에서
   * 프로덕션 트래픽이 전부 401로 떨어지는 사고를 막는 유예 창. 유예 만료 처리는
   * ApiKeyGuard가 조회 시점에 lazy하게 확정한다.
   */
  async rotate(tenantId: string) {
    const { key, hash, last4 } = generateApiKey();

    await this.prisma.$transaction([
      this.prisma.apiKey.updateMany({
        where: { tenantId, status: 'ACTIVE' },
        data: { status: 'GRACE', expiresAt: new Date(Date.now() + GRACE_PERIOD_MS) },
      }),
      this.prisma.apiKey.create({ data: { tenantId, keyHash: hash, last4 } }),
    ]);

    return { apiKey: key, apiKeyLast4: last4, graceHours: 24 };
  }
}
