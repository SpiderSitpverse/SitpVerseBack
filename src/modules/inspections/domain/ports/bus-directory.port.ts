export const INSPECTION_BUS_DIRECTORY = Symbol('INSPECTION_BUS_DIRECTORY');

/**
 * Puerto (anticorruption layer): lo que `inspections` necesita saber de la flota. El adapter lo
 * resuelve por la API pública de `fleet`; este módulo nunca lee la tabla de buses.
 */
export interface InspectionBusDirectoryPort {
  exists(busId: string): Promise<boolean>;
  /** El bus asignado a un conductor (null si no tiene). */
  findBusIdOfDriver(userId: string): Promise<string | null>;
}
