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
exports.PrismaBusRepository = void 0;
const common_1 = require("@nestjs/common");
const prisma_service_1 = require("../../../../shared/infrastructure/prisma.service");
const bus_entity_1 = require("../../domain/entities/bus.entity");
let PrismaBusRepository = class PrismaBusRepository {
    constructor(prisma) {
        this.prisma = prisma;
    }
    async findAll(filter) {
        const rows = await this.prisma.bus.findMany({
            where: filter?.status
                ? { status: filter.status }
                : undefined,
            orderBy: { updatedAt: 'desc' },
        });
        return rows.map(this.toDomain);
    }
    async findById(id) {
        const row = await this.prisma.bus.findUnique({ where: { id } });
        return row ? this.toDomain(row) : null;
    }
    async findByDriver(driver) {
        const row = await this.prisma.bus.findFirst({ where: { driver } });
        return row ? this.toDomain(row) : null;
    }
    async save(bus) {
        const props = bus.toPersistence();
        await this.prisma.bus.update({
            where: { id: props.id },
            data: {
                status: props.status,
                latitude: props.latitude,
                longitude: props.longitude,
            },
        });
    }
    async appendPositionHistory(busId, latitude, longitude) {
        await this.prisma.busPosition.create({
            data: { busId, latitude, longitude },
        });
    }
    toDomain(row) {
        return bus_entity_1.Bus.fromPersistence({
            id: row.id,
            plate: row.plate,
            route: row.route,
            driver: row.driver,
            status: row.status,
            latitude: row.latitude,
            longitude: row.longitude,
            updatedAt: row.updatedAt,
        });
    }
};
exports.PrismaBusRepository = PrismaBusRepository;
exports.PrismaBusRepository = PrismaBusRepository = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [prisma_service_1.PrismaService])
], PrismaBusRepository);
//# sourceMappingURL=bus.repository.js.map