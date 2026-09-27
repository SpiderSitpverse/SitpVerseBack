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
var FleetSimulatorService_1;
Object.defineProperty(exports, "__esModule", { value: true });
exports.FleetSimulatorService = void 0;
const common_1 = require("@nestjs/common");
const config_1 = require("@nestjs/config");
const bus_repository_port_1 = require("../../domain/ports/bus-repository.port");
const bus_status_enum_1 = require("../../domain/value-objects/bus-status.enum");
const update_bus_position_use_case_1 = require("../../application/use-cases/update-bus-position.use-case");
let FleetSimulatorService = FleetSimulatorService_1 = class FleetSimulatorService {
    constructor(busRepository, updateBusPosition, config) {
        this.busRepository = busRepository;
        this.updateBusPosition = updateBusPosition;
        this.config = config;
        this.logger = new common_1.Logger(FleetSimulatorService_1.name);
    }
    onModuleInit() {
        const intervalMs = this.config.get('FLEET_SIMULATION_INTERVAL_MS', 3000);
        this.intervalHandle = setInterval(() => this.tick(), intervalMs);
        this.logger.log(`Simulador de flota activo cada ${intervalMs}ms (reemplazable por API real)`);
    }
    onModuleDestroy() {
        if (this.intervalHandle)
            clearInterval(this.intervalHandle);
    }
    async tick() {
        const activeBuses = await this.busRepository.findAll({
            status: bus_status_enum_1.BusStatus.IN_SERVICE,
        });
        for (const bus of activeBuses) {
            const [lat, lng] = this.nextPosition(bus.latitude, bus.longitude);
            try {
                await this.updateBusPosition.execute(bus.id, lat, lng);
            }
            catch (err) {
                this.logger.warn(`No se pudo actualizar ${bus.plate}: ${err}`);
            }
        }
    }
    nextPosition(lat, lng) {
        const baseLat = lat ?? 4.65;
        const baseLng = lng ?? -74.1;
        const jitter = () => (Math.random() - 0.5) * 0.002;
        return [baseLat + jitter(), baseLng + jitter()];
    }
};
exports.FleetSimulatorService = FleetSimulatorService;
exports.FleetSimulatorService = FleetSimulatorService = FleetSimulatorService_1 = __decorate([
    (0, common_1.Injectable)(),
    __param(0, (0, common_1.Inject)(bus_repository_port_1.BUS_REPOSITORY)),
    __metadata("design:paramtypes", [Object, update_bus_position_use_case_1.UpdateBusPositionUseCase,
        config_1.ConfigService])
], FleetSimulatorService);
//# sourceMappingURL=fleet-simulator.service.js.map