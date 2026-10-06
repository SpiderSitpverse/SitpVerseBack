import { ArgumentsHost, Catch, ExceptionFilter, HttpStatus } from '@nestjs/common';
import { Response } from 'express';
import {
  AppError,
  BusyError,
  ConflictError,
  ForbiddenError,
  InvalidInputError,
  NotFoundError,
  TooManyRequestsError,
  UnauthorizedError,
} from '../domain/errors';

const STATUS_BY_ERROR: [new (...args: never[]) => AppError, HttpStatus][] = [
  [NotFoundError, HttpStatus.NOT_FOUND],
  [ConflictError, HttpStatus.CONFLICT],
  [InvalidInputError, HttpStatus.BAD_REQUEST],
  [TooManyRequestsError, HttpStatus.TOO_MANY_REQUESTS],
  [UnauthorizedError, HttpStatus.UNAUTHORIZED],
  [ForbiddenError, HttpStatus.FORBIDDEN],
  [BusyError, HttpStatus.SERVICE_UNAVAILABLE],
];

/** Traduce los errores de dominio/aplicación a respuestas HTTP coherentes. */
@Catch(AppError)
export class AppErrorFilter implements ExceptionFilter {
  catch(error: AppError, host: ArgumentsHost) {
    const status =
      STATUS_BY_ERROR.find(([type]) => error instanceof type)?.[1] ??
      HttpStatus.BAD_REQUEST;

    const response = host.switchToHttp().getResponse<Response>();
    // Estándar HTTP: dice cuánto esperar antes de reintentar (el front puede mostrar una cuenta regresiva).
    if (error instanceof TooManyRequestsError) response.setHeader('Retry-After', String(error.retryAfterSeconds));

    response.status(status).json({
      statusCode: status,
      error: error.code,
      message: error.message,
      ...error.details,
    });
  }
}
