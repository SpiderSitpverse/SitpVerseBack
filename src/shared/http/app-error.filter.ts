import { ArgumentsHost, Catch, ExceptionFilter, HttpStatus } from '@nestjs/common';
import { Response } from 'express';
import { logEvent } from '../infrastructure/structured-log';
import {
  AppError,
  BusyError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
} from '../domain/errors';

const STATUS_BY_ERROR: [new (...args: never[]) => AppError, HttpStatus][] = [
  [NotFoundError, HttpStatus.NOT_FOUND],
  [ConflictError, HttpStatus.CONFLICT],
  [ForbiddenError, HttpStatus.FORBIDDEN],
  [BusyError, HttpStatus.SERVICE_UNAVAILABLE],
];

/** Traduce los errores de dominio/aplicación a respuestas HTTP coherentes. */
@Catch(AppError)
export class AppErrorFilter implements ExceptionFilter {
  catch(error: AppError, host: ArgumentsHost) {
    const http = host.switchToHttp() as {
      getRequest?: <T>() => T;
      getResponse: <T>() => T;
    };
    const request = http.getRequest
      ? http.getRequest<{
          method: string;
          originalUrl: string;
          headers: Record<string, string | undefined>;
        }>()
      : undefined;
    const status =
      STATUS_BY_ERROR.find(([type]) => error instanceof type)?.[1] ??
      HttpStatus.BAD_REQUEST;

    const traceId = request?.headers['x-trace-id'];
    logEvent(status >= 500 ? 'error' : 'warn', 'http.request.failed', {
      trace_id: traceId,
      method: request?.method,
      route: request?.originalUrl,
      status_code: status,
      error_code: error.code,
      error: error.message,
    });
    http.getResponse<Response>().status(status).json({
      statusCode: status,
      error: error.code,
      message: error.message,
      traceId,
      ...error.details,
    });
  }
}
