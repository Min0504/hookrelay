import { Controller, Post, UseGuards } from '@nestjs/common';
import { ApiKeyGuard, AuthenticatedTenant } from '../auth/api-key.guard';
import { CurrentTenant } from '../auth/current-tenant.decorator';
import { ApiKeysService } from './api-keys.service';

@Controller('api-keys')
@UseGuards(ApiKeyGuard)
export class ApiKeysController {
  constructor(private readonly apiKeys: ApiKeysService) {}

  @Post('rotate')
  rotate(@CurrentTenant() tenant: AuthenticatedTenant) {
    return this.apiKeys.rotate(tenant.id);
  }
}
