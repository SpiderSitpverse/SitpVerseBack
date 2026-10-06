import { Injectable } from '@nestjs/common';
import { BusInspection } from '@prisma/client';
import { PrismaService } from '../../../../shared/infrastructure/prisma.service';
import { InspectionFilter, InspectionModel, NewInspection } from '../../domain/models/inspection.models';
import { InspectionRepositoryPort } from '../../domain/ports/inspection-repository.port';

/** Adapter Prisma. Solo inserta y consulta: no hay `update` ni `delete`, las inspecciones son inmutables. */
@Injectable()
export class PrismaInspectionRepository implements InspectionRepositoryPort {
  constructor(private readonly prisma: PrismaService) {}

  async create(data: NewInspection): Promise<InspectionModel> {
    return this.toModel(await this.prisma.busInspection.create({ data }));
  }

  async findLatestByBus(busId: string): Promise<InspectionModel | null> {
    const row = await this.prisma.busInspection.findFirst({
      where: { busId },
      orderBy: { createdAt: 'desc' },
    });
    return row ? this.toModel(row) : null;
  }

  async list(filter: InspectionFilter): Promise<InspectionModel[]> {
    const rows = await this.prisma.busInspection.findMany({
      where: {
        busId: filter.busId,
        inspectorName: filter.inspector ? { contains: filter.inspector, mode: 'insensitive' } : undefined,
        createdAt: { gte: filter.from, lte: filter.to },
      },
      orderBy: { createdAt: 'desc' },
      take: filter.take,
      skip: filter.skip,
    });
    return rows.map((row) => this.toModel(row));
  }

  private toModel(row: BusInspection): InspectionModel {
    return { ...row, photos: row.photos as string[] };
  }
}
