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
var FleetGateway_1;
Object.defineProperty(exports, "__esModule", { value: true });
exports.FleetGateway = exports.FLEET_POSITION_EVENT = void 0;
const websockets_1 = require("@nestjs/websockets");
const common_1 = require("@nestjs/common");
const socket_io_1 = require("socket.io");
exports.FLEET_POSITION_EVENT = 'fleet:position-updated';
let FleetGateway = FleetGateway_1 = class FleetGateway {
    constructor() {
        this.logger = new common_1.Logger(FleetGateway_1.name);
    }
    handleConnection(client) {
        this.logger.log(`Cliente conectado: ${client.id}`);
    }
    handleDisconnect(client) {
        this.logger.log(`Cliente desconectado: ${client.id}`);
    }
    broadcastPositionUpdate(event) {
        this.server.emit(exports.FLEET_POSITION_EVENT, event);
    }
};
exports.FleetGateway = FleetGateway;
__decorate([
    (0, websockets_1.WebSocketServer)(),
    __metadata("design:type", socket_io_1.Server)
], FleetGateway.prototype, "server", void 0);
exports.FleetGateway = FleetGateway = FleetGateway_1 = __decorate([
    (0, websockets_1.WebSocketGateway)({
        namespace: 'realtime',
        cors: { origin: process.env.CORS_ORIGIN ?? '*' },
    })
], FleetGateway);
//# sourceMappingURL=fleet.gateway.js.map