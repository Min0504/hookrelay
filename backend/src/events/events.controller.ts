import { Body, Controller, Get, Headers, HttpCode, Param, ParseUUIDPipe, Post, UseGuards } from '@nestjs/common';
import { ApiKeyGuard, AuthenticatedTenant } from '../auth/api-key.guard';
import { CurrentTenant } from '../auth/current-tenant.decorator';
import { Errors } from '../common/errors/errors';
import { eventsPublishedTotal } from '../metrics/registry';
import { PublishEventDto } from './dto/publish-event.dto';
import { EventsService } from './events.service';
import { PublishRateLimiter } from './publish-rate-limiter';

@Controller('events')
@UseGuards(ApiKeyGuard)
export class EventsController {
  constructor(
    private readonly events: EventsService,
    private readonly rateLimiter: PublishRateLimiter,
  ) {}

  /**
   * 202 Accepted — 배달은 비동기다. "접수 완료"와 "배달 완료"는 다른 사건이므로
   * 201이 아니라 202를 반환하고, 완료 확인은 GET /events/:id/deliveries로 한다.
   */
  @Post()
  @HttpCode(202)
  async publish(
    @CurrentTenant() tenant: AuthenticatedTenant,
    @Body() dto: PublishEventDto,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    if (!idempotencyKey || idempotencyKey.trim().length === 0 || idempotencyKey.length > 255) {
      throw Errors.idempotencyKeyRequired();
    }
    await this.rateLimiter.consume(tenant.id, tenant.plan);
    const result = await this.events.publish(tenant.id, dto, idempotencyKey);
    eventsPublishedTotal.inc();
    return result;
  }

  @Get(':id/deliveries')
  deliveries(@CurrentTenant() tenant: AuthenticatedTenant, @Param('id', ParseUUIDPipe) id: string) {
    return this.events.getDeliveries(tenant.id, id);
  }
}
