import { ConflictError } from '../../../../shared/domain/errors';
import { BusStatus } from '../value-objects/bus-status.enum';

export interface BusProps {
  id: string;
  plate: string;
  route: string;
  /** Conductor asignado (id en `identity`); permite autorizar "solo opera SU bus". */
  driverId?: string | null;
  /** Nombre del conductor, solo para mostrar. */
  driver?: string | null;
  status: BusStatus;
  latitude?: number | null;
  longitude?: number | null;
  /** Ficha del vehículo (registro de flota). */
  model?: string | null;
  year?: number | null;
  operator?: string | null;
  capacity?: number | null;
  /** Referencia legible de dónde está (p. ej. "Calle 26"). */
  locationLabel?: string | null;
  /** Cuándo salió en su viaje actual (se fija en `startTrip`). */
  tripStartedAt?: Date | null;
  updatedAt: Date;
}

/** Datos de la ficha que el administrador puede editar. */
export interface BusDetails {
  plate?: string;
  route?: string;
  model?: string | null;
  year?: number | null;
  operator?: string | null;
  capacity?: number | null;
  locationLabel?: string | null;
}

/**
 * Entidad de dominio pura: no conoce Prisma, ni HTTP, ni Redis.
 * Toda regla de negocio sobre "qué puede hacer un bus" vive acá.
 */
export class Bus {
  /**
   * Estado con el que se cargó de la base de datos. El repositorio lo usa para guardar
   * con compare-and-set (`WHERE status = <este>`): si otro proceso cambió el estado mientras
   * tanto, el guardado se rechaza en lugar de pisar el cambio ajeno (lost update).
   */
  private readonly statusWhenLoaded: BusStatus;

  private constructor(private props: BusProps) {
    this.statusWhenLoaded = props.status;
  }

  static fromPersistence(props: BusProps): Bus {
    return new Bus(props);
  }

  get id() {
    return this.props.id;
  }
  get plate() {
    return this.props.plate;
  }
  get route() {
    return this.props.route;
  }
  get driver() {
    return this.props.driver ?? null;
  }
  get driverId() {
    return this.props.driverId ?? null;
  }
  get status() {
    return this.props.status;
  }
  get latitude() {
    return this.props.latitude ?? null;
  }
  get longitude() {
    return this.props.longitude ?? null;
  }
  get updatedAt() {
    return this.props.updatedAt;
  }
  get expectedStatus() {
    return this.statusWhenLoaded;
  }

  /** HU-49: reportar inicio de viaje */
  startTrip(): void {
    if (this.props.status === BusStatus.IN_SERVICE) {
      throw new BusAlreadyInServiceError(this.props.plate);
    }
    this.props.status = BusStatus.IN_SERVICE;
    this.props.tripStartedAt = new Date();
    this.props.updatedAt = new Date();
  }

  /** HU-49: actualizar posición en tiempo real (solo si está en servicio) */
  updatePosition(latitude: number, longitude: number): void {
    if (this.props.status !== BusStatus.IN_SERVICE) {
      throw new BusNotInServiceError(this.props.plate);
    }
    this.props.latitude = latitude;
    this.props.longitude = longitude;
    this.props.updatedAt = new Date();
  }

  /** HU-51: finalizar servicio/viaje del bus */
  finishTrip(): void {
    if (this.props.status !== BusStatus.IN_SERVICE) {
      throw new BusNotInServiceError(this.props.plate);
    }
    this.props.status = BusStatus.FINISHED;
    this.props.updatedAt = new Date();
  }

  toPersistence(): BusProps {
    return { ...this.props };
  }
}

export class BusNotInServiceError extends ConflictError {
  constructor(plate: string) {
    super(`El bus ${plate} no está en servicio.`, { plate });
  }
}

export class BusAlreadyInServiceError extends ConflictError {
  constructor(plate: string) {
    super(`El bus ${plate} ya está en servicio.`, { plate });
  }
}
