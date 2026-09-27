import { Bus } from '../entities/bus.entity';
import { BusStatus } from '../value-objects/bus-status.enum';
export declare const BUS_REPOSITORY: unique symbol;
export interface BusRepositoryPort {
    findAll(filter?: {
        status?: BusStatus;
    }): Promise<Bus[]>;
    findById(id: string): Promise<Bus | null>;
    findByDriver(driver: string): Promise<Bus | null>;
    save(bus: Bus): Promise<void>;
    appendPositionHistory(busId: string, latitude: number, longitude: number): Promise<void>;
}
