import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../../shared/infrastructure/prisma.service';
import { UserRole } from '../../../../shared/domain/roles';
import { AuthenticatedUser } from '../../domain/models/authenticated-user';
import {
  NewUser,
  UserAdminRepositoryPort,
  UserView,
} from '../../domain/ports/user-admin-repository.port';
import {
  UserDirectoryPort,
  UserWithCredentials,
} from '../../domain/ports/user-directory.port';

const PUBLIC_FIELDS = { id: true, employeeId: true, name: true, role: true } as const;
const VIEW_FIELDS = { ...PUBLIC_FIELDS, active: true, createdAt: true } as const;

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

  async findCredentialsByEmployeeId(employeeId: string): Promise<UserWithCredentials | null> {
    const row = await this.prisma.user.findFirst({
      where: { employeeId, active: true },
      select: { ...PUBLIC_FIELDS, passwordHash: true },
    });
    if (!row) return null;
    const { passwordHash, ...user } = row;
    return { user, passwordHash };
  }

  async findPasswordHash(id: string): Promise<string | null> {
    const row = await this.prisma.user.findFirst({
      where: { id, active: true },
      select: { passwordHash: true },
    });
    return row?.passwordHash ?? null;
  }

  // ───────────── administración ─────────────

  list(): Promise<UserView[]> {
    return this.prisma.user.findMany({ select: VIEW_FIELDS, orderBy: [{ role: 'asc' }, { employeeId: 'asc' }] });
  }

  async findUserView(id: string): Promise<UserView | null> {
    return this.prisma.user.findUnique({ where: { id }, select: VIEW_FIELDS });
  }

  create(data: NewUser): Promise<UserView> {
    return this.prisma.user.create({ data, select: VIEW_FIELDS });
  }

  update(id: string, data: { name?: string; role?: UserRole; active?: boolean }): Promise<UserView> {
    return this.prisma.user.update({ where: { id }, data, select: VIEW_FIELDS });
  }

  async setPasswordHash(id: string, passwordHash: string): Promise<void> {
    await this.prisma.user.update({ where: { id }, data: { passwordHash } });
  }

  countActiveAdmins(): Promise<number> {
    return this.prisma.user.count({ where: { role: 'ADMIN', active: true } });
  }
}
