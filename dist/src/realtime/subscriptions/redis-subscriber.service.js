"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
var __param = (this && this.__param) || function (paramIndex, decorator) {
    return function (target, key) { decorator(target, key, paramIndex); }
};
var RedisSubscriberService_1;
Object.defineProperty(exports, "__esModule", { value: true });
exports.RedisSubscriberService = void 0;
const common_1 = require("@nestjs/common");
const ioredis_1 = require("ioredis");
const redis_provider_1 = require("../../shared/infrastructure/redis.provider");
const redis_position_publisher_1 = require("../../modules/fleet/infrastructure/redis/redis-position-publisher");
const fleet_gateway_1 = require("../websocket/fleet.gateway");
let RedisSubscriberService = RedisSubscriberService_1 = class RedisSubscriberService {
    constructor(redisSubscriber, fleetGateway) {
        this.redisSubscriber = redisSubscriber;
        this.fleetGateway = fleetGateway;
        this.logger = new common_1.Logger(RedisSubscriberService_1.name);
    }
    async onModuleInit() {
        await this.redisSubscriber.subscribe(redis_position_publisher_1.FLEET_POSITIONS_CHANNEL);
        this.redisSubscriber.on('message', (channel, message) => {
            if (channel !== redis_position_publisher_1.FLEET_POSITIONS_CHANNEL)
                return;
            try {
                const event = JSON.parse(message);
                this.fleetGateway.broadcastPositionUpdate(event);
            }
            catch (err) {
                this.logger.error(`Evento inválido en ${channel}: ${err}`);
            }
        });
        this.logger.log(`Suscrito a canal Redis "${redis_position_publisher_1.FLEET_POSITIONS_CHANNEL}"`);
    }
};
exports.RedisSubscriberService = RedisSubscriberService;
exports.RedisSubscriberService = RedisSubscriberService = RedisSubscriberService_1 = __decorate([
    (0, common_1.Injectable)(),
    __param(0, (0, common_1.Inject)(redis_provider_1.REDIS_SUBSCRIBER_CLIENT)),
    __metadata("design:paramtypes", [ioredis_1.default,
        fleet_gateway_1.FleetGateway])
], RedisSubscriberService);
//# sourceMappingURL=redis-subscriber.service.js.map