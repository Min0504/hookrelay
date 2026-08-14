import { Module } from '@nestjs/common';
import { EventsController } from './events.controller';
import { EventsService } from './events.service';
import { PublishRateLimiter } from './publish-rate-limiter';

@Module({
  controllers: [EventsController],
  providers: [EventsService, PublishRateLimiter],
})
export class EventsModule {}
