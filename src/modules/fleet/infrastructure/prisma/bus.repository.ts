import { Injectable } from '@nestjs/common';
import { Bus as PrismaBus, BusStatus as PrismaBusStatus, Prisma } from '@prisma/client';
import { ConflictError, NotFoundError } from '../../../../shared/domain/errors';
import { PrismaService } from '../../../../shared/infrastructure/prisma.service';
import { Bus, BusDetails } from '../../domain/entities/bus.entity';
import { BusRepositoryPort } from '../../domain/ports/bus-repository.port';
import { BusStatus } from '../../domain/value-objects/bus-status.enum';

const WITH_DRIVER = { assignedDriver: { select: { name: true } } } satisfies Prisma.BusInclude;
type BusRow = PrismaBus & { assignedDriver: { name: string } | null };

/**
 * Adapter (driven adapter): implementa el puerto del dominio usando Prisma.
 * Si mañana cambian de ORM, solo se reescribe este archivo.
 */
@Injectable()
export class PrismaBusRepository implements BusRepositoryPort {
  constructor(private readonly prisma: PrismaService) {}

  async findAll(filter?: { status?: BusStatus; driverId?: string }): Promise<Bus[]> {
    const rows = await this.prisma.bus.findMany({
      where: {
        status: filter?.status as PrismaBusStatus | undefined,
        driverId: filter?.driverId,
      },
      include: WITH_DRIVER,
      orderBy: { updatedAt: 'desc' },
    });
    return rows.map(this.toDomain);
  }

  async findById(id: string): Promise<Bus | null> {
    const row = await this.prisma.bus.findUnique({ where: { id }, include: WITH_DRIVER });
    return row ? this.toDomain(row) : null;
  }

  async findByDriverId(driverId: string): Promise<Bus | null> {
    const row = await this.prisma.bus.findUnique({ where: { driverId }, include: WITH_DRIVER });
    return row ? this.toDomain(row) : null;
  }

  async save(bus: Bus): Promise<void> {
    const props = bus.toPersistence();
    const { count } = await this.prisma.bus.updateMany({
      // Compare-and-set: solo escribe si nadie cambió el estado desde que se leyó.
      where: { id: props.id, status: bus.expectedStatus as PrismaBusStatus },
      data: {
        status: props.status as PrismaBusStatus,
        latitude: props.latitude,
        longitude: props.longitude,
        tripStartedAt: props.tripStartedAt,
      },
    });
    if (count === 0) {
      throw new ConflictError(
        `El bus ${props.plate} cambió de estado mientras se procesaba la operación`,
        { plate: props.plate, reason: 'STALE_STATE' },
      );
    }
  }

  async create(data: BusDetails & { plate: string; route: string }): Promise<Bus> {
    try {
      const row = await this.prisma.bus.create({ data, include: WITH_DRIVER });
      return this.toDomain(row);
    } catch (error) {
      throw this.translate(error);
    }
  }

  async updateDetails(id: string, data: BusDetails): Promise<Bus> {
    try {
      const row = await this.prisma.bus.update({ where: { id }, data, include: WITH_DRIVER });
      return this.toDomain(row);
    } catch (error) {
      throw this.translate(error);
    }
  }

  async assignDriver(busId: string, driverId: string | null): Promise<Bus> {
    try {
      const row = await this.prisma.bus.update({ where: { id: busId }, data: { driverId }, include: WITH_DRIVER });
      return this.toDomain(row);
    } catch (error) {
      throw this.translate(error);
    }
  }

  async countByStatus(): Promise<Record<BusStatus, number>> {
    const groups = await this.prisma.bus.groupBy({ by: ['status'], _count: { _all: true } });
    const counts = { IDLE: 0, IN_SERVICE: 0, FINISHED: 0 } as Record<BusStatus, number>;
    for (const g of groups) counts[g.status as unknown as BusStatus] = g._count._all;
    return counts;
  }

  async findManyByIds(ids: string[]): Promise<Bus[]> {
    if (ids.length === 0) return [];
    const rows = await this.prisma.bus.findMany({ where: { id: { in: ids } }, include: WITH_DRIVER });
    return rows.map(this.toDomain);
  }

  /** Traduce los errores de la base de datos a errores de dominio (el resto se deja pasar). */
  private translate(error: unknown): unknown {
    if (error instanceof Prisma.PrismaClientKnownRequestError) {
      if (error.code === 'P2002') {
        const target = String((error.meta as { target?: unknown })?.target ?? '');
        return target.includes('driverId')
          ? new ConflictError('Ese conductor ya tiene otro bus asignado', { reason: 'DRIVER_ALREADY_ASSIGNED' })
          : new ConflictError('Ya existe un bus con esa placa', { reason: 'PLATE_TAKEN' });
      }
      if (error.code === 'P2025') return new NotFoundError('Bus no encontrado');
      if (error.code === 'P2003') return new NotFoundError('El conductor indicado no existe');
    }
    return error;
  }

  async appendPositionHistory(
    busId: string,
    latitude: number,
    longitude: number,
  ): Promise<void> {
    await this.prisma.busPosition.create({
      data: { busId, latitude, longitude },
    });
  }

  private toDomain(row: BusRow): Bus {
    return Bus.fromPersistence({
      id: row.id,
      plate: row.plate,
      route: row.route,
      driverId: row.driverId,
      driver: row.assignedDriver?.name ?? null,
      status: row.status as unknown as BusStatus,
      latitude: row.latitude,
      longitude: row.longitude,
      model: row.model,
      year: row.year,
      operator: row.operator,
      capacity: row.capacity,
      locationLabel: row.locationLabel,
      tripStartedAt: row.tripStartedAt,
      photoUrl: row.photoUrl,
      updatedAt: row.updatedAt,
    });
  }
}