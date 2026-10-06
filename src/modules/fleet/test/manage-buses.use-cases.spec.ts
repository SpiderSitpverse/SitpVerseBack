import { randomUUID } from 'crypto';
import { ConflictError, InvalidInputError, NotFoundError } from '../../../shared/domain/errors';
import { Bus, BusDetails } from '../domain/entities/bus.entity';
import { BusRepositoryPort } from '../domain/ports/bus-repository.port';
import { DriverDirectoryPort } from '../domain/ports/driver-directory.port';
import { BusStatus } from '../domain/value-objects/bus-status.enum';
import {
  AssignDriverUseCase,
  CreateBusUseCase,
  GetFleetSummaryUseCase,
  UpdateBusDetailsUseCase,
} from '../application/use-cases/manage-buses.use-cases';

/** Repositorio en memoria que respeta los UNIQUE de placa y de conductor, como la base de datos. */
class InMemoryBuses implements BusRepositoryPort {
  rows = new Map<string, Bus>();

  private make(id: string, data: object, status = BusStatus.IDLE) {
    const bus = Bus.fromPersistence({ id, status, updatedAt: new Date(), plate: '', route: '', ...data });
    this.rows.set(id, bus);
    return bus;
  }
  seed(plate: string, status = BusStatus.IDLE, driverId: string | null = null) {
    return this.make(randomUUID(), { plate, route: 'Troncal Caracas', driverId }, status);
  }
  async findAll() { return [...this.rows.values()]; }
  async findById(id: string) { return this.rows.get(id) ?? null; }
  async findByDriverId(driverId: string) { return [...this.rows.values()].find((b) => b.driverId === driverId) ?? null; }
  async save() { /* no se usa aquí */ }
  async appendPositionHistory() { /* no se usa aquí */ }
  async create(data: BusDetails & { plate: string; route: string }) {
    if ([...this.rows.values()].some((b) => b.plate === data.plate)) {
      throw new ConflictError('Ya existe un bus con esa placa', { reason: 'PLATE_TAKEN' });
    }
    return this.make(randomUUID(), data);
  }
  async updateDetails(id: string, data: BusDetails) {
    const current = this.rows.get(id)!.toPersistence();
    if (data.plate && [...this.rows.values()].some((b) => b.plate === data.plate && b.id !== id)) {
      throw new ConflictError('Ya existe un bus con esa placa', { reason: 'PLATE_TAKEN' });
    }
    return this.make(id, { ...current, ...Object.fromEntries(Object.entries(data).filter(([, v]) => v !== undefined)) }, current.status);
  }
  async assignDriver(busId: string, driverId: string | null) {
    if (driverId && [...this.rows.values()].some((b) => b.driverId === driverId && b.id !== busId)) {
      throw new ConflictError('Ese conductor ya tiene otro bus asignado', { reason: 'DRIVER_ALREADY_ASSIGNED' });
    }
    const current = this.rows.get(busId)!.toPersistence();
    return this.make(busId, { ...current, driverId }, current.status);
  }
  async countByStatus() {
    const counts = { IDLE: 0, IN_SERVICE: 0, FINISHED: 0 } as Record<BusStatus, number>;
    for (const b of this.rows.values()) counts[b.status]++;
    return counts;
  }
  async findManyByIds(ids: string[]) { return ids.flatMap((id) => (this.rows.has(id) ? [this.rows.get(id)!] : [])); }
}

function build() {
  const buses = new InMemoryBuses();
  const drivers = new Map([['driver-1', 'DRIVER'], ['driver-2', 'DRIVER'], ['mech-1', 'MECHANICAL']]);
  const directory: DriverDirectoryPort = {
    findActiveDriver: async (id) => (drivers.get(id) === 'DRIVER' ? { id, name: id } : null),
  };
  return {
    buses,
    create: new CreateBusUseCase(buses),
    update: new UpdateBusDetailsUseCase(buses),
    assign: new AssignDriverUseCase(buses, directory),
    summary: new GetFleetSummaryUseCase(buses),
  };
}

