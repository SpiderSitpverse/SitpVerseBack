import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ConflictError, ForbiddenError, InvalidInputError, NotFoundError } from '../../../shared/domain/errors';
import { InMemoryLock } from '../../../shared/testing/in-memory-lock';
import { AcceptCallUseCase } from '../application/use-cases/accept-call.use-case';
import { CompleteCallUseCase } from '../application/use-cases/complete-call.use-case';
import { ListCallsUseCase } from '../application/use-cases/list-calls.use-case';
import { ReportBusFaultUseCase } from '../application/use-cases/report-bus-fault.use-case';
import { ReportDriverIncidentUseCase } from '../application/use-cases/report-driver-incident.use-case';
import { RequestDriverSupportUseCase } from '../application/use-cases/request-driver-support.use-case';
import {
  GetRepairReportUseCase,
  ListRepairReportsUseCase,
  SaveRepairReportUseCase,
} from '../application/use-cases/repair-reports.use-cases';
import { FakeBusDirectory, InMemoryAssistanceRepository } from './support/in-memory-assistance';

Logger.overrideLogger(false);

const PHOTO = '/uploads/3f2c9d1e-7a4b-4c8e-9b1a-5d6e7f8a9b0c.jpg';
const PHOTO_2 = '/uploads/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee.png';

function build() {
  const repo = new InMemoryAssistanceRepository();
  const buses = new FakeBusDirectory(repo);
  const lock = new InMemoryLock();
  const cfg = { get: (_k: string, d: unknown) => d } as unknown as ConfigService;

  const admin = repo.addUser('1001', 'Admin', 'ADMIN');
  const reporter = repo.addUser('2001', 'Carlos Pérez', 'DRIVER');
  const mechanics = [0, 1, 2].map((i) => repo.addUser(`300${i}`, `Mecánico ${i}`, 'MECHANICAL'));
  const bus = repo.addBus('TLM-1006', reporter.id);

  return {
    repo, admin, reporter, mechanics, bus,
    fault: new ReportBusFaultUseCase(repo, buses, cfg),
    accept: new AcceptCallUseCase(repo, buses, lock, cfg),
    complete: new CompleteCallUseCase(repo),
    save: new SaveRepairReportUseCase(repo),
    get: new GetRepairReportUseCase(repo),
    list: new ListRepairReportsUseCase(repo, buses),
    calls: new ListCallsUseCase(repo, buses),
    incident: new ReportDriverIncidentUseCase(repo, buses),
    support: new RequestDriverSupportUseCase(repo),
  };
}
type Ctx = ReturnType<typeof build>;

/** Una reparación abierta que ya tomó el mecánico 0. */
async function repairHeldBy0(t: Ctx) {
  const { call } = await t.fault.execute(t.admin, { busId: t.bus, description: 'Falla de frenos' });
  await t.accept.execute(t.mechanics[0], call.id);
  return call;
}

const FULL = {
  damages: 'Pastillas de freno desgastadas',
  replacedParts: 'Pastillas delanteras',
  expenses: [{ concepto: 'Repuestos', valor: 180000 }, { concepto: 'Mano de obra', valor: 90000 }],
  busPhotos: [PHOTO],
  partPhotos: [PHOTO_2],
};

