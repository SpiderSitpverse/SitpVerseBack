import { Injectable } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { PrismaService } from '../../../../shared/infrastructure/prisma.service';
import { OutboxRelay } from '../../../../shared/infrastructure/outbox/outbox.relay';
import { enqueueOutbox } from '../../../../shared/infrastructure/outbox/outbox.writer';
import { REDIS_STREAMS } from '../../../../shared/contracts/realtime.contract';
import { ConflictError, NotFoundError } from '../../../../shared/domain/errors';

@Injectable()
export class RoutingService {
  constructor(private readonly prisma: PrismaService, private readonly relay: OutboxRelay) {}

  private async event(type: string, payload: Record<string, unknown>, audience: object) {
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

  async reportBlockage(data: { busId: string; reportedById: string; type: string; description?: string }) {
    const incident = await this.prisma.$transaction(async (tx) => {
      const created = await tx.driverIncident.create({ data });
      const event = await this.event('blockage.reported', { incidentId: created.id, busId: created.busId }, { roles: ['ADMIN'] });
      await enqueueOutbox(tx, [event]);
      return created;
    });
    this.relay.nudge();
    return incident;
  }

  async assignTow(actorId: string, data: { incidentId: string; towTruck: string; crew: string }) {
    const result = await this.prisma.$transaction(async (tx) => {
      const incident = await tx.driverIncident.findUnique({ where: { id: data.incidentId } });
      if (!incident) throw new NotFoundError(`Incidente ${data.incidentId} no encontrado`);
      const assignment = await tx.towAssignment.create({ data: { ...data, busId: incident.busId, assignedById: actorId } });
      const event = await this.event('tow.assigned', { assignmentId: assignment.id, incidentId: incident.id, busId: incident.busId }, { roles: ['ADMIN', 'DRIVER', 'MECHANICAL'] });
      await enqueueOutbox(tx, [event]);
      return assignment;
    });
    this.relay.nudge();
    return result;
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
    const result = await this.prisma.$transaction(async (tx) => {
      const incident = await tx.driverIncident.findUnique({ where: { id: incidentId } });
      if (!incident) throw new NotFoundError(`Incidente ${incidentId} no encontrado`);
      const route = await tx.alternativeRoute.create({ data: { incidentId, name: data.name, geometry: data.geometry as object } });
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
