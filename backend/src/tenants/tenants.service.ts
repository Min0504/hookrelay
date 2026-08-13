import { Injectable } from '@nestjs/common';
import { Errors } from '../common/errors/errors';
import { PrismaService } from '../common/prisma/prisma.service';
import { generateApiKey } from '../api-keys/api-key.util';

@Injectable()
export class TenantsService {
  constructor(private readonly prisma: PrismaService) {}

  /** 테넌트 생성 + 첫 API 키 발급 — 키 원문은 이 응답에서만 노출된다. */
  async create(name: string, plan: 'FREE' | 'PRO') {
    const exists = await this.prisma.tenant.findUnique({ where: { name } });
    if (exists !== null) {
      throw Errors.tenantNameExists();
    }

    const { key, hash, last4 } = generateApiKey();
    const tenant = await this.prisma.tenant.create({
      data: {
        name,
        plan,
        apiKeys: { create: { keyHash: hash, last4 } },
      },
    });

    return {
      tenantId: tenant.id,
      name: tenant.name,
      plan: tenant.plan,
      apiKey: key,
      apiKeyLast4: last4,
    };
  }
}
