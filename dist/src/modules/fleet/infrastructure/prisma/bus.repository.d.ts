import { PrismaService } from '../../../../shared/infrastructure/prisma.service';
import { Bus } from '../../domain/entities/bus.entity';
import { BusRepositoryPort } from '../../domain/ports/bus-repository.port';
import { BusStatus } from '../../domain/value-objects/bus-status.enum';
export declare class PrismaBusRepository implements BusRepositoryPort {
    private readonly prisma;
    constructor(prisma: PrismaService);
    findAll(filter?: {
        status?: BusStatus;
    }): Promise<Bus[]>;
    findById(id: string): Promise<Bus | null>;
    findByDriver(driver: string): Promise<Bus | null>;
    save(bus: Bus): Promise<void>;
    appendPositionHistory(busId: string, latitude: number, longitude: number): Promise<void>;
    private toDomain;
}
