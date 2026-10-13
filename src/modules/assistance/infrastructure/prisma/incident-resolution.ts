import { Prisma } from '@prisma/client';

/**
 * Un incidente queda RESUELTO cuando ya no queda trabajo pendiente: todas sus alertas terminaron y no hay grúa en
 * servicio (y hubo algo que hacer: una alerta o un servicio de grúa). Sale entonces de las listas activas del admin.
 *
 * Quién la evalúa: el cierre de una alerta (`completeWithin`) y el fin de un servicio de grúa (`completeTow`).
 * Para que dos cierres simultáneos no se "tapen" (cada uno vería al otro como pendiente y ninguno resolvería),
 * TODOS toman primero el bloqueo del incidente con `lockIncident`: se atienden de uno en uno y el segundo ya ve lo
 * que confirmó el primero. El orden de bloqueo es siempre incidente → alertas, el mismo que usa eliminar un incidente.
 */
export async function lockIncident(tx: Prisma.TransactionClient, incidentId: string): Promise<void> {
  await tx.$queryRaw`SELECT "id" FROM "driver_incidents" WHERE "id" = ${incidentId} FOR UPDATE`;
}

/** Marca el incidente como RESUELTO si ya no hay trabajo pendiente. Debe llamarse con el incidente bloqueado. */
export async function resolveIncidentIfDone(
  tx: Prisma.TransactionClient,
  incidentId: string,
): Promise<{ id: string; busId: string } | null> {
  const incident = await tx.driverIncident.findUnique({ where: { id: incidentId }, select: { busId: true, status: true } });
  if (!incident || incident.status === 'RESOLVED') return null;

  const [pendingCalls, activeTows, doneCalls, doneTows] = await Promise.all([
    tx.assistanceCall.count({ where: { incidentId, status: { not: 'COMPLETED' } } }),
    tx.towAssignment.count({ where: { incidentId, status: { in: ['ASSIGNED', 'IN_PROGRESS'] } } }),
    tx.assistanceCall.count({ where: { incidentId, status: 'COMPLETED' } }),
    tx.towAssignment.count({ where: { incidentId, status: 'COMPLETED' } }),
  ]);
  if (pendingCalls > 0 || activeTows > 0 || doneCalls + doneTows === 0) return null;

  const { count } = await tx.driverIncident.updateMany({
    where: { id: incidentId, status: { not: 'RESOLVED' } },
    data: { status: 'RESOLVED' },
  });
  return count > 0 ? { id: incidentId, busId: incident.busId } : null;
}
