/** Estados en los que una grúa o cuadrilla sigue ocupada (no se puede asignar a otro servicio). */
export const ACTIVE_TOW_STATUSES = ['ASSIGNED', 'IN_PROGRESS'] as const;

/**
 * "g-01", " G-01 " y "G-01" son la misma grúa. Se normaliza antes de comparar y de guardar
 * (igual que la placa de un bus se guarda en mayúsculas) para que una variación de escritura
 * no permita asignar dos veces el mismo recurso.
 */
export function normalizeResourceName(name: string): string {
  return name.trim().replace(/\s+/g, ' ').toUpperCase();
}
