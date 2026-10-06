import { randomUUID } from 'crypto';
import { ForbiddenError, InvalidInputError, NotFoundError } from '../../../shared/domain/errors';
import { AuthenticatedUser } from '../../identity/public';
import {
  CreateInspectionUseCase,
  GetLatestInspectionUseCase,
  ListInspectionsUseCase,
} from '../application/use-cases/inspections.use-cases';
import { InspectionFilter, InspectionModel, NewInspection } from '../domain/models/inspection.models';
import { InspectionBusDirectoryPort } from '../domain/ports/bus-directory.port';
import { InspectionRepositoryPort } from '../domain/ports/inspection-repository.port';

const PHOTO = '/uploads/3f2c9d1e-7a4b-4c8e-9b1a-5d6e7f8a9b0c.jpg';

class InMemoryInspections implements InspectionRepositoryPort {
  rows: InspectionModel[] = [];
  async create(data: NewInspection) {
    const row: InspectionModel = { id: randomUUID(), createdAt: new Date(Date.now() + this.rows.length), comment: null, ...data, comment_: undefined } as never;
    row.comment = data.comment ?? null;
    this.rows.push(row);
    return { ...row };
  }
  async findLatestByBus(busId: string) {
    return [...this.rows].filter((r) => r.busId === busId).sort((a, b) => +b.createdAt - +a.createdAt)[0] ?? null;
  }
  async list(f: InspectionFilter) {
    return this.rows
      .filter((r) => !f.busId || r.busId === f.busId)
      .filter((r) => !f.inspector || r.inspectorName.toLowerCase().includes(f.inspector.toLowerCase()))
      .sort((a, b) => +b.createdAt - +a.createdAt)
      .slice(f.skip, f.skip + f.take);
  }
}

const user = (id: string, name: string, role: AuthenticatedUser['role']): AuthenticatedUser => ({ id, employeeId: id, name, role });

function build() {
  const buses = new Map<string, string | null>([['bus-1', 'd1'], ['bus-2', 'd2'], ['bus-3', null]]); // bus -> conductor
  const directory: InspectionBusDirectoryPort = {
    exists: async (id) => buses.has(id),
    findBusIdOfDriver: async (userId) => [...buses].find(([, d]) => d === userId)?.[0] ?? null,
  };
  const repo = new InMemoryInspections();
  return {
    repo,
    admin: user('a1', 'Admin', 'ADMIN'),
    d1: user('d1', 'Carlos Pérez', 'DRIVER'),
    d2: user('d2', 'Laura Gómez', 'DRIVER'),
    mech: user('m1', 'Camilo Torres', 'MECHANICAL'),
    create: new CreateInspectionUseCase(repo, directory),
    latest: new GetLatestInspectionUseCase(repo, directory),
    list: new ListInspectionsUseCase(repo),
  };
}

