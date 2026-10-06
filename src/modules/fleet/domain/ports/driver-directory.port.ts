export const DRIVER_DIRECTORY = Symbol('DRIVER_DIRECTORY');

export interface DriverRef {
  id: string;
  name: string;
}

/**
 * Puerto (anticorruption layer): lo que `fleet` necesita saber de los usuarios para asignar un
 * conductor a un bus. No lee la tabla de usuarios; el adapter lo resuelve por la API pública
 * de `identity`.
 */
export interface DriverDirectoryPort {
  /** El usuario si existe, está ACTIVO y tiene rol DRIVER; si no, null. */
  findActiveDriver(userId: string): Promise<DriverRef | null>;
}
