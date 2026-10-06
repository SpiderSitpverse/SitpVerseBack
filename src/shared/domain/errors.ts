/**
 * Errores de aplicación independientes del framework.
 *
 * El dominio y los casos de uso lanzan estos errores (nunca excepciones HTTP de Nest):
 * así la lógica de negocio no sabe que existe HTTP. El adapter de entrada los traduce
 * a códigos de estado en `shared/http/app-error.filter.ts`.
 */
export abstract class AppError extends Error {
  constructor(
    message: string,
    /** Código estable que el frontend puede usar para decidir qué mostrar. */
    readonly code: string,
    /** Datos extra serializables (p. ej. `{ reason: 'FULL' }`). */
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = new.target.name;
  }
}

/** El recurso pedido no existe. → 404 */
export class NotFoundError extends AppError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, 'NOT_FOUND', details);
  }
}

/** La operación choca con el estado actual (cupo lleno, ya completada, duplicado...). → 409 */
export class ConflictError extends AppError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, 'CONFLICT', details);
  }
}

/** El actor está identificado pero no tiene permiso para esta acción. → 403 */
export class ForbiddenError extends AppError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, 'FORBIDDEN', details);
  }
}

/** El sistema no pudo atender ahora (p. ej. lock saturado); el cliente puede reintentar. → 503 */
export class BusyError extends AppError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, 'BUSY', details);
  }
}

/** No se pudo comprobar quién es el usuario (credenciales o token inválidos). → 401 */
export class UnauthorizedError extends AppError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, 'UNAUTHORIZED', details);
  }
}

/** Los datos enviados no cumplen una regla de negocio (formato, longitud...). → 400 */
export class InvalidInputError extends AppError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, 'INVALID_INPUT', details);
  }
}
