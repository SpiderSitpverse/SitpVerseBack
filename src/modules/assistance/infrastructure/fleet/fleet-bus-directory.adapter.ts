import { Injectable } from '@nestjs/common';
import { FleetQueryService } from '../../../fleet/public';
import { BusInfo } from '../../domain/models/assistance.models';
import { BusDirectoryPort, BusRef } from '../../domain/ports/bus-directory.port';

/**
 * Adapter hacia la flota: consulta a `fleet` SOLO por su API pública (`fleet/public.ts`),
 * nunca sus tablas. Es la costura si la flota pasa a ser otro servicio.
 */
@Injectable()
export class FleetBusDirectory implements BusDirectoryPort {
  constructor(private readonly fleet: FleetQueryService) {}

  exists(busId: string): Promise<boolean> {
    return this.fleet.exists(busId);
  }

  findBusOfDriver(userId: string): Promise<BusRef | null> {
    return this.fleet.findByDriverId(userId);
  }

  describe(busIds: string[]): Promise<Map<string, BusInfo>> {
    return this.fleet.describe(busIds); // BusDescription de fleet ya tiene la forma de BusInfo
  }
}
