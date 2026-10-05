import { Injectable } from '@nestjs/common';
import { Bus as PrismaBus, BusStatus as PrismaBusStatus, Prisma } from '@prisma/client';
import { ConflictError } from '../../../../shared/domain/errors';
import { PrismaService } from '../../../../shared/infrastructure/prisma.service';
import { Bus } from '../../domain/entities/bus.entity';
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
      },
    });
    if (count === 0) {
      throw new ConflictError(
        `El bus ${props.plate} cambió de estado mientras se procesaba la operación`,
        { plate: props.plate, reason: 'STALE_STATE' },
      );
    }
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
      updatedAt: row.updatedAt,
    });
  }
}