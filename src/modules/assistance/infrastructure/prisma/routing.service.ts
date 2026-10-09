import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'crypto';
import { PrismaService } from '../../../../shared/infrastructure/prisma.service';
import { OutboxRelay } from '../../../../shared/infrastructure/outbox/outbox.relay';
import { enqueueOutbox } from '../../../../shared/infrastructure/outbox/outbox.writer';
import { REDIS_STREAMS } from '../../../../shared/contracts/realtime.contract';
import { ConflictError, InvalidInputError, NotFoundError } from '../../../../shared/domain/errors';
import { AssistanceEventType } from '../../domain/events/assistance-events';
import { parseRouteGeometry } from '../../domain/route-geometry';
import { ACTIVE_TOW_STATUSES, normalizeResourceName } from '../../domain/tow-resources';

@Injectable()
export class RoutingService {
  constructor(private readonly prisma: PrismaService, private readonly relay: OutboxRelay) {}

  private async event(type: AssistanceEventType, payload: Record<string, unknown>, audience: object) {
    const eventId = randomUUID();
    return { eventId, channel: REDIS_STREAMS.ASSISTANCE, payload: {
      eventId, type, traceId: randomUUID(), occurredAt: new Date().toISOString(), audience, payload,
    }};
  }

  async listBlockages() {
    return this.prisma.driverIncident.findMany({
      include: { alternativeRoutes: true, towAssignments: true },
      orderBy: { createdAt: 'desc' },
    });
  }

  async reportBlockage(data: { busId: string; reportedById: string; reportedByName?: string; type: string; description?: string }) {
    const incident = await this.prisma.$transaction(async (tx) => {
      const created = await tx.driverIncident.create({ data });
      const event = await this.event('blockage.reported', { incidentId: created.id, busId: created.busId }, { roles: ['ADMIN'] });
      await enqueueOutbox(tx, [event]);
      return created;
    });
    this.relay.nudge();
    return incident;
  }

  /**
   * HU-30: asignar grúa y cuadrilla a un incidente.
   *
   * Una grúa (o cuadrilla) no puede estar en dos servicios activos a la vez. Revisar y luego
   * insertar NO es atómico: dos administradores que asignan la misma grúa al mismo tiempo
   * pasarían ambos la revisión. Por eso, dentro de la transacción, se toma un lock de Postgres
   * por recurso (`pg_advisory_xact_lock`): el segundo espera al primero, ve la grúa ocupada y
   * recibe 409. El lock se libera solo al terminar la transacción y vale entre instancias.
   */
  async assignTow(actorId: string, data: { incidentId: string; towTruck: string; crew: string }) {
    const towTruck = normalizeResourceName(data.towTruck);
    const crew = normalizeResourceName(data.crew);
    if (!towTruck || !crew) throw new InvalidInputError('La grúa y la cuadrilla no pueden estar vacías');

    const result = await this.prisma.$transaction(async (tx) => {
      const incident = await tx.driverIncident.findUnique({ where: { id: data.incidentId } });
      if (!incident) throw new NotFoundError(`Incidente ${data.incidentId} no encontrado`);

      // Orden fijo (grúa y luego cuadrilla) para que dos peticiones nunca se bloqueen entre sí.
      await this.lockResource(tx, 'tow-truck', towTruck);
      await this.lockResource(tx, 'tow-crew', crew);

      const activeStatus = { in: [...ACTIVE_TOW_STATUSES] };
      const truckBusy = await tx.towAssignment.findFirst({
        where: { towTruck: { equals: towTruck, mode: 'insensitive' }, status: activeStatus },
        select: { id: true, incidentId: true },
      });
      if (truckBusy) {
        throw new ConflictError(`La grúa ${towTruck} ya está asignada a un servicio activo`, {
          reason: 'TOW_TRUCK_BUSY',
          assignmentId: truckBusy.id,
          incidentId: truckBusy.incidentId,
        });
      }
      const crewBusy = await tx.towAssignment.findFirst({
        where: { crew: { equals: crew, mode: 'insensitive' }, status: activeStatus },
        select: { id: true, incidentId: true },
      });
      if (crewBusy) {
        throw new ConflictError(`La cuadrilla ${crew} ya está asignada a un servicio activo`, {
          reason: 'CREW_BUSY',
          assignmentId: crewBusy.id,
          incidentId: crewBusy.incidentId,
        });
      }

      const assignment = await tx.towAssignment.create({
        data: { incidentId: incident.id, towTruck, crew, busId: incident.busId, assignedById: actorId },
      });
      const event = await this.event('tow.assigned', { assignmentId: assignment.id, incidentId: incident.id, busId: incident.busId }, { roles: ['ADMIN', 'DRIVER', 'MECHANICAL'] });
      await enqueueOutbox(tx, [event]);
      return assignment;
    });
    this.relay.nudge();
    return result;
  }

