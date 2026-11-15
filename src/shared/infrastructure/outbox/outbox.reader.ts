import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma.service';

export interface StoredEvent {
  seq: string;
  payload: Record<string, unknown> & { audience?: { roles?: string[]; userIds?: string[] } };
}

/**
 * Lectura del outbox para REPRODUCIR eventos a un cliente que se reconectó: se le entregan
 * los que ocurrieron después del último `seq` que vio (mientras estuvo desconectado).
 */
@Injectable()
export class OutboxReader {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * El `seq` más reciente del canal ('0' si aún no hay eventos). Se le entrega al cliente al conectarse: así tiene un
   * punto de partida y, si se desconecta antes de recibir su primer evento, igual puede pedir lo que se perdió.
   */
  async latestSeq(channel: string): Promise<string> {
    const last = await this.prisma.outboxEvent.findFirst({ where: { channel }, orderBy: { id: 'desc' }, select: { id: true } });
    return (last?.id ?? 0n).toString();
  }

  async since(channel: string, afterSeq: bigint, limit = 500): Promise<StoredEvent[]> {
    const rows = await this.prisma.outboxEvent.findMany({
      where: { channel, id: { gt: afterSeq } },
      orderBy: { id: 'asc' },
      take: limit,
    });
    return rows.map((row) => ({
      seq: row.id.toString(),
      payload: { ...(row.payload as object), seq: row.id.toString() } as StoredEvent['payload'],
    }));
  }
}
