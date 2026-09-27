import { BusRepositoryPort } from '../../domain/ports/bus-repository.port';
import { PositionPublisherPort } from '../../domain/ports/position-publisher.port';
export declare class FinishTripUseCase {
    private readonly busRepository;
    private readonly positionPublisher;
    constructor(busRepository: BusRepositoryPort, positionPublisher: PositionPublisherPort);
    execute(busId: string): Promise<import("../../domain/entities/bus.entity").BusProps>;
}
