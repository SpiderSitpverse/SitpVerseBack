import { BusStatus } from '../value-objects/bus-status.enum';

export interface BusProps {
  id: string;
  plate: string;
  route: string;
  driver?: string | null;
  status: BusStatus;
  latitude?: number | null;
  longitude?: number | null;
  updatedAt: Date;
}

/**
 * Entidad de dominio pura: no conoce Prisma, ni HTTP, ni Redis.
 * Toda regla de negocio sobre "qué puede hacer un bus" vive acá.
 */
export class Bus {
  private constructor(private props: BusProps) {}

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

  /** HU-49: reportar inicio de viaje */
  startTrip(): void {
    if (this.props.status === BusStatus.IN_SERVICE) {
      throw new BusAlreadyInServiceError(this.props.plate);
    }
    this.props.status = BusStatus.IN_SERVICE;
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

export class BusNotInServiceError extends Error {
  constructor(plate: string) {
    super(`El bus ${plate} no está en servicio.`);
    this.name = 'BusNotInServiceError';
  }
}

export class BusAlreadyInServiceError extends Error {
  constructor(plate: string) {
    super(`El bus ${plate} ya está en servicio.`);
    this.name = 'BusAlreadyInServiceError';
  }
}
