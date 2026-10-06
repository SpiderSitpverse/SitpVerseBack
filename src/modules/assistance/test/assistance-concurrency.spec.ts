import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ConflictError, ForbiddenError } from '../../../shared/domain/errors';
import { InMemoryLock } from '../../../shared/testing/in-memory-lock';
import { AcceptCallUseCase } from '../application/use-cases/accept-call.use-case';
import { CancelClaimUseCase } from '../application/use-cases/cancel-claim.use-case';
import { CompleteCallUseCase } from '../application/use-cases/complete-call.use-case';
import { ListCallsUseCase } from '../application/use-cases/list-calls.use-case';
import { ReportBusFaultUseCase } from '../application/use-cases/report-bus-fault.use-case';
import { ReportDriverIncidentUseCase } from '../application/use-cases/report-driver-incident.use-case';
import { RequestDriverSupportUseCase } from '../application/use-cases/request-driver-support.use-case';
import { ResendCallUseCase } from '../application/use-cases/resend-call.use-case';
import {
  FakeBusDirectory,
  InMemoryAssistanceRepository,
} from './support/in-memory-assistance';

Logger.overrideLogger(false);

function build(config: Record<string, unknown> = {}) {
  const repo = new InMemoryAssistanceRepository();
  const buses = new FakeBusDirectory(repo);
  const lock = new InMemoryLock();
  const cfg = { get: (key: string, fallback: unknown) => config[key] ?? fallback } as unknown as ConfigService;

  const admin = repo.addUser('1001', 'Admin', 'ADMIN');
  const admin2 = repo.addUser('1002', 'Admin 2', 'ADMIN');
  const drivers = Array.from({ length: 12 }, (_, i) =>
    repo.addUser(`20${String(i).padStart(2, '0')}`, `Driver ${i}`, 'DRIVER'),
  );
  const mechanics = Array.from({ length: 5 }, (_, i) =>
    repo.addUser(`30${String(i).padStart(2, '0')}`, `Mecánico ${i}`, 'MECHANICAL'),
  );
  // cada conductor maneja su propio bus; `bus` es el que sufre el imprevisto
  drivers.forEach((d, i) => repo.addBus(`TMX-${100 + i}`, d.id));
  const bus = repo.addBus('TMX-BROKEN');

  return {
    repo, lock, admin, admin2, drivers, mechanics, bus,
    reportIncident: new ReportDriverIncidentUseCase(repo, buses),
    requestSupport: new RequestDriverSupportUseCase(repo),
    reportFault: new ReportBusFaultUseCase(repo, buses, cfg),
    accept: new AcceptCallUseCase(repo, buses, lock, cfg),
    cancel: new CancelClaimUseCase(repo, lock),
    resend: new ResendCallUseCase(repo),
    complete: new CompleteCallUseCase(repo),
    listCalls: new ListCallsUseCase(repo, buses),
  };
}
type Ctx = ReturnType<typeof build>;

/** Uso 1: incidente → admin → alerta a conductores con N cupos */
async function openSupportCall(t: Ctx, slots: number, reward = 30) {
  const incident = await t.reportIncident.execute(t.drivers[0], { busId: t.bus, type: 'ACCIDENTE' });
  return t.requestSupport.execute(t.admin, incident.id, { slots, rewardPoints: reward });
}

const fulfilled = (results: PromiseSettledResult<unknown>[]) => results.filter((r) => r.status === 'fulfilled');
const rejected = (results: PromiseSettledResult<unknown>[]) =>
  results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[];

