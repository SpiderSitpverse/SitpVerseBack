import { Inject, Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { PrismaService } from '../prisma.service';
import { REDIS_RELAY_CLIENT } from '../redis.provider';
import { logEvent } from '../structured-log';

interface PendingRow {
  id: bigint;
  eventId: string;
  channel: string;
  payload: Record<string, unknown>;
  createdAt: Date;
}

const BATCH_SIZE = 100;
/** Cada stream conserva ~ este número de entradas (la verdad está en Postgres). */
const STREAM_MAX_LEN = 10_000;
const LAG_WARN_MS = 5_000;
const CLEANUP_EVERY_MS = 60_000;
const RETENTION_HOURS = 24;
/** Si Redis no responde en este tiempo se cuenta como fallo (y se reintenta), en vez de quedarse colgado. */
const PUBLISH_TIMEOUT_MS = 2_000;
const TX_TIMEOUT_MS = 15_000;

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`Redis no respondió en ${ms}ms`)), ms),
    ),
  ]);
}

/**
 * Relay del Transactional Outbox: lee los eventos pendientes de Postgres y los publica en
 * Redis Streams, en orden, marcándolos como publicados.
 *
 *  - **Nunca se pierden**: si Redis está caído quedan pendientes y se reintentan.
 *  - **Varias instancias a la vez**: `FOR UPDATE SKIP LOCKED` reparte las filas sin pisarse.
 *  - **At-least-once**: si el proceso muere entre publicar y marcar, el evento se republica;
 *    por eso cada evento lleva `eventId` y el cliente descarta duplicados.
 *  - **Baja latencia**: `nudge()` lo despierta apenas se confirma una transacción; el
 *    sondeo periódico es la red de seguridad.
 */
@Injectable()
export class OutboxRelay implements OnModuleInit, OnModuleDestroy {
  private timer?: ReturnType<typeof setInterval>;
  private draining = false;
  private lastCleanup = 0;

  constructor(
    private readonly prisma: PrismaService,
    @Inject(REDIS_RELAY_CLIENT) private readonly redis: Redis,
    private readonly config: ConfigService,
  ) {}

  onModuleInit() {
    const pollMs = this.config.get<number>('OUTBOX_POLL_MS', 250);
    this.timer = setInterval(() => void this.drain(), pollMs);
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  /** Despierta al relay ahora mismo (se llama tras confirmar una transacción con eventos). */
  nudge() {
    setImmediate(() => void this.drain());
  }

  private async drain() {
    if (this.draining) return; // un solo drenaje a la vez por proceso
    this.draining = true;
    try {
      let published: number;
      do {
        published = await this.publishBatch();
      } while (published === BATCH_SIZE);
      await this.cleanup();
    } catch (err) {
      logEvent('error', 'outbox.relay_failed', { severity: 'ERROR', error: String(err) });
    } finally {
      this.draining = false;
    }
  }

  private async publishBatch(): Promise<number> {
    return this.prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<PendingRow[]>`
        SELECT "id", "eventId", "channel", "payload", "createdAt"
          FROM "outbox_events"
         WHERE "publishedAt" IS NULL
         ORDER BY "id"
         LIMIT ${BATCH_SIZE}
           FOR UPDATE SKIP LOCKED`;
      if (rows.length === 0) return 0;

      const done: bigint[] = [];
      try {
        for (const row of rows) {
          await withTimeout(
            this.redis.xadd(
              row.channel, 'MAXLEN', '~', STREAM_MAX_LEN, '*',
              'data', JSON.stringify({ ...row.payload, seq: row.id.toString() }),
            ),
            PUBLISH_TIMEOUT_MS,
          );
          done.push(row.id);
        }
      } catch (err) {
        // Redis caído: lo ya publicado se marca igual; el resto queda pendiente y se reintenta.
        const lagMs = Date.now() - rows[0].createdAt.getTime();
        logEvent(lagMs > LAG_WARN_MS ? 'error' : 'warn', 'outbox.publish_failed', {
          severity: lagMs > LAG_WARN_MS ? 'ERROR' : 'WARN',
          pending_lag_ms: lagMs,
          error: String(err),
        });
      }

      if (done.length > 0) {
        await tx.$executeRaw`
          UPDATE "outbox_events" SET "publishedAt" = now() WHERE "id" = ANY(${done}::bigint[])`;
      }
      return done.length === rows.length ? rows.length : 0; // si falló, no insistir en este ciclo
    }, { timeout: TX_TIMEOUT_MS });
  }

  /** Los eventos ya publicados se conservan 24 h (sirven para reproducir a quien se reconecta). */
  private async cleanup() {
    if (Date.now() - this.lastCleanup < CLEANUP_EVERY_MS) return;
    this.lastCleanup = Date.now();
    await this.prisma.$executeRaw`
      DELETE FROM "outbox_events"
       WHERE "publishedAt" < now() - make_interval(hours => ${RETENTION_HOURS}::int)`;
  }
}
