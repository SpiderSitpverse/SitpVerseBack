import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Prisma, UserRole } from '@prisma/client';
import { RequestRecord, RequestSinkPort } from '../../../../shared/domain/request-sink.port';
import { PrismaService } from '../../../../shared/infrastructure/prisma.service';
import { RequestLogPort, RequestLogQuery, RequestLogView } from '../../domain/ports/request-log.port';

const FLUSH_EVERY_MS = 1000;
const FLUSH_AT = 200;
/** Si la base no responde, se retienen hasta estos registros (los más viejos se descartan: no se agota la memoria). */
const MAX_BUFFERED = 5000;

/**
 * Registro de TODAS las peticiones en PostgreSQL (tabla `request_log`, solo inserción: un trigger rechaza UPDATE y DELETE).
 * Se guarda por lotes, cada segundo o cada 200 registros, para no sumar una escritura a cada petición (las posiciones GPS
 * son ~20 por segundo). Al apagar el servidor se vacía el lote pendiente.
 */
@Injectable()
export class PrismaRequestLog implements RequestSinkPort, RequestLogPort, OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaRequestLog.name);
  private buffer: RequestRecord[] = [];
  private timer?: ReturnType<typeof setInterval>;
  private flushing: Promise<void> = Promise.resolve();

  constructor(private readonly prisma: PrismaService) {}

  onModuleInit() {
    this.timer = setInterval(() => void this.flush(), FLUSH_EVERY_MS);
    this.timer.unref();
  }

  async onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
    await this.flush();
  }

  push(record: RequestRecord): void {
    this.buffer.push(record);
    if (this.buffer.length > MAX_BUFFERED) this.buffer.splice(0, this.buffer.length - MAX_BUFFERED);
    if (this.buffer.length >= FLUSH_AT) void this.flush();
  }

  /** Guarda lo pendiente. Un solo lote a la vez; si falla, el lote vuelve a la cola para el siguiente intento. */
  flush(): Promise<void> {
    this.flushing = this.flushing.then(async () => {
      if (this.buffer.length === 0) return;
      const batch = this.buffer;
      this.buffer = [];
      try {
        await this.prisma.requestLog.createMany({
          data: batch.map((r) => ({ ...r, role: (r.role as UserRole | null) ?? null })),
        });
      } catch (error) {
        this.buffer = [...batch, ...this.buffer].slice(-MAX_BUFFERED);
        this.logger.error(JSON.stringify({ event: 'request_log.flush_failed', severity: 'ERROR', error: String(error), pending: this.buffer.length }));
      }
    });
    return this.flushing;
  }

  async list(query: RequestLogQuery): Promise<RequestLogView[]> {
    await this.flush(); // lo que acaba de pasar ya se puede consultar
    const where: Prisma.RequestLogWhereInput = {
      userId: query.userId,
      ip: query.ip,
      country: query.country,
      status: query.status,
      path: query.path ? { startsWith: query.path } : undefined,
      at: { gte: query.from, lte: query.to, lt: query.before },
    };
    const rows = await this.prisma.requestLog.findMany({ where, orderBy: { at: 'desc' }, take: query.limit });
    return rows.map((row) => ({ ...row, id: String(row.id) }));
  }
}
