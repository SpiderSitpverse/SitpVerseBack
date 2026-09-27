import { Bus } from '../entities/bus.entity';
import { BusStatus } from '../value-objects/bus-status.enum';

export const BUS_REPOSITORY = Symbol('BUS_REPOSITORY');

/**
 * Puerto (driven port): el dominio/aplicación depende de esta interfaz.
 * La implementación real (Prisma, in-memory para tests, etc.) vive en `infrastructure/`.
 */
export interface BusRepositoryPort {
  findAll(filter?: { status?: BusStatus }): Promise<Bus[]>;
  findById(id: string): Promise<Bus | null>;
  /**
   * Sin Identity real, usamos el nombre del conductor como "identidad" temporal
   * del usuario operativo (ver HU-96 / OPERATIVE_DEMO_DRIVER en .env).
   */
  findByDriver(driver: string): Promise<Bus | null>;
  save(bus: Bus): Promise<void>;
  appendPositionHistory(
    busId: string,
    latitude: number,
    longitude: number,
  ): Promise<void>;
}
