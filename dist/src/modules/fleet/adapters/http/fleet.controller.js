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
exports.FleetController = void 0;
const common_1 = require("@nestjs/common");
const list_buses_use_case_1 = require("../../application/use-cases/list-buses.use-case");
const get_bus_detail_use_case_1 = require("../../application/use-cases/get-bus-detail.use-case");
const start_trip_use_case_1 = require("../../application/use-cases/start-trip.use-case");
const update_bus_position_use_case_1 = require("../../application/use-cases/update-bus-position.use-case");
const finish_trip_use_case_1 = require("../../application/use-cases/finish-trip.use-case");
const list_buses_dto_1 = require("../../application/dtos/list-buses.dto");
const update_position_dto_1 = require("../../application/dtos/update-position.dto");
let FleetController = class FleetController {
    constructor(listBuses, getBusDetail, startTrip, updatePosition, finishTrip) {
        this.listBuses = listBuses;
        this.getBusDetail = getBusDetail;
        this.startTrip = startTrip;
        this.updatePosition = updatePosition;
        this.finishTrip = finishTrip;
    }
    findAll(query) {
        return this.listBuses.execute(query.status);
    }
    findOne(id) {
        return this.getBusDetail.execute(id);
    }
    start(id) {
        return this.startTrip.execute(id);
    }
    updatePos(id, body) {
        return this.updatePosition.execute(id, body.latitude, body.longitude);
    }
    finish(id) {
        return this.finishTrip.execute(id);
    }
};
exports.FleetController = FleetController;
__decorate([
    (0, common_1.Get)(),
    __param(0, (0, common_1.Query)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [list_buses_dto_1.ListBusesDto]),
    __metadata("design:returntype", void 0)
], FleetController.prototype, "findAll", null);
__decorate([
    (0, common_1.Get)(':id'),
    __param(0, (0, common_1.Param)('id')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String]),
    __metadata("design:returntype", void 0)
], FleetController.prototype, "findOne", null);
__decorate([
    (0, common_1.Patch)(':id/start-trip'),
    __param(0, (0, common_1.Param)('id')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String]),
    __metadata("design:returntype", void 0)
], FleetController.prototype, "start", null);
__decorate([
    (0, common_1.Patch)(':id/position'),
    __param(0, (0, common_1.Param)('id')),
    __param(1, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, update_position_dto_1.UpdatePositionDto]),
    __metadata("design:returntype", void 0)
], FleetController.prototype, "updatePos", null);
__decorate([
    (0, common_1.Patch)(':id/finish-trip'),
    __param(0, (0, common_1.Param)('id')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String]),
    __metadata("design:returntype", void 0)
], FleetController.prototype, "finish", null);
exports.FleetController = FleetController = __decorate([
    (0, common_1.Controller)('fleet/buses'),
    __metadata("design:paramtypes", [list_buses_use_case_1.ListBusesUseCase,
        get_bus_detail_use_case_1.GetBusDetailUseCase,
        start_trip_use_case_1.StartTripUseCase,
        update_bus_position_use_case_1.UpdateBusPositionUseCase,
        finish_trip_use_case_1.FinishTripUseCase])
], FleetController);
//# sourceMappingURL=fleet.controller.js.map