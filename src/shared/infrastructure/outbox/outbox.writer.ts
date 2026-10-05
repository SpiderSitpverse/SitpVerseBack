import { Prisma } from '@prisma/client';

/** Mensaje destinado a un stream de Redis; `eventId` lo hace idempotente para el cliente. */
export interface OutboxMessage {
  eventId: string;
  /** Stream de Redis destino (ver REDIS_STREAMS). */
  channel: string;
  payload: object;
}

/**
 * Escribe mensajes en el outbox DENTRO de la transacción del llamador.
 *
 * Esa es la garantía: el cambio de estado y su evento se confirman (o se revierten) JUNTOS.
 * No existe el caso "se guardó el cupo pero el evento se perdió" ni "se envió el evento de
 * algo que luego hizo rollback".
 */
export async function enqueueOutbox(
  tx: Prisma.TransactionClient,
  messages: OutboxMessage[],
): Promise<void> {
  if (messages.length === 0) return;
  await tx.outboxEvent.createMany({
    data: messages.map((m) => ({
      eventId: m.eventId,
      channel: m.channel,
      payload: m.payload as Prisma.InputJsonValue,
    })),
  });
}
