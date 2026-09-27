import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { FleetGateway } from './websocket/fleet.gateway';
import { RedisSubscriberService } from './subscriptions/redis-subscriber.service';
import { RedisSubscriberProvider } from '../shared/infrastructure/redis.provider';

@Module({
  imports: [ConfigModule],
  providers: [FleetGateway, RedisSubscriberService, RedisSubscriberProvider],
  exports: [FleetGateway],
})
export class RealtimeModule {}
