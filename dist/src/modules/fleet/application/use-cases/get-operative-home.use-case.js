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
exports.GetOperativeHomeUseCase = void 0;
const common_1 = require("@nestjs/common");
const bus_repository_port_1 = require("../../domain/ports/bus-repository.port");
const bus_status_enum_1 = require("../../domain/value-objects/bus-status.enum");
let GetOperativeHomeUseCase = class GetOperativeHomeUseCase {
    constructor(busRepository) {
        this.busRepository = busRepository;
    }
    async execute(driver) {
        const bus = await this.busRepository.findByDriver(driver);
        if (!bus) {
            throw new common_1.NotFoundException(`No hay un bus asignado al operativo "${driver}"`);
        }
        return {
            busId: bus.id,
            plate: bus.plate,
            route: bus.route,
            status: bus.status,
            hasActiveTrip: bus.status === bus_status_enum_1.BusStatus.IN_SERVICE,
            latitude: bus.latitude,
            longitude: bus.longitude,
            updatedAt: bus.updatedAt.toISOString(),
        };
    }
};
exports.GetOperativeHomeUseCase = GetOperativeHomeUseCase;
exports.GetOperativeHomeUseCase = GetOperativeHomeUseCase = __decorate([
    (0, common_1.Injectable)(),
    __param(0, (0, common_1.Inject)(bus_repository_port_1.BUS_REPOSITORY)),
    __metadata("design:paramtypes", [Object])
], GetOperativeHomeUseCase);
//# sourceMappingURL=get-operative-home.use-case.js.map