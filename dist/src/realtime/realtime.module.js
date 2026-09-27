"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.RealtimeModule = void 0;
const common_1 = require("@nestjs/common");
const config_1 = require("@nestjs/config");
const fleet_gateway_1 = require("./websocket/fleet.gateway");
const redis_subscriber_service_1 = require("./subscriptions/redis-subscriber.service");
const redis_provider_1 = require("../shared/infrastructure/redis.provider");
let RealtimeModule = class RealtimeModule {
};
exports.RealtimeModule = RealtimeModule;
exports.RealtimeModule = RealtimeModule = __decorate([
    (0, common_1.Module)({
        imports: [config_1.ConfigModule],
        providers: [fleet_gateway_1.FleetGateway, redis_subscriber_service_1.RedisSubscriberService, redis_provider_1.RedisSubscriberProvider],
        exports: [fleet_gateway_1.FleetGateway],
    })
], RealtimeModule);
//# sourceMappingURL=realtime.module.js.map