import { OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { BusRepositoryPort } from '../../domain/ports/bus-repository.port';
import { UpdateBusPositionUseCase } from '../../application/use-cases/update-bus-position.use-case';
export declare class FleetSimulatorService implements OnModuleInit, OnModuleDestroy {
    private readonly busRepository;
    private readonly updateBusPosition;
    private readonly config;
    private readonly logger;
    private intervalHandle?;
    constructor(busRepository: BusRepositoryPort, updateBusPosition: UpdateBusPositionUseCase, config: ConfigService);
    onModuleInit(): void;
    onModuleDestroy(): void;
    private tick;
    private nextPosition;
}
