import Redis from 'ioredis';
import { BusPositionEvent, PositionPublisherPort } from '../../domain/ports/position-publisher.port';
export declare const FLEET_POSITIONS_CHANNEL = "fleet:positions";
export declare class RedisPositionPublisher implements PositionPublisherPort {
    private readonly redis;
    constructor(redis: Redis);
    publish(event: BusPositionEvent): Promise<void>;
}
