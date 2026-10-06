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
