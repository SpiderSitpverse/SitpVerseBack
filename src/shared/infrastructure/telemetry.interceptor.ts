import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Observable, finalize } from 'rxjs';
import { MetricsService } from './metrics.service';
import { TelemetryService } from './telemetry';

@Injectable()
export class TelemetryInterceptor implements NestInterceptor {
  constructor(
    private readonly telemetry: TelemetryService,
    private readonly metrics: MetricsService,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = context.switchToHttp().getRequest();
    const response = context.switchToHttp().getResponse();
    const traceId =
      this.telemetry.traceId() ??
      TelemetryService.newTraceId(request.headers['x-trace-id']);
    const startedAt = Date.now();
    response.setHeader('x-trace-id', traceId);
    return new Observable((subscriber) =>
      this.telemetry.run(traceId, () => {
        const subscription = next.handle().pipe(
          finalize(() => {
            const durationMs = Date.now() - startedAt;
            const route = request.route?.path ?? request.url.split('?')[0];
            const status = String(response.statusCode);
            this.metrics.observe('sitpverse_http_request_duration_ms', durationMs, {
              method: request.method,
              route,
            });
            this.metrics.increment('sitpverse_http_requests_total', {
              method: request.method,
              route,
              status,
            });
          }),
        ).subscribe(subscriber);
        return () => subscription.unsubscribe();
      }),
    );
  }
}
