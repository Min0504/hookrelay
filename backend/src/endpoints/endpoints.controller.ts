import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Put, UseGuards } from '@nestjs/common';
import { ApiKeyGuard, AuthenticatedTenant } from '../auth/api-key.guard';
import { CurrentTenant } from '../auth/current-tenant.decorator';
import { CreateEndpointDto, SetSubscriptionsDto, UpdateEndpointDto } from './dto/endpoint.dtos';
import { EndpointsService } from './endpoints.service';

@Controller('endpoints')
@UseGuards(ApiKeyGuard)
export class EndpointsController {
  constructor(private readonly endpoints: EndpointsService) {}

  @Post()
  create(@CurrentTenant() tenant: AuthenticatedTenant, @Body() dto: CreateEndpointDto) {
    return this.endpoints.create(tenant.id, dto);
  }

  @Get()
  list(@CurrentTenant() tenant: AuthenticatedTenant) {
    return this.endpoints.list(tenant.id);
  }

  @Get(':id')
  get(@CurrentTenant() tenant: AuthenticatedTenant, @Param('id', ParseUUIDPipe) id: string) {
    return this.endpoints.get(tenant.id, id);
  }

  @Patch(':id')
  update(
    @CurrentTenant() tenant: AuthenticatedTenant,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateEndpointDto,
  ) {
    return this.endpoints.update(tenant.id, id, dto);
  }

  @Put(':id/subscriptions')
  setSubscriptions(
    @CurrentTenant() tenant: AuthenticatedTenant,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SetSubscriptionsDto,
  ) {
    return this.endpoints.setSubscriptions(tenant.id, id, dto.eventTypes);
  }

  @Post(':id/ping')
  ping(@CurrentTenant() tenant: AuthenticatedTenant, @Param('id', ParseUUIDPipe) id: string) {
    return this.endpoints.ping(tenant.id, id);
  }
}
