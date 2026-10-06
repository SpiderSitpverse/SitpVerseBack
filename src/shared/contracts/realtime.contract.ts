/**
 * Contrato de tiempo real compartido por quien PUBLICA eventos (módulos) y quien los
 * ENTREGA (RealtimeModule). Centralizarlo evita que `realtime` dependa de la
 * infraestructura interna de cada módulo.
 */

/** Pub/Sub de Redis: eventos EFÍMEROS y de alta frecuencia (posición GPS). Perder uno no importa. */
export const REDIS_CHANNELS = {
  FLEET_POSITIONS: 'fleet:positions',
} as const;

/**
 * Redis Streams: eventos que NO se pueden perder (alertas). Se alimentan desde el outbox
 * transaccional y cada instancia del backend los lee desde su último id (no se pierden si
 * el suscriptor se reconecta, a diferencia de Pub/Sub).
 */
export const REDIS_STREAMS = {
  ASSISTANCE: 'assistance:stream',
} as const;

/** Nombres de evento que recibe el cliente por Socket.io (namespace `/realtime`). */
export const SOCKET_EVENTS = {
  FLEET_POSITION: 'fleet:position-updated',
  ASSISTANCE: 'assistance:event',
  /** El servidor confirma que el socket quedó asociado a un usuario y a las salas de su rol. */
  IDENTIFIED: 'identified',
  /** El token es inválido o venció: el servidor desconecta el socket; el front debe volver al login. */
  UNAUTHORIZED: 'unauthorized',
} as const;

/** A quién se entrega un evento: salas `role:<ROL>` y `user:<id>`. */
export interface RealtimeAudience {
  roles?: string[];
  userIds?: string[];
}

/**
 * Todo evento dirigido lleva su audiencia, un `eventId` único (el cliente descarta
 * duplicados: la entrega es at-least-once) y un `seq` global creciente asignado por el
 * outbox (el cliente guarda el mayor `seq` visto para pedir la reproducción al reconectar).
 */
export interface AudienceEvent {
  eventId: string;
  seq?: string;
  audience: RealtimeAudience;
}

export const roleRoom = (role: string) => `role:${role}`;
export const userRoom = (userId: string) => `user:${userId}`;

/** ¿Este usuario forma parte de la audiencia del evento? */
export function isInAudience(
  audience: RealtimeAudience,
  user: { id: string; role: string },
): boolean {
  return (
    (audience.roles ?? []).includes(user.role) ||
    (audience.userIds ?? []).includes(user.id)
  );
}