  /**
   * HU-30/HU-50: terminar el servicio de grúa y liberar la grúa y la cuadrilla.
   * Sin esto, una grúa asignada quedaría ocupada para siempre (ver `assignTow`).
   */
  async completeTow(assignmentId: string) {
    const result = await this.prisma.$transaction(async (tx) => {
      const assignment = await tx.towAssignment.findUnique({ where: { id: assignmentId } });
      if (!assignment) throw new NotFoundError(`Asignación ${assignmentId} no encontrada`);

      // Atómico: si dos peticiones llegan a la vez, solo una cambia el estado (count = 1).
      const { count } = await tx.towAssignment.updateMany({
        where: { id: assignmentId, status: { in: [...ACTIVE_TOW_STATUSES] } },
        data: { status: 'COMPLETED', completedAt: new Date() },
      });
      if (count === 0) {
        throw new ConflictError('El servicio de grúa ya estaba completado', { reason: 'ALREADY_COMPLETED' });
      }

      const completed = await tx.towAssignment.findUniqueOrThrow({ where: { id: assignmentId } });
      const event = await this.event(
        'tow.completed',
        { assignmentId, incidentId: completed.incidentId, busId: completed.busId, towTruck: completed.towTruck, crew: completed.crew },
        { roles: ['ADMIN', 'DRIVER', 'MECHANICAL'] },
      );
      await enqueueOutbox(tx, [event]);
      return completed;
    });
    this.relay.nudge();
    return result;
  }

