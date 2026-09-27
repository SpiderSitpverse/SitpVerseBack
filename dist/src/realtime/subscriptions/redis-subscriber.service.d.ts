import { OnModuleInit } from '@nestjs/common';
import Redis from 'ioredis';
import { FleetGateway } from '../websocket/fleet.gateway';
export declare class RedisSubscriberService implements OnModuleInit {
    private readonly redisSubscriber;
    private readonly fleetGateway;
    private readonly logger;
    constructor(redisSubscriber: Redis, fleetGateway: FleetGateway);
    onModuleInit(): Promise<void>;
}