describe('Informe de reparación del mecánico', () => {
  it('guarda un borrador (puede estar incompleto) sin cerrar la reparación', async () => {
    const t = build();
    const call = await repairHeldBy0(t);

    const { report, completed } = await t.save.execute(t.mechanics[0], call.id, { damages: 'Revisando frenos' }, false);

    expect(completed).toBe(false);
    expect(report).toMatchObject({ damages: 'Revisando frenos', replacedParts: '', completedAt: null, mechanicName: 'Mecánico 0' });
    expect(t.repo.calls.get(call.id)!.status).toBe('FILLED'); // sigue en curso
    expect(t.repo.pointsOf(t.mechanics[0].id)).toBe(0);
  });

  it('el borrador se puede actualizar las veces que haga falta', async () => {
    const t = build();
    const call = await repairHeldBy0(t);
    await t.save.execute(t.mechanics[0], call.id, { damages: 'v1' }, false);
    const { report } = await t.save.execute(t.mechanics[0], call.id, FULL, false);
    expect(report.damages).toBe(FULL.damages);
    expect(report.expenses).toEqual(FULL.expenses);
    expect(t.repo.reports.size).toBe(1); // un solo informe por reparación
  });

  it('FINALIZAR cierra la reparación y paga el bono en la misma operación', async () => {
    const t = build();
    const call = await repairHeldBy0(t);

    const { report, completed, pointsAwardedTo } = await t.save.execute(t.mechanics[0], call.id, FULL, true);

    expect(completed).toBe(true);
    expect(report.completedAt).toBeInstanceOf(Date);
    expect(pointsAwardedTo).toEqual([t.mechanics[0].id]);
    expect(t.repo.calls.get(call.id)!.status).toBe('COMPLETED');
    expect(t.repo.pointsOf(t.mechanics[0].id)).toBe(50);
    expect(t.repo.ofType('call.completed')).toHaveLength(1);
  });

  it('un informe finalizado ya no admite cambios (409)', async () => {
    const t = build();
    const call = await repairHeldBy0(t);
    await t.save.execute(t.mechanics[0], call.id, FULL, true);
    await expect(t.save.execute(t.mechanics[0], call.id, { damages: 'cambio' }, false)).rejects.toBeInstanceOf(ConflictError);
  });

  it('finalizar exige describir los daños encontrados (400)', async () => {
    const t = build();
    const call = await repairHeldBy0(t);
    await expect(t.save.execute(t.mechanics[0], call.id, { damages: '   ' }, true)).rejects.toBeInstanceOf(InvalidInputError);
    expect(t.repo.calls.get(call.id)!.status).toBe('FILLED'); // no se cerró nada
  });

  it('finalizar 5 veces a la vez: una sola gana y el bono se paga UNA vez', async () => {
    const t = build();
    const call = await repairHeldBy0(t);
    const results = await Promise.allSettled(Array.from({ length: 5 }, () => t.save.execute(t.mechanics[0], call.id, FULL, true)));

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(t.repo.pointsOf(t.mechanics[0].id)).toBe(50);
    expect(t.repo.rewards).toHaveLength(1);
    expect(t.repo.ofType('call.completed')).toHaveLength(1);
  });

  it('el admin cierra la alerta mientras el mecánico finaliza el informe: no queda nada a medias', async () => {
    const t = build();
    const call = await repairHeldBy0(t);
    const [adminDone, mechDone] = await Promise.allSettled([
      t.complete.execute(t.admin, call.id),
      t.save.execute(t.mechanics[0], call.id, FULL, true),
    ]);

    expect([adminDone, mechDone].filter((r) => r.status === 'fulfilled')).toHaveLength(1); // uno solo cierra
    expect(t.repo.rewards).toHaveLength(1);
    const report = t.repo.reports.get(call.id);
    // Si ganó el admin, el informe final se deshizo (no hay informe "definitivo" de una alerta ya cerrada por otro)
    expect(report?.completedAt != null).toBe(mechDone.status === 'fulfilled');
  });

  it('solo el mecánico que TIENE la reparación escribe el informe', async () => {
    const t = build();
    const call = await repairHeldBy0(t);
    await expect(t.save.execute(t.mechanics[1], call.id, FULL, false)).rejects.toBeInstanceOf(ForbiddenError); // otro mecánico
    await expect(t.save.execute(t.admin, call.id, FULL, false)).rejects.toBeInstanceOf(ForbiddenError); // ni el admin
    await expect(t.save.execute(t.reporter, call.id, FULL, false)).rejects.toBeInstanceOf(ForbiddenError); // ni un conductor
  });

  it('si el admin canceló la aceptación del mecánico, ya no puede escribir el informe', async () => {
    const t = build();
    const call = await repairHeldBy0(t);
    t.repo.claims[0].status = 'CANCELLED';
    await expect(t.save.execute(t.mechanics[0], call.id, FULL, false)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('una alerta de apoyo de conductores no tiene informe de reparación', async () => {
    const t = build();
    const incident = await t.incident.execute(t.reporter, { busId: t.bus, type: 'ACCIDENTE' });
    const support = await t.support.execute(t.admin, incident.id, { slots: 1, rewardPoints: 10 });
    await expect(t.save.execute(t.mechanics[0], support.id, FULL, false)).rejects.toBeInstanceOf(ConflictError);
  });

  it('una alerta que no existe → 404', async () => {
    const t = build();
    await expect(
      t.save.execute(t.mechanics[0], '00000000-0000-4000-8000-000000000000', FULL, false),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  describe('validación de los datos', () => {
    const attempt = async (data: Record<string, unknown>) => {
      const t = build();
      const call = await repairHeldBy0(t);
      return t.save.execute(t.mechanics[0], call.id, data, false);
    };

    it('quita los renglones vacíos de gastos (el formulario siempre trae uno)', async () => {
      const { report } = await attempt({ expenses: [{ concepto: '', valor: 0 }, { concepto: 'Aceite', valor: 45000 }] });
      expect(report.expenses).toEqual([{ concepto: 'Aceite', valor: 45000 }]);
    });

    it.each([
      ['valor negativo', { expenses: [{ concepto: 'X', valor: -5 }] }],
      ['valor no numérico', { expenses: [{ concepto: 'X', valor: 'mucho' }] }],
      ['más de 30 gastos', { expenses: Array.from({ length: 31 }, (_, i) => ({ concepto: `g${i}`, valor: 1 })) }],
      ['texto de más de 4000 caracteres', { damages: 'x'.repeat(4001) }],
      ['una foto que no es de /uploads', { busPhotos: ['https://sitio-malo.com/foto.jpg'] }],
      ['un enlace javascript: como foto', { busPhotos: ['javascript:alert(1)'] }],
      ['una foto con ruta manipulada', { partPhotos: ['/uploads/../../etc/passwd'] }],
      ['más de 10 fotos', { busPhotos: Array.from({ length: 11 }, () => PHOTO) }],
    ])('rechaza %s (400)', async (_name, data) => {
      await expect(attempt(data)).rejects.toBeInstanceOf(InvalidInputError);
    });
  });

  describe('consulta', () => {
    it('el admin ve cualquier informe; el mecánico solo los suyos', async () => {
      const t = build();
      const call = await repairHeldBy0(t);
      await t.save.execute(t.mechanics[0], call.id, FULL, false);

      await expect(t.get.execute(t.admin, call.id)).resolves.toMatchObject({ damages: FULL.damages });
      await expect(t.get.execute(t.mechanics[0], call.id)).resolves.toBeDefined();
      await expect(t.get.execute(t.mechanics[1], call.id)).rejects.toBeInstanceOf(ForbiddenError);
    });

    it('una reparación sin informe → 404', async () => {
      const t = build();
      const call = await repairHeldBy0(t);
      await expect(t.get.execute(t.admin, call.id)).rejects.toBeInstanceOf(NotFoundError);
    });

    it('el historial incluye los datos del bus; el mecánico ve solo los suyos y el admin todos', async () => {
      const t = build();
      const call = await repairHeldBy0(t);
      await t.save.execute(t.mechanics[0], call.id, FULL, true);

      const mine = await t.list.execute(t.mechanics[0]);
      expect(mine).toHaveLength(1);
      expect(mine[0]).toMatchObject({ bus: { plate: 'TLM-1006' }, call: { description: 'Falla de frenos', status: 'COMPLETED' } });
      expect(await t.list.execute(t.mechanics[1])).toHaveLength(0);
      expect(await t.list.execute(t.admin)).toHaveLength(1);
    });
  });
});

describe('Alertas enriquecidas para las pantallas', () => {
  it('cada alerta trae los datos del bus (placa, troncal, ubicación)', async () => {
    const t = build();
    await t.fault.execute(t.admin, { busId: t.bus, description: 'Falla' });
    const [view] = await t.calls.execute(t.mechanics[0]);
    expect(view.bus).toMatchObject({ plate: 'TLM-1006', route: expect.any(String), locationLabel: expect.any(String) });
  });

  it('las alertas de apoyo traen el motivo, el detalle y QUIÉN reportó el incidente', async () => {
    const t = build();
    const incident = await t.incident.execute(t.reporter, { busId: t.bus, type: 'Falla mecánica', description: 'Se apagó en plena vía' });
    await t.support.execute(t.admin, incident.id, { slots: 2, rewardPoints: 20 });

    const driver = t.repo.addUser('2002', 'Laura Gómez', 'DRIVER');
    const [view] = await t.calls.execute(driver);
    expect(view.incident).toMatchObject({ type: 'Falla mecánica', description: 'Se apagó en plena vía', reportedByName: 'Carlos Pérez' });
  });

  it('una alerta de reparación no trae incidente', async () => {
    const t = build();
    await t.fault.execute(t.admin, { busId: t.bus });
    expect((await t.calls.execute(t.admin))[0].incident).toBeNull();
  });
});
