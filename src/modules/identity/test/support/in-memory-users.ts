import { randomUUID } from 'crypto';
import { UserRole } from '../../../../shared/domain/roles';
import { AuthenticatedUser } from '../../domain/models/authenticated-user';
import { PasswordHasherPort } from '../../domain/ports/password-hasher.port';
import {
  NewUser,
  UserAdminRepositoryPort,
  UserView,
} from '../../domain/ports/user-admin-repository.port';
import { UserDirectoryPort, UserWithCredentials } from '../../domain/ports/user-directory.port';

interface Row extends UserView {
  passwordHash: string;
}

/**
 * Hash falso y rápido para pruebas ("hash:<clave>"): los tests de reglas de negocio no necesitan
 * bcrypt de verdad (los de seguridad con bcrypt están en login.use-case.spec.ts).
 */
export const fakeHasher: PasswordHasherPort = {
  hash: async (plain) => `hash:${plain}`,
  matches: async (plain, hash) => hash === `hash:${plain}`,
};

/** Repositorio en memoria que implementa los DOS puertos de identidad, igual que el adaptador Prisma. */
export class InMemoryUsers implements UserDirectoryPort, UserAdminRepositoryPort {
  rows = new Map<string, Row>();

  add(employeeId: string, name: string, role: UserRole, password = 'Clave2026', active = true): UserView {
    const row: Row = {
      id: randomUUID(),
      employeeId,
      name,
      role,
      active,
      createdAt: new Date(),
      passwordHash: `hash:${password}`,
    };
    this.rows.set(row.id, row);
    return this.view(row);
  }

  private view({ passwordHash: _hash, ...view }: Row): UserView {
    return { ...view };
  }

  private publicUser(row: Row): AuthenticatedUser {
    return { id: row.id, employeeId: row.employeeId, name: row.name, role: row.role };
  }

  // ── autenticación (solo cuentas activas) ──
  async findById(id: string) {
    const row = this.rows.get(id);
    return row?.active ? this.publicUser(row) : null;
  }
  async findCredentialsByEmployeeId(employeeId: string): Promise<UserWithCredentials | null> {
    const row = [...this.rows.values()].find((r) => r.employeeId === employeeId && r.active);
    return row ? { user: this.publicUser(row), passwordHash: row.passwordHash } : null;
  }
  async findPasswordHash(id: string) {
    const row = this.rows.get(id);
    return row?.active ? row.passwordHash : null;
  }

  // ── administración (todas las cuentas) ──
  async list() {
    return [...this.rows.values()].map((r) => this.view(r));
  }
  async findUserView(id: string) {
    const row = this.rows.get(id);
    return row ? this.view(row) : null;
  }
  async create(data: NewUser) {
    if ([...this.rows.values()].some((r) => r.employeeId === data.employeeId)) {
      throw Object.assign(new Error('Unique constraint'), { code: 'P2002' }); // igual que Prisma
    }
    const row: Row = { id: randomUUID(), active: true, createdAt: new Date(), ...data };
    this.rows.set(row.id, row);
    return this.view(row);
  }
  async update(id: string, data: { name?: string; role?: UserRole; active?: boolean }) {
    const row = this.rows.get(id)!;
    Object.assign(row, Object.fromEntries(Object.entries(data).filter(([, v]) => v !== undefined)));
    return this.view(row);
  }
  async setPasswordHash(id: string, passwordHash: string) {
    this.rows.get(id)!.passwordHash = passwordHash;
  }
  async countActiveAdmins() {
    return [...this.rows.values()].filter((r) => r.role === 'ADMIN' && r.active).length;
  }
}
