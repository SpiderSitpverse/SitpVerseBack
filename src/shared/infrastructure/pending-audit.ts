import { Prisma, PrismaClient } from '@prisma/client';
import { currentRequestContext } from '../http/client-info';

type Db = PrismaClient | Prisma.TransactionClient;

/**
 * Auditoría EN LA MISMA TRANSACCIÓN que el cambio (ESC-SEG-03).
 *
 * Cuando una ruta está marcada con `@Audited(...)`, su registro de auditoría queda "pendiente" en el contexto de la
 * petición, con un `id` fijo. Los adaptadores que escriben en la base lo insertan dentro de SU transacción: el cambio y
 * su registro se confirman (o se revierten) juntos, así que no puede existir el cambio sin su registro.
 *
 * El `id` fijo + `skipDuplicates` lo hacen idempotente: si la transacción se reintenta o la acción usa varias
 * transacciones, queda UN solo registro; y al terminar la petición el interceptor lo vuelve a asegurar (cubre las
 * acciones que no cambian la base).
 */
export async function flushPendingAudit(tx: Db): Promise<void> {
  const pending = currentRequestContext()?.audit;
  if (!pending) return;
  await tx.auditLog.createMany({ data: [pending as Prisma.AuditLogCreateManyInput], skipDuplicates: true });
}

/**
 * Ejecuta una escritura simple junto con la auditoría pendiente, en una transacción. Si la petición no tiene auditoría
 * pendiente (p. ej. la posición GPS, 20 por segundo), la escritura va directa, sin el costo de una transacción.
 */
export async function withPendingAudit<T>(prisma: PrismaClient, write: (db: Db) => Promise<T>): Promise<T> {
  if (!currentRequestContext()?.audit) return write(prisma);
  return prisma.$transaction(async (tx) => {
    const result = await write(tx);
    await flushPendingAudit(tx);
    return result;
  });
}
