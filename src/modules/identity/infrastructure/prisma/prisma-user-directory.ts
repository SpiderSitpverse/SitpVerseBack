import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../../shared/infrastructure/prisma.service';
import { AuthenticatedUser } from '../../domain/models/authenticated-user';
import { AuditEntry } from '../../domain/ports/audit-log.port';
import {
  NewUser,
  UserAdminRepositoryPort,
  UserChange,
  UserView,
} from '../../domain/ports/user-admin-repository.port';
import { GoogleProfile, UserDirectoryPort } from '../../domain/ports/user-directory.port';
import { auditData } from './prisma-audit-log';

const PUBLIC_FIELDS = { id: true, employeeId: true, name: true, role: true, email: true, photoUrl: true } as const;
const VIEW_FIELDS = { ...PUBLIC_FIELDS, active: true, createdAt: true, lastLoginAt: true } as const;

/**
 * Adapter Prisma de identidad. Implementa DOS puertos con la misma tabla:
 *  - UserDirectoryPort (autenticación): solo ve cuentas ACTIVAS.
 *  - UserAdminRepositoryPort (administración): ve todas, también las desactivadas.
 */
@Injectable()
export class PrismaUserDirectory implements UserDirectoryPort, UserAdminRepositoryPort {
  constructor(private readonly prisma: PrismaService) {}

  // ───────────── autenticación ─────────────

  findById(id: string): Promise<AuthenticatedUser | null> {
    return this.prisma.user.findFirst({ where: { id, active: true }, select: PUBLIC_FIELDS });
  }

  findByGoogleSubject(subject: string): Promise<AuthenticatedUser | null> {
    return this.prisma.user.findFirst({ where: { googleSub: subject, active: true }, select: PUBLIC_FIELDS });
  }

  findUnlinkedByEmail(email: string): Promise<AuthenticatedUser | null> {
    return this.prisma.user.findFirst({ where: { email, googleSub: null, active: true }, select: PUBLIC_FIELDS });
  }

  async isDisabledAccount(subject: string, email: string): Promise<boolean> {
    return (
      (await this.prisma.user.count({ where: { active: false, OR: [{ googleSub: subject }, { email }] } })) > 0
    );
  }

  async recordGoogleLogin(id: string, profile: GoogleProfile, audit: AuditEntry): Promise<AuthenticatedUser | null> {
    const fullName = [profile.firstName, profile.lastName].filter(Boolean).join(' ').trim();
    return this.prisma.$transaction(async (tx) => {
      // Condicional: solo si sigue activa y NO está vinculada a otra cuenta de Google (dos primeros ingresos
      // simultáneos: gana uno; el otro ve count = 0).
      const updated = await tx.user.updateMany({
        where: { id, active: true, OR: [{ googleSub: null }, { googleSub: profile.subject }] },
        data: {
          googleSub: profile.subject,
          firstName: profile.firstName,
          lastName: profile.lastName,
          photoUrl: profile.photoUrl,
          lastLoginAt: new Date(),
          ...(fullName ? { name: fullName } : {}),
        },
      });
      if (updated.count === 0) return null;
      await tx.auditLog.create({ data: auditData(audit) });
      return tx.user.findUniqueOrThrow({ where: { id }, select: PUBLIC_FIELDS });
    });
  }

  // ───────────── administración ─────────────

  list(): Promise<UserView[]> {
    return this.prisma.user.findMany({ select: VIEW_FIELDS, orderBy: [{ role: 'asc' }, { employeeId: 'asc' }] });
  }

  findUserView(id: string): Promise<UserView | null> {
    return this.prisma.user.findUnique({ where: { id }, select: VIEW_FIELDS });
  }

  create(data: NewUser, audit: (created: UserView) => AuditEntry): Promise<UserView> {
    return this.prisma.$transaction(async (tx) => {
      const created = await tx.user.create({ data, select: VIEW_FIELDS });
      await tx.auditLog.create({ data: auditData(audit(created)) });
      return created;
    });
  }

  update(id: string, data: UserChange, audit: (updated: UserView) => AuditEntry): Promise<UserView> {
    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.user.update({ where: { id }, data, select: VIEW_FIELDS });
      await tx.auditLog.create({ data: auditData(audit(updated)) });
      return updated;
    });
  }

  countActiveAdmins(): Promise<number> {
    return this.prisma.user.count({ where: { role: 'ADMIN', active: true } });
  }
}
