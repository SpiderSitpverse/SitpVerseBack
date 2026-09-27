import { Injectable } from '@nestjs/common';
import { Bus as PrismaBus, BusStatus as PrismaBusStatus } from '@prisma/client';
import { PrismaService } from '../../../../shared/infrastructure/prisma.service';
import { Bus } from '../../domain/entities/bus.entity';
import { BusRepositoryPort } from '../../domain/ports/bus-repository.port';
import { BusStatus } from '../../domain/value-objects/bus-status.enum';

/**
 * Adapter (driven adapter): implementa el puerto del dominio usando Prisma.
 * Si mañana cambian de ORM, solo se reescribe este archivo.
 */
@Injectable()
export class PrismaBusRepository implements BusRepositoryPort {
  constructor(private readonly prisma: PrismaService) {}

  async findAll(filter?: { status?: BusStatus }): Promise<Bus[]> {
    const rows = await this.prisma.bus.findMany({
      where: filter?.status
        ? { status: filter.status as PrismaBusStatus }
        : undefined,
      orderBy: { updatedAt: 'desc' },
    });
    return rows.map(this.toDomain);
  }

  async findById(id: string): Promise<Bus | null> {
    const row = await this.prisma.bus.findUnique({ where: { id } });
    return row ? this.toDomain(row) : null;
  }

  async findByDriver(driver: string): Promise<Bus | null> {
    const row = await this.prisma.bus.findFirst({ where: { driver } });
    return row ? this.toDomain(row) : null;
  }

  async save(bus: Bus): Promise<void> {
    const props = bus.toPersistence();
    await this.prisma.bus.update({
      where: { id: props.id },
      data: {
        status: props.status as PrismaBusStatus,
        latitude: props.latitude,
        longitude: props.longitude,
      },
    });
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

  private toDomain(row: PrismaBus): Bus {
    return Bus.fromPersistence({
      id: row.id,
      plate: row.plate,
      route: row.route,
      driver: row.driver,
      status: row.status as unknown as BusStatus,
      latitude: row.latitude,
      longitude: row.longitude,
      updatedAt: row.updatedAt,
    });
  }
}