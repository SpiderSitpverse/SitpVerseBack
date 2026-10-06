import { Controller, Get } from '@nestjs/common';
import { Roles } from '../../../identity/public';
import { GetFleetSummaryUseCase } from '../../application/use-cases/manage-buses.use-cases';

/** Resumen de la flota para el panel principal. GET /fleet/summary */
@Controller('fleet/summary')
export class FleetSummaryController {
  constructor(private readonly summary: GetFleetSummaryUseCase) {}

  /** `{ total, inService, idle, finished }` */
  @Get()
  @Roles('ADMIN', 'MECHANICAL')
  get() {
    return this.summary.execute();
  }
}
