import { ConfigService } from '@nestjs/config';
import { GetOperativeHomeUseCase } from '../../application/use-cases/get-operative-home.use-case';
export declare class FleetHomeController {
    private readonly getOperativeHome;
    private readonly config;
    constructor(getOperativeHome: GetOperativeHomeUseCase, config: ConfigService);
    operativo(): Promise<import("../../application/dtos/operative-home.view").OperativeHomeView>;
}
