import { BusRepositoryPort } from '../../domain/ports/bus-repository.port';
import { OperativeHomeView } from '../dtos/operative-home.view';
export declare class GetOperativeHomeUseCase {
    private readonly busRepository;
    constructor(busRepository: BusRepositoryPort);
    execute(driver: string): Promise<OperativeHomeView>;
}
