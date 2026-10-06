import { ForbiddenError, InvalidInputError } from '../../../shared/domain/errors';
import { isUploadedImageUrl } from '../../../shared/domain/file-storage.port';
import { UserRole } from '../../../shared/domain/roles';

/** Reglas de las inspecciones (funciones puras, sin infraestructura). */

export const MAX_PHOTOS = 10;
export const MAX_NOTE_LENGTH = 2000;

export interface Actor {
  id: string;
  role: UserRole;
}

/**
 * Quién puede REGISTRAR una inspección: el ADMIN en cualquier bus y el conductor SOLO en el suyo.
 * (El mecánico consulta, pero no registra inspecciones previas al viaje.)
 */
export function assertCanRegister(actor: Actor, busId: string, driversBusId: string | null): void {
  if (actor.role === 'ADMIN') return;
  if (actor.role === 'DRIVER' && driversBusId === busId) return;
  throw new ForbiddenError('Solo puedes registrar la inspección del bus que tienes asignado');
}

/** Quién puede CONSULTAR la inspección de un bus: ADMIN y mecánico cualquiera; el conductor solo la de su bus. */
export function assertCanView(actor: Actor, busId: string, driversBusId: string | null): void {
  if (actor.role === 'ADMIN' || actor.role === 'MECHANICAL') return;
  if (actor.role === 'DRIVER' && driversBusId === busId) return;
  throw new ForbiddenError('No tienes acceso a las inspecciones de este bus');
}

/**
 * Las fotos solo pueden ser archivos que subió este mismo servidor (`POST /files/images`): así nadie
 * puede colar enlaces externos ni cadenas peligrosas (p. ej. `javascript:`) que luego el front pinte.
 */
export function assertValidPhotos(photos: unknown[]): asserts photos is string[] {
  if (photos.length > MAX_PHOTOS) {
    throw new InvalidInputError(`Máximo ${MAX_PHOTOS} fotos por inspección`);
  }
  const invalid = photos.find((photo) => !isUploadedImageUrl(photo));
  if (invalid !== undefined) {
    throw new InvalidInputError('Las fotos deben ser archivos subidos con POST /files/images', {
      invalidPhoto: String(invalid).slice(0, 80),
    });
  }
}

export function assertValidText(note: string): void {
  if (note.trim().length === 0) throw new InvalidInputError('La nota es obligatoria');
  if (note.length > MAX_NOTE_LENGTH) {
    throw new InvalidInputError(`La nota no puede superar ${MAX_NOTE_LENGTH} caracteres`);
  }
}
