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
Object.defineProperty(exports, "__esModule", { value: true });
exports.FleetHomeController = void 0;
const common_1 = require("@nestjs/common");
const config_1 = require("@nestjs/config");
const get_operative_home_use_case_1 = require("../../application/use-cases/get-operative-home.use-case");
let FleetHomeController = class FleetHomeController {
    constructor(getOperativeHome, config) {
        this.getOperativeHome = getOperativeHome;
        this.config = config;
    }
    operativo() {
        const driver = this.config.get('OPERATIVE_DEMO_DRIVER', 'Carlos Pérez');
        return this.getOperativeHome.execute(driver);
    }
};
exports.FleetHomeController = FleetHomeController;
__decorate([
    (0, common_1.Get)('operativo'),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", []),
    __metadata("design:returntype", void 0)
], FleetHomeController.prototype, "operativo", null);
exports.FleetHomeController = FleetHomeController = __decorate([
    (0, common_1.Controller)('fleet/home'),
    __metadata("design:paramtypes", [get_operative_home_use_case_1.GetOperativeHomeUseCase,
        config_1.ConfigService])
], FleetHomeController);
//# sourceMappingURL=fleet-home.controller.js.map