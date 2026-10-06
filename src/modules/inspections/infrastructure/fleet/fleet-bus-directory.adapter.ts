import { Injectable } from '@nestjs/common';
import { FleetQueryService } from '../../../fleet/public';
import { InspectionBusDirectoryPort } from '../../domain/ports/bus-directory.port';

/** Adapter hacia la flota: consulta a `fleet` solo por su API pública, nunca sus tablas. */
@Injectable()
export class FleetInspectionBusDirectory implements InspectionBusDirectoryPort {
  constructor(private readonly fleet: FleetQueryService) {}

  exists(busId: string): Promise<boolean> {
    return this.fleet.exists(busId);
  }

  async findBusIdOfDriver(userId: string): Promise<string | null> {
    return (await this.fleet.findByDriverId(userId))?.id ?? null;
  }
}
