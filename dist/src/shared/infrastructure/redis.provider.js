"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.RedisSubscriberProvider = exports.RedisPublisherProvider = exports.REDIS_SUBSCRIBER_CLIENT = exports.REDIS_PUBLISHER_CLIENT = void 0;
const config_1 = require("@nestjs/config");
const ioredis_1 = require("ioredis");
exports.REDIS_PUBLISHER_CLIENT = Symbol('REDIS_PUBLISHER_CLIENT');
exports.REDIS_SUBSCRIBER_CLIENT = Symbol('REDIS_SUBSCRIBER_CLIENT');
function buildClient(config) {
    return new ioredis_1.default({
        host: config.get('REDIS_HOST', 'localhost'),
        port: config.get('REDIS_PORT', 6379),
    });
}
exports.RedisPublisherProvider = {
    provide: exports.REDIS_PUBLISHER_CLIENT,
    useFactory: (config) => buildClient(config),
    inject: [config_1.ConfigService],
};
exports.RedisSubscriberProvider = {
    provide: exports.REDIS_SUBSCRIBER_CLIENT,
    useFactory: (config) => buildClient(config),
    inject: [config_1.ConfigService],
};
//# sourceMappingURL=redis.provider.js.map