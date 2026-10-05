import { Inject, Injectable } from '@nestjs/common';
import {
  BUS_REPOSITORY,
  BusRepositoryPort,
} from '../../domain/ports/bus-repository.port';

export interface BusSummary {
  id: string;
  plate: string;
}

/**
 * API de LECTURA que `fleet` ofrece a otros módulos (se exporta en `fleet/public.ts`).
 * Es la única puerta: nadie más lee las tablas de flota directamente.
 */
@Injectable()
export class FleetQueryService {
  constructor(@Inject(BUS_REPOSITORY) private readonly busRepository: BusRepositoryPort) {}

  async exists(busId: string): Promise<boolean> {
    return (await this.busRepository.findById(busId)) !== null;
  }

  async findByDriverId(driverId: string): Promise<BusSummary | null> {
    const bus = await this.busRepository.findByDriverId(driverId);
    return bus ? { id: bus.id, plate: bus.plate } : null;
  }
}