  /** Lock de Postgres por (tipo, nombre); dura lo que la transacción. */
  private async lockResource(tx: Prisma.TransactionClient, kind: string, name: string) {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${kind}), hashtext(${name}))`;
  }

  async attachEvidence(
    actorId: string,
    incidentId: string,
    data: { url: string; caption?: string; capturedAt?: string },
  ) {
    const result = await this.prisma.$transaction(async (tx) => {
      const incident = await tx.driverIncident.findUnique({ where: { id: incidentId } });
      if (!incident) throw new NotFoundError(`Incidente ${incidentId} no encontrado`);
      const evidence = await tx.incidentEvidence.create({
        data: {
          incidentId,
          url: data.url,
          caption: data.caption,
          capturedAt: data.capturedAt ? new Date(data.capturedAt) : undefined,
          uploadedById: actorId,
        },
      });
      const event = await this.event(
        'incident.evidence.attached',
        { incidentId, evidenceId: evidence.id, busId: incident.busId, url: evidence.url },
        { roles: ['ADMIN', 'DRIVER', 'MECHANICAL'] },
      );
      await enqueueOutbox(tx, [event]);
      return evidence;
    });
    this.relay.nudge();
    return result;
  }

  listEvidence(incidentId: string) {
    return this.prisma.incidentEvidence.findMany({
      where: { incidentId },
      orderBy: { createdAt: 'asc' },
    });
  }

  listTowReports(query: {
    towTruck?: string;
    crew?: string;
    incidentId?: string;
    status?: 'ASSIGNED' | 'IN_PROGRESS' | 'COMPLETED';
    from?: string;
    to?: string;
    skip?: number;
    take?: number;
  }) {
    return this.prisma.towAssignment.findMany({
      where: {
        towTruck: query.towTruck ? { contains: query.towTruck, mode: 'insensitive' } : undefined,
        crew: query.crew ? { contains: query.crew, mode: 'insensitive' } : undefined,
        incidentId: query.incidentId,
        status: query.status,
        createdAt: {
          gte: query.from ? new Date(query.from) : undefined,
          lte: query.to ? new Date(query.to) : undefined,
        },
      },
      include: {
        incident: { select: { id: true, busId: true, type: true, description: true, createdAt: true } },
      },
      orderBy: { createdAt: 'desc' },
      skip: query.skip ?? 0,
      take: query.take ?? 50,
    });
  }

  /** HU-44: durable fan-out to the fleet room; replayed by the outbox relay on reconnect. */
  async alertFleet(incidentId: string) {
    const incident = await this.prisma.driverIncident.findUnique({ where: { id: incidentId } });
    if (!incident) throw new NotFoundError(`Incidente ${incidentId} no encontrado`);
    const event = await this.event(
      'blockage.alerted',
      { incidentId, busId: incident.busId, type: incident.type, description: incident.description },
      { roles: ['DRIVER'] },
    );
    await this.prisma.$transaction(async (tx) => enqueueOutbox(tx, [event]));
    this.relay.nudge();
    return { sent: true, incidentId };
  }

  async listRoutes(incidentId: string) {
    return this.prisma.alternativeRoute.findMany({ where: { incidentId }, orderBy: { createdAt: 'asc' } });
  }

  async createRoute(actorId: string, incidentId: string, data: { name: string; geometry: unknown[] }) {
    // Se valida ANTES de abrir la transacción: un trazado inválido nunca llega a la base ni a la flota.
    const geometry = parseRouteGeometry(data.geometry);
    const name = data.name.trim();
    if (!name) throw new InvalidInputError('La ruta necesita un nombre');

    const result = await this.prisma.$transaction(async (tx) => {
      const incident = await tx.driverIncident.findUnique({ where: { id: incidentId } });
      if (!incident) throw new NotFoundError(`Incidente ${incidentId} no encontrado`);
      const route = await tx.alternativeRoute.create({ data: { incidentId, name, geometry } });
      const event = await this.event('route.proposed', { routeId: route.id, incidentId, name: route.name, geometry: route.geometry }, { roles: ['ADMIN', 'DRIVER'] });
      await enqueueOutbox(tx, [event]);
      return route;
    });
    this.relay.nudge();
    return result;
  }

  async assignRoute(routeId: string, driverId: string) {
    const result = await this.prisma.$transaction(async (tx) => {
      const route = await tx.alternativeRoute.findUnique({ where: { id: routeId } });
      if (!route) throw new NotFoundError(`Ruta ${routeId} no encontrada`);
      if (route.status === 'ACCEPTED') throw new ConflictError('La ruta ya fue aceptada');
      const assigned = await tx.alternativeRoute.update({
        where: { id: routeId }, data: { assignedToId: driverId, assignedAt: new Date(), status: 'ASSIGNED' },
      });
      const event = await this.event('route.assigned', { routeId, incidentId: route.incidentId, driverId }, { userIds: [driverId], roles: ['ADMIN'] });
      await enqueueOutbox(tx, [event]);
      return assigned;
    });
    this.relay.nudge();
    return result;
  }

  async acceptRoute(routeId: string, driverId: string) {
    const result = await this.prisma.$transaction(async (tx) => {
      const route = await tx.alternativeRoute.findUnique({ where: { id: routeId } });
      if (!route) throw new NotFoundError(`Ruta ${routeId} no encontrada`);
      if (route.assignedToId !== driverId) throw new ConflictError('La ruta no está asignada a este conductor');
      if (route.status !== 'ASSIGNED') throw new ConflictError('La ruta no está disponible para aceptación');
      const accepted = await tx.alternativeRoute.update({ where: { id: routeId }, data: { status: 'ACCEPTED', acceptedAt: new Date() } });
      const event = await this.event('route.accepted', { routeId, incidentId: route.incidentId, driverId }, { roles: ['ADMIN'], userIds: [driverId] });
      await enqueueOutbox(tx, [event]);
      return accepted;
    });
    this.relay.nudge();
    return result;
  }

  assignedRoutes(driverId: string) {
    return this.prisma.alternativeRoute.findMany({
      where: { assignedToId: driverId, status: { in: ['ASSIGNED', 'ACCEPTED'] } },
      include: { incident: true },
      orderBy: { assignedAt: 'desc' },
    });
  }
}