describe('Registrar inspección previa al viaje', () => {
  it('el conductor registra la inspección de SU bus, con su nombre, rol y fotos', async () => {
    const t = build();
    const saved = await t.create.execute(t.d1, { busId: 'bus-1', note: 'Todo en orden', comment: 'Llanta trasera con desgaste', photos: [PHOTO] });

    expect(saved).toMatchObject({
      busId: 'bus-1', inspectorId: 'd1', inspectorName: 'Carlos Pérez', inspectorRole: 'DRIVER',
      note: 'Todo en orden', comment: 'Llanta trasera con desgaste', photos: [PHOTO],
    });
  });

  it('un conductor NO puede registrar la inspección del bus de otro (403)', async () => {
    const t = build();
    await expect(t.create.execute(t.d1, { busId: 'bus-2', note: 'x' })).rejects.toBeInstanceOf(ForbiddenError);
    expect(t.repo.rows).toHaveLength(0);
  });

  it('un conductor sin bus asignado no puede registrar nada (403)', async () => {
    const t = build();
    const sinBus = user('d9', 'Sin Bus', 'DRIVER');
    await expect(t.create.execute(sinBus, { busId: 'bus-3', note: 'x' })).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('el admin puede registrar la de cualquier bus; el mecánico no registra inspecciones previas', async () => {
    const t = build();
    await expect(t.create.execute(t.admin, { busId: 'bus-2', note: 'Revisión del patio' })).resolves.toBeDefined();
    await expect(t.create.execute(t.mech, { busId: 'bus-2', note: 'x' })).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('un bus que no existe → 404', async () => {
    const t = build();
    await expect(t.create.execute(t.admin, { busId: 'bus-99', note: 'x' })).rejects.toBeInstanceOf(NotFoundError);
  });

  it.each([
    ['nota vacía', { note: '   ' }],
    ['nota de más de 2000 caracteres', { note: 'x'.repeat(2001) }],
    ['más de 10 fotos', { note: 'ok', photos: Array.from({ length: 11 }, () => PHOTO) }],
    ['una foto de un sitio externo', { note: 'ok', photos: ['https://malo.com/a.jpg'] }],
    ['una foto con javascript:', { note: 'ok', photos: ['javascript:alert(document.cookie)'] }],
    ['una foto con ruta manipulada', { note: 'ok', photos: ['/uploads/../.env'] }],
    ['una foto con extensión no permitida', { note: 'ok', photos: ['/uploads/3f2c9d1e-7a4b-4c8e-9b1a-5d6e7f8a9b0c.php'] }],
  ])('rechaza %s (400) y no guarda nada', async (_name, data) => {
    const t = build();
    await expect(t.create.execute(t.d1, { busId: 'bus-1', ...data })).rejects.toBeInstanceOf(InvalidInputError);
    expect(t.repo.rows).toHaveLength(0);
  });

  it('las inspecciones son inmutables: el puerto solo permite agregar y consultar', () => {
    const t = build();
    const methods = Object.getOwnPropertyNames(Object.getPrototypeOf(t.repo)).filter((m) => m !== 'constructor');
    expect(methods.sort()).toEqual(['create', 'findLatestByBus', 'list']);
  });
});

describe('Consultar inspecciones', () => {
  it('la más reciente de un bus es la que se muestra al abrirlo', async () => {
    const t = build();
    await t.create.execute(t.d1, { busId: 'bus-1', note: 'primera' });
    await t.create.execute(t.d1, { busId: 'bus-1', note: 'segunda' });
    expect((await t.latest.execute(t.admin, 'bus-1')).note).toBe('segunda');
  });

  it('un bus nunca inspeccionado → 404', async () => {
    const t = build();
    await expect(t.latest.execute(t.admin, 'bus-1')).rejects.toBeInstanceOf(NotFoundError);
  });

  it('el admin y el mecánico consultan cualquier bus; el conductor solo el suyo', async () => {
    const t = build();
    await t.create.execute(t.admin, { busId: 'bus-2', note: 'x' });
    await expect(t.latest.execute(t.mech, 'bus-2')).resolves.toBeDefined();
    await expect(t.latest.execute(t.d2, 'bus-2')).resolves.toBeDefined();
    await expect(t.latest.execute(t.d1, 'bus-2')).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('el historial filtra por bus y por quién inspeccionó, de la más reciente a la más antigua', async () => {
    const t = build();
    await t.create.execute(t.d1, { busId: 'bus-1', note: 'uno' });
    await t.create.execute(t.d2, { busId: 'bus-2', note: 'dos' });
    await t.create.execute(t.d1, { busId: 'bus-1', note: 'tres' });

    const all = await t.list.execute({ take: 50, skip: 0 });
    expect(all.map((r) => r.note)).toEqual(['tres', 'dos', 'uno']);
    expect((await t.list.execute({ busId: 'bus-1', take: 50, skip: 0 })).map((r) => r.note)).toEqual(['tres', 'uno']);
    expect((await t.list.execute({ inspector: 'laura', take: 50, skip: 0 })).map((r) => r.note)).toEqual(['dos']);
    expect(await t.list.execute({ take: 1, skip: 1 })).toHaveLength(1);
  });
});
