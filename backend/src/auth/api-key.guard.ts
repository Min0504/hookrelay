import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Request } from 'express';
import { Errors } from '../common/errors/errors';
import { PrismaService } from '../common/prisma/prisma.service';
import { hashApiKey } from '../api-keys/api-key.util';

export interface AuthenticatedTenant {
  id: string;
  plan: string;
}

/**
 * 테넌트 API 인증 — Authorization: Bearer sk_live_...
 *
 * 키 원문은 저장하지 않으므로 조회는 SHA-256 해시로 한다. 회전 유예(GRACE) 키는
 * expires_at까지만 유효 — 만료를 지난 GRACE 키는 이 자리에서 REVOKED로 확정한다
 * (별도 청소 배치 없이도 상태가 수렴하는 lazy 정리).
 */
@Injectable()
export class ApiKeyGuard implements CanActivate {
  constructor(private readonly prisma: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<Request & { tenant?: AuthenticatedTenant }>();
    const header = req.header('authorization') ?? '';
    const key = header.startsWith('Bearer ') ? header.slice('Bearer '.length) : '';
    if (!key.startsWith('sk_live_')) {
      throw Errors.invalidApiKey();
    }

    const apiKey = await this.prisma.apiKey.findUnique({
      where: { keyHash: hashApiKey(key) },
      include: { tenant: true },
    });
    if (apiKey === null || apiKey.status === 'REVOKED') {
      throw Errors.invalidApiKey();
    }
    if (apiKey.status === 'GRACE') {
      if (apiKey.expiresAt === null || apiKey.expiresAt.getTime() <= Date.now()) {
        await this.prisma.apiKey.update({ where: { id: apiKey.id }, data: { status: 'REVOKED' } });
        throw Errors.invalidApiKey();
      }
    }
    if (apiKey.tenant.status !== 'ACTIVE') {
      throw Errors.tenantSuspended();
    }

    req.tenant = { id: apiKey.tenantId, plan: apiKey.tenant.plan };
    return true;
  }
}
