import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'crypto';
import { ConflictError, ForbiddenError, NotFoundError } from '../../../shared/domain/errors';
import { CompleteCallUseCase } from '../application/use-cases/complete-call.use-case';
import { InMemoryLock } from '../../../shared/testing/in-memory-lock';
import { AcceptCallUseCase } from '../application/use-cases/accept-call.use-case';
import { DeleteIncidentUseCase } from '../application/use-cases/delete-incident.use-case';
import { ReportBusFaultUseCase } from '../application/use-cases/report-bus-fault.use-case';
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
  const mechanic = repo.addUser('3001', 'Mecánico', 'MECHANICAL');
  repo.addBus('TMX-001', reporter.id);
  repo.addBus('TMX-002', helper.id);
  const bus = repo.addBus('TMX-BROKEN');
  return {
    repo, admin, reporter, helper, mechanic, bus,
    report: new ReportDriverIncidentUseCase(repo, buses),
    fault: new ReportBusFaultUseCase(repo, buses, cfg),
    complete: new CompleteCallUseCase(repo),
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

  it('avisa a admin, conductores y mecánicos para que refresquen sus listas (evento incident.deleted)', async () => {
    const t = build();
    const incident = await t.report.execute(t.reporter, { busId: t.bus, type: 'ACCIDENTE' });
    await t.remove.execute(incident.id);

    const [event] = t.repo.ofType('incident.deleted');
    expect(event.audience.roles).toEqual(['ADMIN', 'DRIVER', 'MECHANICAL']);
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

  describe('atención recibida: el conductor que reportó cierra la alerta', () => {
    async function helped() {
      const t = build();
      const incident = await t.report.execute(t.reporter, { busId: t.bus, type: 'ACCIDENTE' });
      const call = await t.support.execute(t.admin, incident.id, { slots: 1, rewardPoints: 30 });
      await t.accept.execute(t.helper, call.id);
      return { t, incident, call };
    }

    it('al confirmar: se paga a quien ayudó, la alerta se cierra y el incidente queda RESUELTO', async () => {
      const { t, incident, call } = await helped();
      await t.complete.execute(t.reporter, call.id);

      expect(t.repo.calls.get(call.id)!.status).toBe('COMPLETED');
      expect(t.repo.rewards).toEqual([{ userId: t.helper.id, callId: call.id, points: 30 }]);
      expect((await t.repo.findIncident(incident.id))!.status).toBe('RESOLVED');
    });

    it('al resolverse se emite incident.resolved (una sola vez) para que el admin lo quite de su lista al instante', async () => {
      const { t, incident, call } = await helped();
      await t.complete.execute(t.reporter, call.id);

      const events = t.repo.ofType('incident.resolved');
      expect(events).toHaveLength(1);
      expect(events[0].audience.roles).toEqual(['ADMIN']);
      expect(events[0].payload).toMatchObject({ incidentId: incident.id });
    });

    it('en un incidente ya resuelto no se puede abrir una solicitud de reparación nueva (409)', async () => {
      const { t, incident, call } = await helped();
      await t.complete.execute(t.reporter, call.id);

      await expect(t.fault.execute(t.admin, { busId: t.bus, incidentId: incident.id })).rejects.toMatchObject({
        details: { reason: 'INCIDENT_RESOLVED' },
      });
    });

    it('antes de que alguien acepte no hay nada que confirmar (409)', async () => {
      const t = build();
      const incident = await t.report.execute(t.reporter, { busId: t.bus, type: 'ACCIDENTE' });
      const call = await t.support.execute(t.admin, incident.id, { slots: 1, rewardPoints: 30 });
      await expect(t.complete.execute(t.reporter, call.id)).rejects.toBeInstanceOf(ConflictError);
    });

    it('quien ayuda no puede cerrar su propia ayuda (403) y un segundo "recibida" no paga dos veces (409)', async () => {
      const { t, call } = await helped();
      await expect(t.complete.execute(t.helper, call.id)).rejects.toBeInstanceOf(ForbiddenError);
      await t.complete.execute(t.reporter, call.id);
      await expect(t.complete.execute(t.reporter, call.id)).rejects.toBeInstanceOf(ConflictError);
      expect(t.repo.rewards).toHaveLength(1);
    });

    it('si el incidente tiene otra alerta abierta NO queda resuelto todavía', async () => {
      const { t, incident, call } = await helped();
      await t.fault.execute(t.admin, { busId: t.bus, incidentId: incident.id });
      await t.complete.execute(t.reporter, call.id);
      expect((await t.repo.findIncident(incident.id))!.status).not.toBe('RESOLVED');
    });

    it('un incidente ya terminado se puede eliminar (los puntos pagados no se pierden)', async () => {
      const { t, incident, call } = await helped();
      await t.complete.execute(t.reporter, call.id);

      await expect(t.remove.execute(incident.id)).resolves.toMatchObject({ deleted: true });
      expect(t.repo.rewards).toHaveLength(1);
    });
  });

  describe('eliminar con alguien atendiendo', () => {
    it('sin force → 409 CLAIMED (y no se toca nada)', async () => {
      const t = build();
      const incident = await t.report.execute(t.reporter, { busId: t.bus, type: 'ACCIDENTE' });
      const call = await t.support.execute(t.admin, incident.id, { slots: 2, rewardPoints: 10 });
      await t.accept.execute(t.helper, call.id);

      await expect(t.remove.execute(incident.id)).rejects.toMatchObject({ details: { reason: 'CLAIMED' } });
      expect(await t.repo.findIncident(incident.id)).not.toBeNull();
    });

    it('con force → se elimina, se cancelan las aceptaciones y nadie cobra puntos', async () => {
      const t = build();
      const incident = await t.report.execute(t.reporter, { busId: t.bus, type: 'ACCIDENTE' });
      const call = await t.support.execute(t.admin, incident.id, { slots: 2, rewardPoints: 10 });
      await t.accept.execute(t.helper, call.id);

      await expect(t.remove.execute(incident.id, { force: true })).resolves.toMatchObject({ deleted: true, removedCalls: 1 });
      expect(t.repo.calls.size).toBe(0);
      expect(t.repo.claims).toHaveLength(0);
      expect(t.repo.rewards).toHaveLength(0);

      // A quien ayudaba se le avisa por tiempo real que su aceptación se canceló.
      const [deleted] = t.repo.ofType('incident.deleted');
      expect(deleted.payload).toMatchObject({ incidentId: incident.id, affectedUserIds: [t.helper.id] });
    });
  });

  describe('solicitud de reparación enviada al mecánico desde el incidente', () => {
    it('se elimina junto con el incidente si ningún mecánico la aceptó', async () => {
      const t = build();
      const incident = await t.report.execute(t.reporter, { busId: t.bus, type: 'FALLA' });
      await t.fault.execute(t.admin, { busId: t.bus, incidentId: incident.id, description: 'motor' });
      expect(t.repo.calls.size).toBe(1);

      await expect(t.remove.execute(incident.id)).resolves.toEqual({ deleted: true, removedCalls: 1 });
      expect(t.repo.calls.size).toBe(0);
    });

    it('si un mecánico ya la aceptó NO se borra nada (409)', async () => {
      const t = build();
      const incident = await t.report.execute(t.reporter, { busId: t.bus, type: 'FALLA' });
      const { call } = await t.fault.execute(t.admin, { busId: t.bus, incidentId: incident.id });
      await t.accept.execute(t.mechanic, call.id);

      await expect(t.remove.execute(incident.id)).rejects.toBeInstanceOf(ConflictError);
      expect(t.repo.calls.size).toBe(1);
      expect(await t.repo.findIncident(incident.id)).not.toBeNull();
    });

    it('si ya había una reparación abierta del bus sin incidente, queda enlazada y se borra con él', async () => {
      const t = build();
      await t.fault.execute(t.reporter, { busId: t.bus, description: 'la pidió el conductor' });
      const incident = await t.report.execute(t.reporter, { busId: t.bus, type: 'FALLA' });
      const { duplicate } = await t.fault.execute(t.admin, { busId: t.bus, incidentId: incident.id });

      expect(duplicate).toBe(true); // sigue siendo UNA sola solicitud
      expect(t.repo.calls.size).toBe(1);
      await t.remove.execute(incident.id);
      expect(t.repo.calls.size).toBe(0);
    });

    it('una solicitud que no viene de un incidente no se toca al borrar otro incidente', async () => {
      const t = build();
      const incident = await t.report.execute(t.reporter, { busId: t.bus, type: 'FALLA' });
      const otherBus = t.repo.addBus('TMX-OTRO');
      await t.fault.execute(t.reporter, { busId: otherBus, description: 'otro bus' });

      await t.remove.execute(incident.id);
      expect(t.repo.calls.size).toBe(1);
    });

    it('enviar la solicitud con un incidente que no existe → 404', async () => {
      const t = build();
      await expect(t.fault.execute(t.admin, { busId: t.bus, incidentId: randomUUID() })).rejects.toBeInstanceOf(NotFoundError);
    });
  });
});