describe('Registro de flota', () => {
  it('da de alta un bus con su ficha completa', async () => {
    const t = build();
    const bus = await t.create.execute({
      plate: 'TLY-842', route: 'F76', model: 'Marcopolo Viale BRS', year: 2020,
      operator: 'Consorcio Express S.A.S.', capacity: 160, locationLabel: 'Patio Fontibón',
    });
    expect(bus).toMatchObject({ plate: 'TLY-842', route: 'F76', model: 'Marcopolo Viale BRS', year: 2020, capacity: 160, status: 'IDLE' });
  });

  it('normaliza la placa: "tly-842 " y "TLY-842" son el mismo bus', async () => {
    const t = build();
    await t.create.execute({ plate: ' tly-842 ', route: 'F76' });
    await expect(t.create.execute({ plate: 'TLY-842', route: 'B23' })).rejects.toMatchObject({ details: { reason: 'PLATE_TAKEN' } });
  });

  it.each(['ab', 'PLACA CON ESPACIOS', 'x'.repeat(13), 'TL/Y-8'])('rechaza la placa %p (400)', async (plate) => {
    await expect(build().create.execute({ plate, route: 'F76' })).rejects.toBeInstanceOf(InvalidInputError);
  });

  it('edita la ficha sin tocar el estado ni la posición', async () => {
    const t = build();
    const bus = t.buses.seed('TMX-001', BusStatus.IN_SERVICE);
    const updated = await t.update.execute(bus.id, { model: 'Volvo', capacity: 270 });
    expect(updated).toMatchObject({ model: 'Volvo', capacity: 270, status: 'IN_SERVICE', plate: 'TMX-001' });
  });

  describe('foto del bus', () => {
    const PHOTO = '/uploads/3f1c2b4e-5a6d-4e7f-8a9b-0c1d2e3f4a5b.jpg';

    it('el admin sube una foto, la cambia y la quita (null)', async () => {
      const t = build();
      const bus = t.buses.seed('TMX-001');

      expect(await t.update.execute(bus.id, { photoUrl: PHOTO })).toMatchObject({ photoUrl: PHOTO });
      const other = '/uploads/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.png';
      expect(await t.update.execute(bus.id, { photoUrl: other })).toMatchObject({ photoUrl: other });
      expect(await t.update.execute(bus.id, { photoUrl: null })).toMatchObject({ photoUrl: null });
    });

    it('editar otros datos no borra la foto', async () => {
      const t = build();
      const bus = t.buses.seed('TMX-001');
      await t.update.execute(bus.id, { photoUrl: PHOTO });
      expect(await t.update.execute(bus.id, { model: 'Volvo' })).toMatchObject({ model: 'Volvo', photoUrl: PHOTO });
    });

    it.each([
      'https://sitio-externo.com/foto.jpg',
      '/uploads/../../etc/passwd',
      '/uploads/no-es-uuid.jpg',
      '/uploads/3f1c2b4e-5a6d-4e7f-8a9b-0c1d2e3f4a5b.svg',
      'javascript:alert(1)',
    ])('rechaza la foto %p (solo se aceptan imágenes subidas a este back)', async (photoUrl) => {
      const t = build();
      const bus = t.buses.seed('TMX-001');
      await expect(t.update.execute(bus.id, { photoUrl })).rejects.toBeInstanceOf(InvalidInputError);
    });
  });

  it('no se puede cambiar la placa a una que ya tiene otro bus (409)', async () => {
    const t = build();
    t.buses.seed('TMX-001');
    const other = t.buses.seed('TMX-002');
    await expect(t.update.execute(other.id, { plate: 'tmx-001' })).rejects.toBeInstanceOf(ConflictError);
  });

  it('editar un bus que no existe → 404', async () => {
    await expect(build().update.execute(randomUUID(), { model: 'X' })).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe('Asignar conductor', () => {
  it('asigna un conductor activo a un bus', async () => {
    const t = build();
    const bus = t.buses.seed('TMX-001');
    expect(await t.assign.execute(bus.id, 'driver-1')).toMatchObject({ driverId: 'driver-1' });
  });

  it('quita el conductor con null', async () => {
    const t = build();
    const bus = t.buses.seed('TMX-001', BusStatus.IDLE, 'driver-1');
    expect((await t.assign.execute(bus.id, null)).driverId).toBeNull();
  });

  it('un usuario que no es conductor (o no existe) no se puede asignar (400)', async () => {
    const t = build();
    const bus = t.buses.seed('TMX-001');
    await expect(t.assign.execute(bus.id, 'mech-1')).rejects.toBeInstanceOf(InvalidInputError); // es mecánico
    await expect(t.assign.execute(bus.id, 'fantasma')).rejects.toBeInstanceOf(InvalidInputError);
  });

  it('un conductor no puede tener dos buses a la vez (409)', async () => {
    const t = build();
    t.buses.seed('TMX-001', BusStatus.IDLE, 'driver-1');
    const other = t.buses.seed('TMX-002');
    await expect(t.assign.execute(other.id, 'driver-1')).rejects.toMatchObject({ details: { reason: 'DRIVER_ALREADY_ASSIGNED' } });
  });

  it('un bus que no existe → 404', async () => {
    await expect(build().assign.execute(randomUUID(), 'driver-1')).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe('Resumen para el panel', () => {
  it('cuenta los buses por estado', async () => {
    const t = build();
    t.buses.seed('A-1', BusStatus.IN_SERVICE);
    t.buses.seed('A-2', BusStatus.IN_SERVICE);
    t.buses.seed('A-3', BusStatus.IDLE);
    t.buses.seed('A-4', BusStatus.FINISHED);
    expect(await t.summary.execute()).toEqual({ total: 4, inService: 2, idle: 1, finished: 1 });
  });
});