describe('Uso 1 — apoyo de conductores: los primeros N en aceptar toman el cupo', () => {
  it('11 conductores aceptan a la vez una alerta de 3 cupos → exactamente 3 ganan y 8 reciben "cupos tomados"', async () => {
    const t = build();
    const call = await openSupportCall(t, 3);

    const results = await Promise.allSettled(t.drivers.slice(1).map((d) => t.accept.execute(d, call.id)));

    expect(fulfilled(results)).toHaveLength(3);
    expect(rejected(results)).toHaveLength(8);
    expect(rejected(results).every((r) => r.reason.details.reason === 'FULL')).toBe(true);
    const stored = t.repo.calls.get(call.id)!;
    expect(stored.claimedCount).toBe(3);
    expect(stored.status).toBe('FILLED');
    expect(t.repo.claims).toHaveLength(3);
  });

  it('FIFO: ganan los PRIMEROS en llegar, en orden (no uno cualquiera de los 11)', async () => {
    const t = build();
    const call = await openSupportCall(t, 3);
    const arrivals = t.drivers.slice(1); // llegan en este orden

    await Promise.allSettled(arrivals.map((d) => t.accept.execute(d, call.id)));

    const winners = t.repo.claims.map((c) => c.userId); // el orden en que se tomaron los cupos
    expect(winners).toEqual(arrivals.slice(0, 3).map((d) => d.id));
    expect(t.lock.maxConcurrentInside).toBe(1);
  });

  it('al aceptar se fija un plazo de 20 min (configurable) con el bus del conductor', async () => {
    const t = build();
    const call = await openSupportCall(t, 2);
    const before = Date.now();

    const { claim } = await t.accept.execute(t.drivers[1], call.id);

    const minutes = (claim.arriveBy.getTime() - before) / 60_000;
    expect(minutes).toBeGreaterThan(19.9);
    expect(minutes).toBeLessThan(20.1);
    expect(claim.bus?.plate).toBe('TMX-101'); // el bus del conductor que aceptó

    const custom = build({ ASSISTANCE_ARRIVAL_MINUTES: 5 });
    const call2 = await openSupportCall(custom, 1);
    const { claim: claim2 } = await custom.accept.execute(custom.drivers[1], call2.id);
    expect((claim2.arriveBy.getTime() - Date.now()) / 60_000).toBeLessThan(5.1);
  });

  it('el evento al admin lleva quién aceptó, su bus y el plazo para llegar', async () => {
    const t = build();
    const call = await openSupportCall(t, 2);
    await t.accept.execute(t.drivers[2], call.id);

    const progress = t.repo.ofType('call.progress')[0];
    expect(progress.audience.roles).toEqual(['ADMIN']);
    expect(progress.payload).toMatchObject({
      callId: call.id,
      claimedCount: 1,
      slots: 2,
      claim: { name: 'Driver 2', bus: { plate: 'TMX-102' } },
    });
    expect(typeof (progress.payload.claim as { arriveBy: string }).arriveBy).toBe('string');
  });

  it('al tomarse el último cupo se emite UN solo "call.closed" y progreso por cada aceptación válida', async () => {
    const t = build();
    const call = await openSupportCall(t, 3);
    await Promise.allSettled(t.drivers.slice(1).map((d) => t.accept.execute(d, call.id)));

    const closed = t.repo.ofType('call.closed');
    expect(closed).toHaveLength(1);
    expect(closed[0].audience.roles).toEqual(expect.arrayContaining(['DRIVER', 'ADMIN']));
    expect(t.repo.ofType('call.progress')).toHaveLength(3); // los 8 rechazados NO generaron eventos
    expect(t.repo.ofType('call.opened')[0].audience.roles).toEqual(['DRIVER']);
  });

  it('cada evento tiene un eventId único (el cliente puede descartar duplicados)', async () => {
    const t = build();
    const call = await openSupportCall(t, 3);
    await Promise.allSettled(t.drivers.slice(1).map((d) => t.accept.execute(d, call.id)));
    const ids = t.repo.outbox.map((e) => e.eventId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('el mismo conductor no puede ocupar dos cupos aunque haga doble clic', async () => {
    const t = build();
    const call = await openSupportCall(t, 3);
    const results = await Promise.allSettled([1, 2, 3, 4].map(() => t.accept.execute(t.drivers[1], call.id)));
    expect(fulfilled(results)).toHaveLength(1);
    expect(t.repo.calls.get(call.id)!.claimedCount).toBe(1);
  });

  it('el conductor que reportó el incidente no puede aceptar su propia alerta', async () => {
    const t = build();
    const call = await openSupportCall(t, 2);
    await expect(t.accept.execute(t.drivers[0], call.id)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('un mecánico no puede aceptar una alerta de conductores', async () => {
    const t = build();
    const call = await openSupportCall(t, 2);
    await expect(t.accept.execute(t.mechanics[0], call.id)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('dos admins lanzan la alerta del mismo incidente a la vez → solo se crea una (y un solo evento)', async () => {
    const t = build();
    const incident = await t.reportIncident.execute(t.drivers[0], { busId: t.bus, type: 'BLOQUEO' });
    const results = await Promise.allSettled([
      t.requestSupport.execute(t.admin, incident.id, { slots: 2, rewardPoints: 10 }),
      t.requestSupport.execute(t.admin2, incident.id, { slots: 5, rewardPoints: 10 }),
    ]);
    expect(fulfilled(results)).toHaveLength(1);
    expect(t.repo.calls.size).toBe(1);
    expect(t.repo.ofType('call.opened')).toHaveLength(1);
  });

  it('al completar, TODOS los que tomaron cupo cobran y solo una vez (aunque se complete 5 veces a la vez)', async () => {
    const t = build();
    const call = await openSupportCall(t, 3, 30);
    await Promise.allSettled(t.drivers.slice(1).map((d) => t.accept.execute(d, call.id)));
    const winners = t.repo.claims.map((c) => c.userId);

    const results = await Promise.allSettled(Array.from({ length: 5 }, () => t.complete.execute(t.admin, call.id)));
    expect(fulfilled(results)).toHaveLength(1);
    for (const d of t.drivers) expect(t.repo.pointsOf(d.id)).toBe(winners.includes(d.id) ? 30 : 0);
    expect(t.repo.rewards).toHaveLength(3);
  });

  it('un cupo parcial también paga: si solo aceptaron 2 de 5, esos 2 cobran al completar', async () => {
    const t = build();
    const call = await openSupportCall(t, 5, 20);
    await t.accept.execute(t.drivers[1], call.id);
    await t.accept.execute(t.drivers[2], call.id);
    await t.complete.execute(t.admin, call.id);
    expect(t.repo.pointsOf(t.drivers[1].id)).toBe(20);
    expect(t.repo.pointsOf(t.drivers[2].id)).toBe(20);
    expect(t.repo.pointsOf(t.drivers[3].id)).toBe(0);
  });
});

describe('Plazo de llegada: el admin cancela y reenvía', () => {
  it('una aceptación vencida se marca "overdue" para el admin (y solo el admin ve las de otros)', async () => {
    const t = build();
    const call = await openSupportCall(t, 3);
    await t.accept.execute(t.drivers[1], call.id);
    await t.accept.execute(t.drivers[2], call.id);
    t.repo.claims[0].arriveBy = new Date(Date.now() - 60_000); // pasaron los 20 min

    const [adminView] = await t.listCalls.execute(t.admin);
    expect(adminView.claims.map((c) => c.overdue)).toEqual([true, false]);
    expect(adminView.claims.map((c) => c.userName)).toEqual(['Driver 1', 'Driver 2']);

    const [driverView] = await t.listCalls.execute(t.drivers[2]); // ve SOLO la suya, con su cuenta regresiva
    expect(driverView.claims).toHaveLength(1);
    expect(driverView.claims[0].userId).toBe(t.drivers[2].id);
    expect(driverView.claims[0].arriveBy).toBeInstanceOf(Date);
  });

  it('cancelar libera el cupo: la alerta llena vuelve a OPEN y se avisa al admin y al cancelado', async () => {
    const t = build();
    const call = await openSupportCall(t, 2);
    await t.accept.execute(t.drivers[1], call.id);
    await t.accept.execute(t.drivers[2], call.id);
    expect(t.repo.calls.get(call.id)!.status).toBe('FILLED');

    await t.cancel.execute(t.admin, call.id, t.repo.claims[0].id);

    expect(t.repo.calls.get(call.id)).toMatchObject({ status: 'OPEN', claimedCount: 1 });
    const cancelled = t.repo.ofType('claim.cancelled')[0];
    expect(cancelled.audience).toEqual({ roles: ['ADMIN'], userIds: [t.drivers[1].id] });
  });

  it('reenviar vuelve a notificar a los conductores con los cupos libres; con la alerta llena se rechaza', async () => {
    const t = build();
    const call = await openSupportCall(t, 2);
    await t.accept.execute(t.drivers[1], call.id);
    await t.accept.execute(t.drivers[2], call.id);
    await expect(t.resend.execute(call.id)).rejects.toBeInstanceOf(ConflictError); // llena

    await t.cancel.execute(t.admin, call.id, t.repo.claims[0].id);
    await t.resend.execute(call.id);

    const reopened = t.repo.ofType('call.opened').at(-1)!;
    expect(reopened.audience.roles).toEqual(['DRIVER']);
    expect(reopened.payload).toMatchObject({ callId: call.id, remainingSlots: 1, resent: true });
  });

  it('el cancelado no puede retomar el cupo y otro conductor sí', async () => {
    const t = build();
    const call = await openSupportCall(t, 1);
    await t.accept.execute(t.drivers[1], call.id);
    await t.cancel.execute(t.admin, call.id, t.repo.claims[0].id);

    await expect(t.accept.execute(t.drivers[1], call.id)).rejects.toMatchObject({
      details: { reason: 'CANCELLED' },
    });
    await t.accept.execute(t.drivers[2], call.id);
    expect(t.repo.calls.get(call.id)).toMatchObject({ status: 'FILLED', claimedCount: 1 });
  });

  it('tras cancelar, 8 conductores compiten por el cupo liberado → exactamente 1 lo toma', async () => {
    const t = build();
    const call = await openSupportCall(t, 1);
    await t.accept.execute(t.drivers[1], call.id);
    await t.cancel.execute(t.admin, call.id, t.repo.claims[0].id);

    const results = await Promise.allSettled(t.drivers.slice(2, 10).map((d) => t.accept.execute(d, call.id)));
    expect(fulfilled(results)).toHaveLength(1);
    expect(t.repo.claims.filter((c) => c.status === 'ACTIVE')).toHaveLength(1);
  });

  it('cancelar la misma aceptación dos veces a la vez → solo una cancelación gana', async () => {
    const t = build();
    const call = await openSupportCall(t, 3);
    await t.accept.execute(t.drivers[1], call.id);
    const claimId = t.repo.claims[0].id;

    const results = await Promise.allSettled([
      t.cancel.execute(t.admin, call.id, claimId),
      t.cancel.execute(t.admin2, call.id, claimId),
    ]);
    expect(fulfilled(results)).toHaveLength(1);
    expect(t.repo.calls.get(call.id)!.claimedCount).toBe(0); // nunca negativo
  });

  it('el cancelado NO cobra al completar; solo cobran las aceptaciones activas', async () => {
    const t = build();
    const call = await openSupportCall(t, 2, 40);
    await t.accept.execute(t.drivers[1], call.id);
    await t.accept.execute(t.drivers[2], call.id);
    await t.cancel.execute(t.admin, call.id, t.repo.claims[0].id);
    await t.complete.execute(t.admin, call.id);

    expect(t.repo.pointsOf(t.drivers[1].id)).toBe(0);
    expect(t.repo.pointsOf(t.drivers[2].id)).toBe(40);
  });

  it('no se puede cancelar una alerta ya completada', async () => {
    const t = build();
    const call = await openSupportCall(t, 1);
    await t.accept.execute(t.drivers[1], call.id);
    await t.complete.execute(t.admin, call.id);
    await expect(t.cancel.execute(t.admin, call.id, t.repo.claims[0].id)).rejects.toBeInstanceOf(ConflictError);
  });
});

describe('Uso 2 — fallo de bus: el primer mecánico en aceptar se queda la reparación', () => {
  it('5 mecánicos aceptan a la vez → exactamente 1 gana (el primero en llegar) y la alerta se cierra', async () => {
    const t = build();
    const { call } = await t.reportFault.execute(t.drivers[0], { busId: t.bus, description: 'Motor' });
    expect(call.slots).toBe(1);
    expect(t.repo.ofType('call.opened')[0].audience.roles).toEqual(['MECHANICAL']);

    const results = await Promise.allSettled(t.mechanics.map((m) => t.accept.execute(m, call.id)));
    expect(fulfilled(results)).toHaveLength(1);
    expect(t.repo.claims[0].userId).toBe(t.mechanics[0].id); // FIFO
    expect(t.repo.calls.get(call.id)!.status).toBe('FILLED');
    expect(t.repo.ofType('call.closed')).toHaveLength(1);
  });

  it('el mecánico tiene plazo de 20 min, también visible para él', async () => {
    const t = build();
    const { call } = await t.reportFault.execute(t.drivers[0], { busId: t.bus });
    await t.accept.execute(t.mechanics[0], call.id);
    const [view] = await t.listCalls.execute(t.mechanics[0]);
    expect(view.claims).toHaveLength(1);
    expect(view.claims[0].overdue).toBe(false);
    expect((view.claims[0].arriveBy.getTime() - Date.now()) / 60_000).toBeGreaterThan(19);
  });

  it('el mecánico ganador cobra el bono (50 por defecto) al completar y los demás no', async () => {
    const t = build();
    const { call } = await t.reportFault.execute(t.drivers[0], { busId: t.bus });
    await Promise.allSettled(t.mechanics.map((m) => t.accept.execute(m, call.id)));
    const winner = t.mechanics[0];

    await t.complete.execute(winner, call.id);
    expect(t.repo.pointsOf(winner.id)).toBe(50);
    expect(t.mechanics.slice(1).every((m) => t.repo.pointsOf(m.id) === 0)).toBe(true);
  });

  it('un mecánico que NO tomó la reparación no puede completarla', async () => {
    const t = build();
    const { call } = await t.reportFault.execute(t.drivers[0], { busId: t.bus });
    await t.accept.execute(t.mechanics[0], call.id);
    await expect(t.complete.execute(t.mechanics[1], call.id)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('si el admin cancela al mecánico que no llegó, otro mecánico puede tomar la reparación', async () => {
    const t = build();
    const { call } = await t.reportFault.execute(t.drivers[0], { busId: t.bus });
    await t.accept.execute(t.mechanics[0], call.id);
    await t.cancel.execute(t.admin, call.id, t.repo.claims[0].id);
    await t.resend.execute(call.id);
    await t.accept.execute(t.mechanics[1], call.id);

    await t.complete.execute(t.mechanics[1], call.id);
    expect(t.repo.pointsOf(t.mechanics[0].id)).toBe(0);
    expect(t.repo.pointsOf(t.mechanics[1].id)).toBe(50);
  });

  it('reportes simultáneos de falla del mismo bus (conductor + admin + doble clic) → UNA sola alerta', async () => {
    const t = build();
    const results = await Promise.all([
      t.reportFault.execute(t.drivers[0], { busId: t.bus }),
      t.reportFault.execute(t.admin, { busId: t.bus }),
      t.reportFault.execute(t.drivers[0], { busId: t.bus }),
      t.reportFault.execute(t.admin2, { busId: t.bus }),
    ]);
    expect(results.filter((r) => !r.duplicate)).toHaveLength(1);
    expect(t.repo.calls.size).toBe(1);
    expect(t.repo.ofType('call.opened')).toHaveLength(1); // los mecánicos reciben UNA notificación
  });

  it('tras completar la reparación, el bus puede volver a generar una alerta nueva', async () => {
    const t = build();
    const { call } = await t.reportFault.execute(t.drivers[0], { busId: t.bus });
    await t.accept.execute(t.mechanics[0], call.id);
    await t.complete.execute(t.mechanics[0], call.id);
    const again = await t.reportFault.execute(t.drivers[0], { busId: t.bus });
    expect(again.duplicate).toBe(false);
    expect(again.call.id).not.toBe(call.id);
  });
});

describe('Estrés y visibilidad por rol', () => {
  it('300 aceptaciones simultáneas sobre 20 alertas de 3 cupos: nunca hay más reclamos que cupos', async () => {
    const t = build();
    const calls = [];
    for (let i = 0; i < 20; i++) calls.push(await openSupportCall(t, 3));
    const extra = Array.from({ length: 15 }, (_, i) => t.repo.addUser(`9${i}`, `D${i}`, 'DRIVER'));
    const pool = [...t.drivers.slice(1), ...extra]; // 26 conductores elegibles

    const started = Date.now();
    await Promise.allSettled(calls.flatMap((c) => pool.map((d) => t.accept.execute(d, c.id))));
    expect(Date.now() - started).toBeLessThan(5000);

    for (const c of calls) {
      const claims = t.repo.claims.filter((x) => x.callId === c.id);
      expect(claims).toHaveLength(3);
      expect(new Set(claims.map((x) => x.userId)).size).toBe(3);
      expect(t.repo.calls.get(c.id)!.claimedCount).toBe(3);
    }
  });

  it('cada rol ve solo sus alertas; el admin ve todas', async () => {
    const t = build();
    await openSupportCall(t, 2);
    await t.reportFault.execute(t.admin, { busId: t.bus });
    expect(await t.listCalls.execute(t.drivers[1])).toHaveLength(1);
    expect((await t.listCalls.execute(t.drivers[1]))[0].kind).toBe('DRIVER_SUPPORT');
    expect((await t.listCalls.execute(t.mechanics[0]))[0].kind).toBe('REPAIR');
    expect(await t.listCalls.execute(t.admin)).toHaveLength(2);
  });
});
