import { Bus } from '../entities/bus.entity';
import { BusStatus } from '../value-objects/bus-status.enum';

export const BUS_REPOSITORY = Symbol('BUS_REPOSITORY');

/**
 * Puerto (driven port): el dominio/aplicación depende de esta interfaz.
 * La implementación real (Prisma, in-memory para tests, etc.) vive en `infrastructure/`.
 */
export interface BusRepositoryPort {
  findAll(filter?: { status?: BusStatus; driverId?: string }): Promise<Bus[]>;
  findById(id: string): Promise<Bus | null>;
  /** El bus asignado a un conductor (relación 1 a 1 con el usuario de `identity`). */
  findByDriverId(driverId: string): Promise<Bus | null>;
  /**
   * Guarda el bus con compare-and-set sobre `bus.expectedStatus`: si el estado en BD ya no
   * es el que se leyó (p. ej. terminó el viaje mientras llegaba una posición), lanza
   * `ConflictError` y NO sobrescribe. Evita resucitar buses y dobles inicios de viaje.
   */
  save(bus: Bus): Promise<void>;
  appendPositionHistory(
    busId: string,
    latitude: number,
    longitude: number,
  ): Promise<void>;
}
