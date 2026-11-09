import { AsyncLocalStorage } from 'async_hooks';
import { randomUUID } from 'crypto';

export interface TelemetryContext {
  traceId: string;
  startedAt: number;
}

const context = new AsyncLocalStorage<TelemetryContext>();

export function runWithTrace<T>(traceId: string, callback: () => T): T {
  return context.run({ traceId, startedAt: Date.now() }, callback);
}

export function currentTraceId(): string | undefined {
  return context.getStore()?.traceId;
}

export function currentTraceIdOrNew(): string {
  return currentTraceId() ?? randomUUID();
}
