import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'crypto';
import { ConflictError, NotFoundError } from '../../../shared/domain/errors';
import { InMemoryLock } from '../../../shared/testing/in-memory-lock';
import { AcceptCallUseCase } from '../application/use-cases/accept-call.use-case';
import { DeleteIncidentUseCase } from '../application/use-cases/delete-incident.use-case';
import { ReportDriverIncidentUseCase } from '../application/use-cases/report-driver-incident.use-case';
import { RequestDriverSupportUseCase } from '../application/use-cases/request-driver-support.use-case';
import { FakeBusDirectory, InMemoryAssistanceRepository } from './support/in-memory-assistance';

Logger.overrideLogger(false);

function build() {
  const repo = new InMemoryAssistanceRepository();
  const buses = new FakeBusDirectory(repo);
  const cfg = { get: (_key: string, fallback: unknown) => fallback } as unknown as ConfigService;
  const admin = repo.addUser('1001', 'Admin', 'ADMIN');
  const reporter = repo.addUser('2001', 'Reportante', 'DRIVER');
  const helper = repo.addUser('2002', 'Ayudante', 'DRIVER');
  repo.addBus('TMX-001', reporter.id);
  repo.addBus('TMX-002', helper.id);
  const bus = repo.addBus('TMX-BROKEN');
  return {
    repo, admin, reporter, helper, bus,
    report: new ReportDriverIncidentUseCase(repo, buses),
    support: new RequestDriverSupportUseCase(repo),
    accept: new AcceptCallUseCase(repo, buses, new InMemoryLock(), cfg),
    remove: new DeleteIncidentUseCase(repo),
  };
}

describe('El admin elimina un incidente', () => {
  it('un incidente que nadie atendió se borra', async () => {
    const t = build();
    const incident = await t.report.execute(t.reporter, { busId: t.bus, type: 'ACCIDENTE' });

    await expect(t.remove.execute(incident.id)).resolves.toEqual({ deleted: true, removedCalls: 0 });
    expect(await t.repo.findIncident(incident.id)).toBeNull();
  });

  it('avisa a admin y conductores para que refresquen sus listas (evento incident.deleted)', async () => {
    const t = build();
    const incident = await t.report.execute(t.reporter, { busId: t.bus, type: 'ACCIDENTE' });
    await t.remove.execute(incident.id);

    const [event] = t.repo.ofType('incident.deleted');
    expect(event.audience.roles).toEqual(['ADMIN', 'DRIVER']);
    expect(event.payload).toMatchObject({ incidentId: incident.id, busId: t.bus });
  });

  it('con una alerta abierta que nadie aceptó: se borran el incidente y su alerta', async () => {
    const t = build();
    const incident = await t.report.execute(t.reporter, { busId: t.bus, type: 'ACCIDENTE' });
    await t.support.execute(t.admin, incident.id, { slots: 2, rewardPoints: 30 });

    await expect(t.remove.execute(incident.id)).resolves.toEqual({ deleted: true, removedCalls: 1 });
    expect(t.repo.calls.size).toBe(0);
  });

  it('si un conductor ya aceptó la alerta NO se borra nada (409): hay una atención en curso', async () => {
    const t = build();
    const incident = await t.report.execute(t.reporter, { busId: t.bus, type: 'ACCIDENTE' });
    const call = await t.support.execute(t.admin, incident.id, { slots: 2, rewardPoints: 30 });
    await t.accept.execute(t.helper, call.id);

    await expect(t.remove.execute(incident.id)).rejects.toBeInstanceOf(ConflictError);
    expect(await t.repo.findIncident(incident.id)).not.toBeNull();
    expect(t.repo.calls.size).toBe(1);
    expect(t.repo.ofType('incident.deleted')).toHaveLength(0);
  });

  it('un incidente que no existe → 404', async () => {
    await expect(build().remove.execute(randomUUID())).rejects.toBeInstanceOf(NotFoundError);
  });
});
