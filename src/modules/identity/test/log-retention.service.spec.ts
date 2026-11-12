import { Logger } from '@nestjs/common';
import {
  LogRetentionService,
  MIN_AUDIT_LOG_DAYS,
  MIN_REQUEST_LOG_DAYS,
} from '../infrastructure/prisma/log-retention.service';

Logger.overrideLogger(false);

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date('2026-11-13T12:00:00.000Z');

function build(env: Record<string, unknown> = {}, deletes: Record<string, number[]> = {}) {
  const queue = { request_log: [...(deletes.request_log ?? [])], audit_log: [...(deletes.audit_log ?? [])] };
  const cutoffs: { table: string; cutoff: Date }[] = [];
  let locked = true;
  const tx = {
    $queryRaw: jest.fn(async () => [{ locked }]),
    $executeRaw: jest.fn(async (strings: TemplateStringsArray, cutoff: Date) => {
      const table = strings[0].includes('request_log') ? 'request_log' : 'audit_log';
      cutoffs.push({ table, cutoff });
      return queue[table].shift() ?? 0;
    }),
  };
  const prisma = { $transaction: jest.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)) };
  const audit = { record: jest.fn(async () => undefined) };
  const config = { get: (key: string) => env[key] };
  const service = new LogRetentionService(prisma as never, audit as never, config as never);
  return { service, audit, cutoffs, lock: (v: boolean) => (locked = v), prisma };
}

describe('Retención de los registros de trazabilidad', () => {
  it('por defecto conserva 14 días las peticiones y 730 días la auditoría', () => {
    expect(build().service.retention).toEqual({ requestLogDays: 14, auditLogDays: 730 });
  });

  it('nunca acepta menos que el mínimo que impone la base (7 y 365 días), aunque se configure', () => {
    const { service } = build({ REQUEST_LOG_RETENTION_DAYS: 1, AUDIT_RETENTION_DAYS: 30 });
    expect(service.retention).toEqual({ requestLogDays: MIN_REQUEST_LOG_DAYS, auditLogDays: MIN_AUDIT_LOG_DAYS });
  });

  it('acepta un plazo más largo; y un valor inválido vuelve al por defecto', () => {
    expect(build({ REQUEST_LOG_RETENTION_DAYS: '30', AUDIT_RETENTION_DAYS: '1000' }).service.retention).toEqual({ requestLogDays: 30, auditLogDays: 1000 });
    expect(build({ REQUEST_LOG_RETENTION_DAYS: 'abc', AUDIT_RETENTION_DAYS: -5 }).service.retention).toEqual({ requestLogDays: 14, auditLogDays: 730 });
    expect(build({ REQUEST_LOG_RETENTION_DAYS: 999999 }).service.retention.requestLogDays).toBe(3650);
  });

  it('borra solo lo anterior al plazo de cada tabla', async () => {
    const t = build({}, { request_log: [120], audit_log: [3] });
    const result = await t.service.purge(NOW);
    expect(result).toEqual({ requestLog: 120, auditLog: 3 });
    const request = t.cutoffs.find((c) => c.table === 'request_log')!;
    const audit = t.cutoffs.find((c) => c.table === 'audit_log')!;
    expect(request.cutoff.getTime()).toBe(NOW.getTime() - 14 * DAY);
    expect(audit.cutoff.getTime()).toBe(NOW.getTime() - 730 * DAY);
  });

  it('borra en lotes hasta vaciar lo vencido', async () => {
    jest.useFakeTimers();
    try {
      const t = build({}, { request_log: [5000, 5000, 42] });
      const done = t.service.purge(NOW);
      await jest.advanceTimersByTimeAsync(1000);
      expect((await done).requestLog).toBe(10_042);
    } finally {
      jest.useRealTimers();
    }
  });

  it('si otra instancia ya está purgando (candado ocupado), no borra nada', async () => {
    const t = build({}, { request_log: [100], audit_log: [100] });
    t.lock(false);
    expect(await t.service.purge(NOW)).toEqual({ requestLog: 0, auditLog: 0 });
    expect(t.cutoffs).toHaveLength(0);
    expect(t.audit.record).not.toHaveBeenCalled();
  });

  it('cada purga con registros borrados queda auditada; sin nada que borrar no deja ruido', async () => {
    const some = build({}, { request_log: [7] });
    await some.service.purge(NOW);
    expect(some.audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'retention.purge', outcome: 'SUCCESS', detail: expect.objectContaining({ requestLog: 7 }) }),
    );
    const none = build();
    await none.service.purge(NOW);
    expect(none.audit.record).not.toHaveBeenCalled();
  });

  it('se programa al arrancar y se apaga con LOG_RETENTION_ENABLED=false', () => {
    jest.useFakeTimers();
    try {
      const t = build();
      const run = jest.spyOn(t.service, 'purge').mockResolvedValue({ requestLog: 0, auditLog: 0 });
      t.service.onModuleInit();
      jest.advanceTimersByTime(10 * 60 * 1000);
      expect(run).toHaveBeenCalledTimes(1);
      t.service.onModuleDestroy();
      jest.advanceTimersByTime(24 * 60 * 60 * 1000);
      expect(run).toHaveBeenCalledTimes(1);

      process.env.LOG_RETENTION_ENABLED = 'false';
      const off = build();
      const offRun = jest.spyOn(off.service, 'purge').mockResolvedValue({ requestLog: 0, auditLog: 0 });
      off.service.onModuleInit();
      jest.advanceTimersByTime(24 * 60 * 60 * 1000);
      expect(offRun).not.toHaveBeenCalled();
    } finally {
      delete process.env.LOG_RETENTION_ENABLED;
      jest.useRealTimers();
    }
  });

  it('un fallo al purgar se registra y no tumba la aplicación', async () => {
    jest.useFakeTimers();
    try {
      const t = build();
      jest.spyOn(t.service, 'purge').mockRejectedValue(new Error('base caída'));
      t.service.onModuleInit();
      await jest.advanceTimersByTimeAsync(10 * 60 * 1000);
      t.service.onModuleDestroy();
    } finally {
      jest.useRealTimers();
    }
  });
});
