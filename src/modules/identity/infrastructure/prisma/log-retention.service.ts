import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../../../shared/infrastructure/prisma.service';
import { PrismaAuditLog } from './prisma-audit-log';

/** Mínimos que la propia base de datos impone (ver la migración `log_retention`): la app nunca puede configurar menos. */
export const MIN_REQUEST_LOG_DAYS = 7;
export const MIN_AUDIT_LOG_DAYS = 365;
const DEFAULT_REQUEST_LOG_DAYS = 14;
const DEFAULT_AUDIT_LOG_DAYS = 730;
const MAX_DAYS = 3650;

const DAY_MS = 24 * 60 * 60 * 1000;
/** Se borra en lotes pequeños y con pausa: el borrado nunca compite con la operación (ni con una presentación en vivo). */
const BATCH_SIZE = 5000;
const MAX_BATCHES_PER_RUN = 100;
const PAUSE_BETWEEN_BATCHES_MS = 200;
const FIRST_RUN_DELAY_MS = 10 * 60 * 1000;
const RUN_EVERY_MS = 6 * 60 * 60 * 1000;
/** Candado de la base para que solo UNA instancia purgue a la vez (hay varias instancias del backend). */
const PURGE_LOCK_KEY = 727_001;

const clampDays = (value: unknown, fallback: number, min: number): number => {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(MAX_DAYS, Math.max(min, Math.floor(n)));
};

export interface PurgeResult {
  requestLog: number;
  auditLog: number;
}

/**
 * RETENCIÓN de los registros de trazabilidad.
 *
 *  - `request_log` (todas las peticiones): se conserva `REQUEST_LOG_RETENTION_DAYS` días (14 por defecto, mínimo 7). Es el que
 *    más crece (cada GPS es una petición), y su valor está en lo reciente: investigar un incidente de esta semana.
 *  - `audit_log` (acciones críticas): se conserva `AUDIT_RETENTION_DAYS` días (730 por defecto, mínimo 365). Crece poco y es la
 *    evidencia para disputas.
 *
 * Seguridad: los mínimos los hace cumplir la base (un trigger rechaza borrar algo más reciente), no solo este servicio. Corre al
 * arrancar (con 10 min de espera) y cada 6 horas, en lotes con pausa y con un candado de la base para que lo haga una sola
 * instancia. Cada purga queda auditada (`retention.purge`).
 */
@Injectable()
export class LogRetentionService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(LogRetentionService.name);
  private readonly requestDays: number;
  private readonly auditDays: number;
  private first?: ReturnType<typeof setTimeout>;
  private every?: ReturnType<typeof setInterval>;

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: PrismaAuditLog,
    config: ConfigService,
  ) {
    this.requestDays = clampDays(config.get('REQUEST_LOG_RETENTION_DAYS'), DEFAULT_REQUEST_LOG_DAYS, MIN_REQUEST_LOG_DAYS);
    this.auditDays = clampDays(config.get('AUDIT_RETENTION_DAYS'), DEFAULT_AUDIT_LOG_DAYS, MIN_AUDIT_LOG_DAYS);
  }

  get retention() {
    return { requestLogDays: this.requestDays, auditLogDays: this.auditDays };
  }

  onModuleInit() {
    if (this.disabled()) return;
    this.first = setTimeout(() => this.runSafely(), FIRST_RUN_DELAY_MS);
    this.every = setInterval(() => this.runSafely(), RUN_EVERY_MS);
    this.first.unref();
    this.every.unref();
    this.logger.log(JSON.stringify({ event: 'retention.scheduled', ...this.retention }));
  }

  onModuleDestroy() {
    if (this.first) clearTimeout(this.first);
    if (this.every) clearInterval(this.every);
  }

  /** `LOG_RETENTION_ENABLED=false` apaga la purga (p. ej. en las pruebas). */
  private disabled() {
    return process.env.LOG_RETENTION_ENABLED === 'false';
  }

  private runSafely() {
    this.purge().catch((error) =>
      this.logger.error(JSON.stringify({ event: 'retention.failed', severity: 'ERROR', error: String(error) })),
    );
  }

  /** Borra lo que ya superó su plazo. Devuelve cuántos registros borró de cada tabla (0 si otra instancia lo está haciendo). */
  async purge(now: Date = new Date()): Promise<PurgeResult> {
    const result: PurgeResult = { requestLog: 0, auditLog: 0 };
    result.requestLog = await this.purgeTable('request_log', new Date(now.getTime() - this.requestDays * DAY_MS));
    result.auditLog = await this.purgeTable('audit_log', new Date(now.getTime() - this.auditDays * DAY_MS));

    if (result.requestLog > 0 || result.auditLog > 0) {
      this.logger.log(JSON.stringify({ event: 'retention.purged', ...result, ...this.retention }));
      await this.audit.record({
        action: 'retention.purge',
        outcome: 'SUCCESS',
        resourceType: 'log',
        detail: { ...result, ...this.retention },
      });
    }
    return result;
  }

  private async purgeTable(table: 'request_log' | 'audit_log', cutoff: Date): Promise<number> {
    let total = 0;
    for (let batch = 0; batch < MAX_BATCHES_PER_RUN; batch++) {
      const deleted = await this.deleteBatch(table, cutoff);
      if (deleted === null) return total; // otra instancia está purgando
      total += deleted;
      if (deleted < BATCH_SIZE) return total;
      await new Promise((resolve) => setTimeout(resolve, PAUSE_BETWEEN_BATCHES_MS));
    }
    return total; // lo que falte se purga en la siguiente vuelta
  }

  /** Un lote dentro de una transacción con el candado: así el candado se suelta solo y vale aunque haya varias conexiones. */
  private deleteBatch(table: 'request_log' | 'audit_log', cutoff: Date): Promise<number | null> {
    return this.prisma.$transaction(async (tx) => {
      const [{ locked }] = await tx.$queryRaw<{ locked: boolean }[]>`SELECT pg_try_advisory_xact_lock(${PURGE_LOCK_KEY}) AS locked`;
      if (!locked) return null;
      // Nombre de tabla fijo (nunca viene del usuario): el tipo lo restringe a estas dos.
      return table === 'request_log'
        ? tx.$executeRaw`DELETE FROM request_log WHERE id IN (SELECT id FROM request_log WHERE "at" < ${cutoff} ORDER BY "at" LIMIT ${BATCH_SIZE})`
        : tx.$executeRaw`DELETE FROM audit_log WHERE id IN (SELECT id FROM audit_log WHERE "at" < ${cutoff} ORDER BY "at" LIMIT ${BATCH_SIZE})`;
    });
  }
}
