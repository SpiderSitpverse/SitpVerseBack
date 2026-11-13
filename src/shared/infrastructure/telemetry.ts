import { Injectable } from '@nestjs/common';
import { randomUUID } from 'crypto';
import {
  currentTraceId,
  runWithTrace,
} from '../telemetry-context';

@Injectable()
export class TelemetryService {
  run<T>(traceId: string, callback: () => T): T {
    return runWithTrace(traceId, callback);
  }

  traceId(): string | undefined {
    return currentTraceId();
  }

  static newTraceId(value: unknown): string {
    if (typeof value === 'string' && /^[a-zA-Z0-9._:-]{8,128}$/.test(value)) {
      return value;
    }
    return randomUUID();
  }
}

export function traceIdFrom(value: unknown): string {
  return TelemetryService.newTraceId(value);
}
