import { ConflictError, InvalidInputError, NotFoundError } from '../../../shared/domain/errors';
import { RoutingService } from '../infrastructure/prisma/routing.service';

/**
 * Base de datos simulada que REPRODUCE la carrera real:
 * - cada consulta cede el turno (`setImmediate`), como una ida y vuelta a Postgres;
 * - `$executeRaw` hace de `pg_advisory_xact_lock`: el segundo que pide la misma clave espera
 *   a que el primero termine su transacción.
 * Con `lockEnabled: false` el lock no existe y la carrera se ve (prueba de control).
 */
function fakeDb(opts: { lockEnabled: boolean } = { lockEnabled: true }) {
  const assignments: any[] = [];
  const events: any[] = [];
  const lockOrder: string[] = [];
  const queues = new Map<string, Promise<void>>();
  let seq = 0;
  const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
  const eq = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

  const matches = (row: any, where: any) =>
    (where.id === undefined || row.id === where.id) &&
    (where.towTruck === undefined || eq(row.towTruck, where.towTruck.equals)) &&
    (where.crew === undefined || eq(row.crew, where.crew.equals)) &&
    (where.status === undefined || where.status.in.includes(row.status));

  const prisma = {
    $transaction: async (fn: (tx: any) => Promise<unknown>) => {
      const releases: Array<() => void> = [];
      const tx = {
        $executeRaw: async (_strings: TemplateStringsArray, ...values: unknown[]) => {
          if (!opts.lockEnabled) return 1;
          const key = values.join(':');
          lockOrder.push(key);
          const previous = queues.get(key) ?? Promise.resolve();
          let release!: () => void;
          const mine = new Promise<void>((resolve) => (release = resolve));
          queues.set(key, previous.then(() => mine));
          await previous;
          releases.push(release);
          return 1;
        },
        driverIncident: {
          findUnique: async ({ where }: any) => ({ id: where.id, busId: `bus-of-${where.id}` }),
        },
        towAssignment: {
          findFirst: async ({ where }: any) => {
            await tick();
            return assignments.find((row) => matches(row, where)) ?? null;
          },
          create: async ({ data }: any) => {
            await tick();
            const row = { id: `tow-${++seq}`, status: 'ASSIGNED', completedAt: null, ...data };
            assignments.push(row);
            return row;
          },
          findUnique: async ({ where }: any) => assignments.find((row) => row.id === where.id) ?? null,
          findUniqueOrThrow: async ({ where }: any) => assignments.find((row) => row.id === where.id),
          updateMany: async ({ where, data }: any) => {
            await tick();
            const found = assignments.filter((row) => matches(row, where));
            found.forEach((row) => Object.assign(row, data));
            return { count: found.length };
          },
        },
        outboxEvent: {
          createMany: async ({ data }: any) => {
            events.push(...data.map((d: any) => d.payload));
          },
        },
      };
      try {
        return await fn(tx);
      } finally {
        releases.forEach((release) => release());
      }
    },
  } as any;

  return { prisma, assignments, events, lockOrder };
}

const build = (opts?: { lockEnabled: boolean }) => {
  const db = fakeDb(opts);
  const relay = { nudge: jest.fn() } as any;
  return { ...db, service: new RoutingService(db.prisma, relay), relay };
};

async function reason(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(ConflictError);
    return (error as ConflictError).details.reason as string;
  }
  return undefined;
}

