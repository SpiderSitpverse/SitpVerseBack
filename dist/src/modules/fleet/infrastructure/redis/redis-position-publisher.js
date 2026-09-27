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
Object.defineProperty(exports, "__esModule", { value: true });
exports.RedisPositionPublisher = exports.FLEET_POSITIONS_CHANNEL = void 0;
const common_1 = require("@nestjs/common");
const ioredis_1 = require("ioredis");
const redis_provider_1 = require("../../../../shared/infrastructure/redis.provider");
exports.FLEET_POSITIONS_CHANNEL = 'fleet:positions';
let RedisPositionPublisher = class RedisPositionPublisher {
    constructor(redis) {
        this.redis = redis;
    }
    async publish(event) {
        await this.redis.publish(exports.FLEET_POSITIONS_CHANNEL, JSON.stringify(event));
    }
};
exports.RedisPositionPublisher = RedisPositionPublisher;
exports.RedisPositionPublisher = RedisPositionPublisher = __decorate([
    (0, common_1.Injectable)(),
    __param(0, (0, common_1.Inject)(redis_provider_1.REDIS_PUBLISHER_CLIENT)),
    __metadata("design:paramtypes", [ioredis_1.default])
], RedisPositionPublisher);
//# sourceMappingURL=redis-position-publisher.js.map