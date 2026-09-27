import { BusRepositoryPort } from '../../domain/ports/bus-repository.port';
export declare class GetBusDetailUseCase {
    private readonly busRepository;
    constructor(busRepository: BusRepositoryPort);
    execute(busId: string): Promise<import("../../domain/entities/bus.entity").BusProps>;
}
