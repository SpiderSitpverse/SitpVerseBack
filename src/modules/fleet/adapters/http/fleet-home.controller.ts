import { Controller, Get } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { GetOperativeHomeUseCase } from '../../application/use-cases/get-operative-home.use-case';

/**
 * Home para usuarios operativos.
 * GET /fleet/home/operativo
 */
@Controller('fleet/home')
export class FleetHomeController {
  constructor(
    private readonly getOperativeHome: GetOperativeHomeUseCase,
    private readonly config: ConfigService,
  ) {}

  @Get('operativo')
  operativo() {
    const driver = this.config.get<string>(
      'OPERATIVE_DEMO_DRIVER',
      'Carlos Pérez',
    );
    return this.getOperativeHome.execute(driver);
  }
}