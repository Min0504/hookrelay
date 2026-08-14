import { Controller, DefaultValuePipe, Get, Param, ParseUUIDPipe, Post, Query, UseGuards } from '@nestjs/common';
import { DeliveryStatus } from '@prisma/client';
import { ApiKeyGuard, AuthenticatedTenant } from '../auth/api-key.guard';
import { CurrentTenant } from '../auth/current-tenant.decorator';
import { DeliveriesService } from './deliveries.service';

const STATUSES = new Set<string>(Object.values(DeliveryStatus));

@Controller('deliveries')
@UseGuards(ApiKeyGuard)
export class DeliveriesController {
  constructor(private readonly deliveries: DeliveriesService) {}

  @Get()
  list(
    @CurrentTenant() tenant: AuthenticatedTenant,
    @Query('status') status?: string,
    @Query('cursor', new DefaultValuePipe(undefined)) cursor?: string,
  ) {
    const parsed = status && STATUSES.has(status) ? (status as DeliveryStatus) : undefined;
    return this.deliveries.list(tenant.id, parsed, cursor);
  }

  @Get(':id/attempts')
  attempts(@CurrentTenant() tenant: AuthenticatedTenant, @Param('id', ParseUUIDPipe) id: string) {
    return this.deliveries.attempts(tenant.id, id);
  }

  @Post(':id/redeliver')
  redeliver(@CurrentTenant() tenant: AuthenticatedTenant, @Param('id', ParseUUIDPipe) id: string) {
    return this.deliveries.redeliver(tenant.id, id);
  }
}
