import { Inject, Injectable } from '@nestjs/common';
import { BUS_REPOSITORY, BusRepositoryPort } from '../../domain/ports/bus-repository.port';

export interface BusSummary {
  id: string;
  plate: string;
}

/** Lo que otros módulos pueden mostrar de un bus (placa, troncal, ubicación...). */
export interface BusDescription {
  id: string;
  plate: string;
  /** Troncal o ruta del bus. */
  route: string;
  locationLabel: string | null;
  latitude: number | null;
  longitude: number | null;
  driverName: string | null;
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

  /** Describe varios buses de una vez (una sola consulta), para enriquecer listados de otros módulos. */
  async describe(busIds: string[]): Promise<Map<string, BusDescription>> {
    const buses = await this.busRepository.findManyByIds([...new Set(busIds)]);
    return new Map(
      buses.map((bus) => [
        bus.id,
        {
          id: bus.id,
          plate: bus.plate,
          route: bus.route,
          locationLabel: bus.toPersistence().locationLabel ?? null,
          latitude: bus.latitude,
          longitude: bus.longitude,
          driverName: bus.driver,
        },
      ]),
    );
  }
}
