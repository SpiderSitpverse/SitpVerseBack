"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.FleetModule = void 0;
const common_1 = require("@nestjs/common");
const config_1 = require("@nestjs/config");
const fleet_controller_1 = require("./adapters/http/fleet.controller");
const fleet_home_controller_1 = require("./adapters/http/fleet-home.controller");
const fleet_simulator_service_1 = require("./adapters/simulation/fleet-simulator.service");
const list_buses_use_case_1 = require("./application/use-cases/list-buses.use-case");
const get_bus_detail_use_case_1 = require("./application/use-cases/get-bus-detail.use-case");
const start_trip_use_case_1 = require("./application/use-cases/start-trip.use-case");
const update_bus_position_use_case_1 = require("./application/use-cases/update-bus-position.use-case");
const finish_trip_use_case_1 = require("./application/use-cases/finish-trip.use-case");
const get_operative_home_use_case_1 = require("./application/use-cases/get-operative-home.use-case");
const bus_repository_port_1 = require("./domain/ports/bus-repository.port");
const position_publisher_port_1 = require("./domain/ports/position-publisher.port");
const bus_repository_1 = require("./infrastructure/prisma/bus.repository");
const redis_position_publisher_1 = require("./infrastructure/redis/redis-position-publisher");
const prisma_service_1 = require("../../shared/infrastructure/prisma.service");
const redis_provider_1 = require("../../shared/infrastructure/redis.provider");
let FleetModule = class FleetModule {
};
exports.FleetModule = FleetModule;
exports.FleetModule = FleetModule = __decorate([
    (0, common_1.Module)({
        imports: [config_1.ConfigModule],
        controllers: [fleet_controller_1.FleetController, fleet_home_controller_1.FleetHomeController],
        providers: [
            prisma_service_1.PrismaService,
            redis_provider_1.RedisPublisherProvider,
            list_buses_use_case_1.ListBusesUseCase,
            get_bus_detail_use_case_1.GetBusDetailUseCase,
            start_trip_use_case_1.StartTripUseCase,
            update_bus_position_use_case_1.UpdateBusPositionUseCase,
            finish_trip_use_case_1.FinishTripUseCase,
            get_operative_home_use_case_1.GetOperativeHomeUseCase,
            fleet_simulator_service_1.FleetSimulatorService,
            { provide: bus_repository_port_1.BUS_REPOSITORY, useClass: bus_repository_1.PrismaBusRepository },
            { provide: position_publisher_port_1.POSITION_PUBLISHER, useClass: redis_position_publisher_1.RedisPositionPublisher },
        ],
        exports: [bus_repository_port_1.BUS_REPOSITORY],
    })
], FleetModule);
//# sourceMappingURL=fleet.module.js.map