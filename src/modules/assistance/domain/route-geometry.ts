import { InvalidInputError } from '../../../shared/domain/errors';

/** Un punto del trazado: `[latitud, longitud]` (mismo orden que usa Leaflet en el front). */
export type LatLng = [number, number];

export const MIN_ROUTE_POINTS = 2;
export const MAX_ROUTE_POINTS = 2000;

/**
 * Valida y normaliza el trazado de una ruta alternativa (HU-46/47).
 *
 * El mapa del front dibuja lo que reciba tal cual: un punto mal formado (texto, `null`, `NaN`,
 * un `[lng, lat]` fuera de rango) rompe la polilínea de Leaflet. Se rechaza aquí, con un mensaje
 * que dice QUÉ punto falla, en vez de guardarlo y distribuirlo a todos los conductores.
 *
 * Ojo: no puede detectar que el front mande `[lng, lat]` si ambos valores caben en rango
 * (Bogotá: `[4.6, -74.1]` es correcto; `[-74.1, 4.6]` también "cabe"). El orden es `[lat, lng]`.
 */
export function parseRouteGeometry(geometry: unknown): LatLng[] {
  if (!Array.isArray(geometry)) {
    throw new InvalidInputError('La geometría debe ser una lista de puntos [latitud, longitud]', {
      reason: 'INVALID_GEOMETRY',
    });
  }
  if (geometry.length < MIN_ROUTE_POINTS) {
    throw new InvalidInputError(`Una ruta necesita al menos ${MIN_ROUTE_POINTS} puntos`, {
      reason: 'INVALID_GEOMETRY',
    });
  }
  if (geometry.length > MAX_ROUTE_POINTS) {
    throw new InvalidInputError(`Una ruta admite como máximo ${MAX_ROUTE_POINTS} puntos`, {
      reason: 'INVALID_GEOMETRY',
    });
  }

  return geometry.map((point, index): LatLng => {
    const invalid = (why: string) =>
      new InvalidInputError(`Punto ${index} inválido: ${why}`, { reason: 'INVALID_GEOMETRY', index });

    if (!Array.isArray(point) || point.length !== 2) throw invalid('debe ser [latitud, longitud]');
    const [lat, lng] = point;
    if (typeof lat !== 'number' || typeof lng !== 'number' || !Number.isFinite(lat) || !Number.isFinite(lng)) {
      throw invalid('latitud y longitud deben ser números');
    }
    if (lat < -90 || lat > 90) throw invalid('la latitud debe estar entre -90 y 90');
    if (lng < -180 || lng > 180) throw invalid('la longitud debe estar entre -180 y 180');
    return [lat, lng];
  });
}