describe('HU-30 · asignar grúa y cuadrilla', () => {
  it('asigna, guarda los nombres normalizados y avisa por evento', async () => {
    const t = build();

    const row = await t.service.assignTow('admin-1', { incidentId: 'inc-1', towTruck: '  g-01 ', crew: 'cuadrilla   norte' });

    expect(row).toMatchObject({ towTruck: 'G-01', crew: 'CUADRILLA NORTE', incidentId: 'inc-1', status: 'ASSIGNED' });
    expect(t.events.map((e) => e.type)).toEqual(['tow.assigned']);
    expect(t.relay.nudge).toHaveBeenCalled();
  });

  it('toma el lock de la grúa antes que el de la cuadrilla (orden fijo: evita bloqueos mutuos)', async () => {
    const t = build();
    await t.service.assignTow('admin-1', { incidentId: 'inc-1', towTruck: 'G-01', crew: 'C-1' });
    expect(t.lockOrder).toEqual(['tow-truck:G-01', 'tow-crew:C-1']);
  });

  it('rechaza una grúa que ya está en un servicio activo, aunque la escriban distinto', async () => {
    const t = build();
    await t.service.assignTow('admin-1', { incidentId: 'inc-1', towTruck: 'G-01', crew: 'C-1' });

    for (const variant of ['G-01', 'g-01', '  G-01  ']) {
      const why = await reason(t.service.assignTow('admin-1', { incidentId: 'inc-2', towTruck: variant, crew: 'C-2' }));
      expect(why).toBe('TOW_TRUCK_BUSY');
    }
    expect(t.assignments).toHaveLength(1);
  });

  it('rechaza una cuadrilla que ya está en un servicio activo', async () => {
    const t = build();
    await t.service.assignTow('admin-1', { incidentId: 'inc-1', towTruck: 'G-01', crew: 'C-1' });

    const why = await reason(t.service.assignTow('admin-1', { incidentId: 'inc-2', towTruck: 'G-02', crew: 'c-1' }));

    expect(why).toBe('CREW_BUSY');
    expect(t.assignments).toHaveLength(1);
  });

  it('el 409 dice qué asignación la tiene ocupada, para que el front lo muestre', async () => {
    const t = build();
    const first = await t.service.assignTow('admin-1', { incidentId: 'inc-1', towTruck: 'G-01', crew: 'C-1' });
    try {
      await t.service.assignTow('admin-1', { incidentId: 'inc-2', towTruck: 'G-01', crew: 'C-2' });
      throw new Error('Debió fallar');
    } catch (error) {
      expect((error as ConflictError).details).toMatchObject({ assignmentId: first.id, incidentId: 'inc-1' });
    }
  });

  it('un nombre vacío o de solo espacios se rechaza', async () => {
    const t = build();
    await expect(t.service.assignTow('a', { incidentId: 'inc-1', towTruck: '   ', crew: 'C-1' })).rejects.toBeInstanceOf(InvalidInputError);
    await expect(t.service.assignTow('a', { incidentId: 'inc-1', towTruck: 'G-01', crew: '' })).rejects.toBeInstanceOf(InvalidInputError);
  });

  describe('concurrencia', () => {
    it('dos admins asignan la MISMA grúa a la vez: solo uno lo logra', async () => {
      const t = build();

      const results = await Promise.allSettled([
        t.service.assignTow('admin-1', { incidentId: 'inc-1', towTruck: 'G-01', crew: 'C-1' }),
        t.service.assignTow('admin-2', { incidentId: 'inc-2', towTruck: 'G-01', crew: 'C-2' }),
      ]);

      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      const rejected = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
      expect((rejected.reason as ConflictError).details.reason).toBe('TOW_TRUCK_BUSY');
      expect(t.assignments).toHaveLength(1);
    });

    it('20 peticiones simultáneas por la misma grúa: exactamente una gana', async () => {
      const t = build();

      const results = await Promise.allSettled(
        Array.from({ length: 20 }, (_, i) =>
          t.service.assignTow(`admin-${i}`, { incidentId: `inc-${i}`, towTruck: 'G-01', crew: `C-${i}` }),
        ),
      );

      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect(t.assignments).toHaveLength(1);
    });

    it('la MISMA cuadrilla con grúas distintas a la vez: solo una asignación', async () => {
      const t = build();

      const results = await Promise.allSettled([
        t.service.assignTow('admin-1', { incidentId: 'inc-1', towTruck: 'G-01', crew: 'C-1' }),
        t.service.assignTow('admin-2', { incidentId: 'inc-2', towTruck: 'G-02', crew: 'C-1' }),
      ]);

      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      const rejected = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
      expect((rejected.reason as ConflictError).details.reason).toBe('CREW_BUSY');
    });

    it('recursos distintos no se estorban: todas las asignaciones válidas pasan', async () => {
      const t = build();

      const results = await Promise.allSettled(
        Array.from({ length: 10 }, (_, i) =>
          t.service.assignTow('admin', { incidentId: `inc-${i}`, towTruck: `G-${i}`, crew: `C-${i}` }),
        ),
      );

      expect(results.every((r) => r.status === 'fulfilled')).toBe(true);
      expect(t.assignments).toHaveLength(10);
    });

    it('CONTROL: sin el lock, la misma carrera sí duplica la grúa (el test detecta el bug)', async () => {
      const t = build({ lockEnabled: false });

      await Promise.allSettled([
        t.service.assignTow('admin-1', { incidentId: 'inc-1', towTruck: 'G-01', crew: 'C-1' }),
        t.service.assignTow('admin-2', { incidentId: 'inc-2', towTruck: 'G-01', crew: 'C-2' }),
      ]);

      expect(t.assignments).toHaveLength(2); // el bug que el lock evita
    });
  });
});

