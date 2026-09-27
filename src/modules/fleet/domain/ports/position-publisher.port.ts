export const POSITION_PUBLISHER = Symbol('POSITION_PUBLISHER');

export interface BusPositionEvent {
  busId: string;
  plate: string;
  route: string;
  status: string;
  latitude: number;
  longitude: number;
  updatedAt: string;
}

/**
 * Puerto (driven port) hacia el mecanismo de distribución de eventos en tiempo real.
 * La implementación (Redis Pub/Sub) vive en `infrastructure/redis`.
 * Gracias a esto, el caso de uso NO sabe que existe Redis: solo "publica un evento".
 */
export interface PositionPublisherPort {
  publish(event: BusPositionEvent): Promise<void>;
}
