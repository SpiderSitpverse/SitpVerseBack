import { RoutingService } from '../infrastructure/prisma/routing.service';

describe('RoutingService', () => {
  it('lists blockage incidents with routes and tow assignments', async () => {
    const incidents = [{ id: 'i1', alternativeRoutes: [], towAssignments: [] }];
    const prisma = {
      driverIncident: {
        findMany: jest.fn().mockResolvedValue(incidents),
      },
    } as any;
    const service = new RoutingService(prisma, { nudge: jest.fn() } as any);

    await expect(service.listBlockages()).resolves.toEqual(incidents);
    expect(prisma.driverIncident.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ include: { alternativeRoutes: true, towAssignments: true } }),
    );
  });

  it('only returns active routes assigned to the requested driver', async () => {
    const routes = [{ id: 'r1', status: 'ASSIGNED' }];
    const prisma = {
      alternativeRoute: { findMany: jest.fn().mockResolvedValue(routes) },
    } as any;
    const service = new RoutingService(prisma, { nudge: jest.fn() } as any);

    await expect(service.assignedRoutes('driver-1')).resolves.toEqual(routes);
    expect(prisma.alternativeRoute.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { assignedToId: 'driver-1', status: { in: ['ASSIGNED', 'ACCEPTED'] } } }),
    );
  });

  it('lists tow reports with filters and incident context', async () => {
    const reports = [{ id: 'tow-1', towTruck: 'G-01', crew: 'C-1' }];
    const prisma = {
      towAssignment: { findMany: jest.fn().mockResolvedValue(reports) },
    } as any;
    const service = new RoutingService(prisma, { nudge: jest.fn() } as any);

    await expect(service.listTowReports({ towTruck: 'G-01', status: 'COMPLETED', take: 10 })).resolves.toEqual(reports);
    expect(prisma.towAssignment.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        towTruck: { contains: 'G-01', mode: 'insensitive' },
        status: 'COMPLETED',
      }),
      include: { incident: { select: { id: true, busId: true, type: true, description: true, createdAt: true } } },
      take: 10,
    }));
  });

  it('lists photographic evidence for an incident', async () => {
    const evidence = [{ id: 'photo-1', incidentId: 'incident-1', url: 'https://files/photo.jpg' }];
    const prisma = {
      incidentEvidence: { findMany: jest.fn().mockResolvedValue(evidence) },
    } as any;
    const service = new RoutingService(prisma, { nudge: jest.fn() } as any);

    await expect(service.listEvidence('incident-1')).resolves.toEqual(evidence);
    expect(prisma.incidentEvidence.findMany).toHaveBeenCalledWith({
      where: { incidentId: 'incident-1' },
      orderBy: { createdAt: 'asc' },
    });
  });
});
