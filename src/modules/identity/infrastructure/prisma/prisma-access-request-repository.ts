import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../../shared/infrastructure/prisma.service';
import { UserRole } from '../../../../shared/domain/roles';
import {
  AccessApplicant,
  AccessRequestRepositoryPort,
  AccessRequestView,
  RecordedRequest,
} from '../../domain/ports/access-request-repository.port';
import { AuditEntry } from '../../domain/ports/audit-log.port';
import { UserView } from '../../domain/ports/user-admin-repository.port';
import { auditData } from './prisma-audit-log';

const VIEW = { id: true, email: true, name: true, photoUrl: true, status: true, requestedAt: true, lastAttemptAt: true } as const;
const USER_VIEW = {
  id: true, employeeId: true, name: true, role: true, email: true, photoUrl: true, active: true, createdAt: true, lastLoginAt: true,
} as const;

/** Primer dígito del número de empleado según el rol (como en los datos de demostración: 1xxx, 2xxx, 3xxx). */
const EMPLOYEE_PREFIX: Record<UserRole, number> = { ADMIN: 1, DRIVER: 2, MECHANICAL: 3 };

const isUniqueViolation = (error: unknown) => (error as { code?: string }).code === 'P2002';

@Injectable()
export class PrismaAccessRequestRepository implements AccessRequestRepositoryPort {
  constructor(private readonly prisma: PrismaService) {}

  async record(
    applicant: AccessApplicant,
    maxOpen: number,
    audit: (request: AccessRequestView) => AuditEntry,
  ): Promise<RecordedRequest | null> {
    const existing = () =>
      this.prisma.accessRequest.findFirst({
        where: { OR: [{ googleSub: applicant.subject }, { email: applicant.email }] },
        select: VIEW,
      });

    const found = await existing();
    if (found) {
      const refreshed = await this.prisma.accessRequest.update({
        where: { id: found.id },
        data: { lastAttemptAt: new Date(), name: applicant.name, photoUrl: applicant.photoUrl },
        select: VIEW,
      });
      return { request: refreshed, created: false };
    }

    if ((await this.prisma.accessRequest.count({ where: { status: 'PENDING' } })) >= maxOpen) return null;
    try {
      const request = await this.prisma.$transaction(async (tx) => {
        const created = await tx.accessRequest.create({
          data: {
            email: applicant.email,
            googleSub: applicant.subject,
            name: applicant.name,
            firstName: applicant.firstName,
            lastName: applicant.lastName,
            photoUrl: applicant.photoUrl,
          },
          select: VIEW,
        });
        await tx.auditLog.create({ data: auditData(audit(created)) });
        return created;
      });
      return { request, created: true };
    } catch (error) {
      // Dos primeros intentos simultáneos: ganó el otro. La base de datos garantiza una sola fila por persona.
      if (!isUniqueViolation(error)) throw error;
      const winner = await existing();
      return winner ? { request: winner, created: false } : null;
    }
  }

  list(): Promise<AccessRequestView[]> {
    return this.prisma.accessRequest.findMany({ select: VIEW, orderBy: [{ status: 'asc' }, { requestedAt: 'asc' }] });
  }

  findById(id: string): Promise<AccessRequestView | null> {
    return this.prisma.accessRequest.findUnique({ where: { id }, select: VIEW });
  }

  async approve(
    id: string,
    data: { role: UserRole; employeeId?: string; name?: string },
    audit: (user: UserView) => AuditEntry,
  ): Promise<UserView | null> {
    return this.prisma.$transaction(async (tx) => {
      // Borrar es la "puerta": si dos admins aceptan a la vez, solo uno borra la fila (count = 1) y crea el usuario.
      const request = await tx.accessRequest.findUnique({ where: { id } });
      if (!request) return null;
      const deleted = await tx.accessRequest.deleteMany({ where: { id } });
      if (deleted.count === 0) return null;

      const user = await tx.user.create({
        data: {
          employeeId: data.employeeId ?? (await this.nextEmployeeId(tx, data.role)),
          name: data.name?.trim() || request.name,
          role: data.role,
          email: request.email,
          googleSub: request.googleSub,
          firstName: request.firstName,
          lastName: request.lastName,
          photoUrl: request.photoUrl,
        },
        select: USER_VIEW,
      });
      await tx.auditLog.create({ data: auditData(audit(user)) });
      return user;
    });
  }

  async reject(id: string, actorId: string, audit: AuditEntry): Promise<boolean> {
    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.accessRequest.updateMany({
        where: { id },
        data: { status: 'REJECTED', decidedAt: new Date(), decidedById: actorId },
      });
      if (updated.count === 0) return false;
      await tx.auditLog.create({ data: auditData(audit) });
      return true;
    });
  }

  /** Siguiente número libre del rol (p. ej. 2006). Si dos altas simultáneas eligen el mismo, el UNIQUE obliga a reintentar. */
  private async nextEmployeeId(tx: Prisma.TransactionClient, role: UserRole): Promise<string> {
    const base = EMPLOYEE_PREFIX[role] * 1000;
    const rows = await tx.user.findMany({
      where: { employeeId: { gte: String(base), lt: String(base + 1000) } },
      select: { employeeId: true },
    });
    const taken = rows.map((r) => Number(r.employeeId)).filter((n) => Number.isInteger(n));
    return String(Math.max(base, ...taken) + 1);
  }
}
