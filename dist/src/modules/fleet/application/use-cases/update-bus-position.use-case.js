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
exports.UpdateBusPositionUseCase = void 0;
const common_1 = require("@nestjs/common");
const bus_repository_port_1 = require("../../domain/ports/bus-repository.port");
const position_publisher_port_1 = require("../../domain/ports/position-publisher.port");
let UpdateBusPositionUseCase = class UpdateBusPositionUseCase {
    constructor(busRepository, positionPublisher) {
        this.busRepository = busRepository;
        this.positionPublisher = positionPublisher;
    }
    async execute(busId, latitude, longitude) {
        const bus = await this.busRepository.findById(busId);
        if (!bus) {
            throw new common_1.NotFoundException(`Bus ${busId} no encontrado`);
        }
        bus.updatePosition(latitude, longitude);
        await this.busRepository.save(bus);
        await this.busRepository.appendPositionHistory(busId, latitude, longitude);
        await this.positionPublisher.publish({
            busId: bus.id,
            plate: bus.plate,
            route: bus.route,
            status: bus.status,
            latitude,
            longitude,
            updatedAt: bus.updatedAt.toISOString(),
        });
        return bus.toPersistence();
    }
};
exports.UpdateBusPositionUseCase = UpdateBusPositionUseCase;
exports.UpdateBusPositionUseCase = UpdateBusPositionUseCase = __decorate([
    (0, common_1.Injectable)(),
    __param(0, (0, common_1.Inject)(bus_repository_port_1.BUS_REPOSITORY)),
    __param(1, (0, common_1.Inject)(position_publisher_port_1.POSITION_PUBLISHER)),
    __metadata("design:paramtypes", [Object, Object])
], UpdateBusPositionUseCase);
//# sourceMappingURL=update-bus-position.use-case.js.map