describe('HU-30/HU-50 · completar el servicio de grúa', () => {
  it('libera la grúa y la cuadrilla: se pueden asignar de nuevo', async () => {
    const t = build();
    const first = await t.service.assignTow('admin-1', { incidentId: 'inc-1', towTruck: 'G-01', crew: 'C-1' });

    const done = await t.service.completeTow(first.id);

    expect(done.status).toBe('COMPLETED');
    expect(done.completedAt).toBeInstanceOf(Date);
    expect(t.events.map((e) => e.type)).toEqual(['tow.assigned', 'tow.completed']);

    const again = await t.service.assignTow('admin-1', { incidentId: 'inc-2', towTruck: 'G-01', crew: 'C-1' });
    expect(again.incidentId).toBe('inc-2');
  });

  it('completar dos veces responde 409 ALREADY_COMPLETED y no repite el evento', async () => {
    const t = build();
    const first = await t.service.assignTow('admin-1', { incidentId: 'inc-1', towTruck: 'G-01', crew: 'C-1' });
    await t.service.completeTow(first.id);

    expect(await reason(t.service.completeTow(first.id))).toBe('ALREADY_COMPLETED');
    expect(t.events.filter((e) => e.type === 'tow.completed')).toHaveLength(1);
  });

  it('dos peticiones simultáneas para completar: una sola cambia el estado', async () => {
    const t = build();
    const first = await t.service.assignTow('admin-1', { incidentId: 'inc-1', towTruck: 'G-01', crew: 'C-1' });

    const results = await Promise.allSettled([t.service.completeTow(first.id), t.service.completeTow(first.id)]);

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(t.events.filter((e) => e.type === 'tow.completed')).toHaveLength(1);
  });

  it('una asignación que no existe responde 404', async () => {
    const t = build();
    await expect(t.service.completeTow('no-existe')).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe('HU-47 · proponer ruta alternativa', () => {
  function routeDb() {
    const created: any[] = [];
    const events: any[] = [];
    const tx = {
      driverIncident: { findUnique: async ({ where }: any) => ({ id: where.id, busId: 'b1' }) },
      alternativeRoute: {
        create: async ({ data }: any) => {
          const row = { id: 'r1', ...data };
          created.push(row);
          return row;
        },
      },
      outboxEvent: { createMany: async ({ data }: any) => events.push(...data.map((d: any) => d.payload)) },
    };
    const prisma = { $transaction: jest.fn(async (fn: any) => fn(tx)) } as any;
    return { prisma, created, events };
  }

  it('guarda el trazado validado y el nombre sin espacios sobrantes', async () => {
    const db = routeDb();
    const service = new RoutingService(db.prisma, { nudge: jest.fn() } as any);

    await service.createRoute('admin-1', 'inc-1', { name: '  Desvío por la 26  ', geometry: [[4.6, -74.1], [4.7, -74.2]] });

    expect(db.created[0]).toMatchObject({ name: 'Desvío por la 26', geometry: [[4.6, -74.1], [4.7, -74.2]] });
    expect(db.events[0]).toMatchObject({ type: 'route.proposed' });
  });

  it('una geometría inválida se rechaza SIN abrir transacción ni publicar nada', async () => {
    const db = routeDb();
    const service = new RoutingService(db.prisma, { nudge: jest.fn() } as any);

    await expect(
      service.createRoute('admin-1', 'inc-1', { name: 'Ruta', geometry: [[4.6, -74.1], ['x', 'y']] }),
    ).rejects.toBeInstanceOf(InvalidInputError);

    expect(db.prisma.$transaction).not.toHaveBeenCalled();
    expect(db.events).toHaveLength(0);
  });

  it('un nombre de solo espacios se rechaza', async () => {
    const db = routeDb();
    const service = new RoutingService(db.prisma, { nudge: jest.fn() } as any);

    await expect(
      service.createRoute('admin-1', 'inc-1', { name: '   ', geometry: [[4.6, -74.1], [4.7, -74.2]] }),
    ).rejects.toBeInstanceOf(InvalidInputError);
  });
});
