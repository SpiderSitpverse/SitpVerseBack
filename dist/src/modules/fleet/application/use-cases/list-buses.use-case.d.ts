import { BusRepositoryPort } from '../../domain/ports/bus-repository.port';
import { BusStatus } from '../../domain/value-objects/bus-status.enum';
export declare class ListBusesUseCase {
    private readonly busRepository;
    constructor(busRepository: BusRepositoryPort);
    execute(status?: BusStatus): Promise<import("../../domain/entities/bus.entity").BusProps[]>;
}
