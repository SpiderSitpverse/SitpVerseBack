import { randomUUID } from 'crypto';
import { UserRole } from '../../../../shared/domain/roles';
import { AuthenticatedUser } from '../../domain/models/authenticated-user';
import { AuditEntry, AuditLogPort, AuditQuery, AuditRecord } from '../../domain/ports/audit-log.port';
import {
  NewUser,
  UserAdminRepositoryPort,
  UserChange,
  UserView,
} from '../../domain/ports/user-admin-repository.port';
import { GoogleProfile, UserDirectoryPort } from '../../domain/ports/user-directory.port';

interface Row extends UserView {
  googleSub: string | null;
}

/** Auditoría en memoria: solo inserta y consulta, igual que el adaptador real. */
export class InMemoryAudit implements AuditLogPort {
  records: AuditRecord[] = [];
  /** Para probar que un fallo al auditar no rompe el flujo. */
  failNextWrite = false;

  async record(entry: AuditEntry): Promise<void> {
    if (this.failNextWrite) {
      this.failNextWrite = false;
      throw new Error('base de auditoría caída');
    }
    this.push(entry);
  }
  push(entry: AuditEntry) {
    this.records.push({ ...entry, id: randomUUID(), at: new Date() });
  }
  async list(query: AuditQuery): Promise<AuditRecord[]> {
    return this.records
      .filter((r) => (query.action ? r.action === query.action : true))
      .filter((r) => (query.outcome ? r.outcome === query.outcome : true))
      .slice(-query.limit)
      .reverse();
  }
}

/** Repositorio en memoria que implementa los DOS puertos de identidad, igual que el adaptador Prisma. */
export class InMemoryUsers implements UserDirectoryPort, UserAdminRepositoryPort {
  rows = new Map<string, Row>();

  constructor(readonly audit: InMemoryAudit = new InMemoryAudit()) {}

  add(employeeId: string, name: string, role: UserRole, email = `${employeeId}@test.local`, active = true): UserView {
    const row: Row = {
      id: randomUUID(),
      employeeId,
      name,
      role,
      email,
      photoUrl: null,
      active,
      createdAt: new Date(),
      lastLoginAt: null,
      googleSub: null,
    };
    this.rows.set(row.id, row);
    return this.view(row);
  }

  private view({ googleSub: _sub, ...view }: Row): UserView {
    return { ...view };
  }

  private publicUser(row: Row): AuthenticatedUser {
    return {
      id: row.id,
      employeeId: row.employeeId,
      name: row.name,
      role: row.role,
      email: row.email,
      photoUrl: row.photoUrl,
    };
  }

  // ── autenticación (solo cuentas activas) ──
  async findById(id: string) {
    const row = this.rows.get(id);
    return row?.active ? this.publicUser(row) : null;
  }
  async findByGoogleSubject(subject: string) {
    const row = [...this.rows.values()].find((r) => r.googleSub === subject && r.active);
    return row ? this.publicUser(row) : null;
  }
  async findUnlinkedByEmail(email: string) {
    const row = [...this.rows.values()].find((r) => r.email === email && r.googleSub === null && r.active);
    return row ? this.publicUser(row) : null;
  }
  async isDisabledAccount(subject: string, email: string) {
    return [...this.rows.values()].some((r) => !r.active && (r.googleSub === subject || r.email === email));
  }
  async recordGoogleLogin(id: string, profile: GoogleProfile, audit: AuditEntry) {
    const row = this.rows.get(id);
    if (!row || !row.active || (row.googleSub !== null && row.googleSub !== profile.subject)) return null;
    if ([...this.rows.values()].some((r) => r.id !== id && r.googleSub === profile.subject)) {
      throw Object.assign(new Error('Unique constraint'), { code: 'P2002' }); // igual que Prisma
    }
    row.googleSub = profile.subject;
    row.photoUrl = profile.photoUrl;
    row.lastLoginAt = new Date();
    const fullName = [profile.firstName, profile.lastName].filter(Boolean).join(' ');
    if (fullName) row.name = fullName;
    this.audit.push(audit);
    return this.publicUser(row);
  }

  // ── administración (todas las cuentas) ──
  async list() {
    return [...this.rows.values()].map((r) => this.view(r));
  }
  async findUserView(id: string) {
    const row = this.rows.get(id);
    return row ? this.view(row) : null;
  }
  async create(data: NewUser, audit: (created: UserView) => AuditEntry) {
    const taken = (field: 'employeeId' | 'email') =>
      [...this.rows.values()].some((r) => r[field] === data[field]);
    if (taken('employeeId') || taken('email')) {
      const target = taken('email') ? ['email'] : ['employeeId'];
      throw Object.assign(new Error('Unique constraint'), { code: 'P2002', meta: { target } }); // igual que Prisma
    }
    const row: Row = {
      id: randomUUID(),
      active: true,
      createdAt: new Date(),
      photoUrl: null,
      lastLoginAt: null,
      googleSub: null,
      ...data,
    };
    this.rows.set(row.id, row);
    this.audit.push(audit(this.view(row)));
    return this.view(row);
  }
  async update(id: string, data: UserChange, audit: (updated: UserView) => AuditEntry) {
    const row = this.rows.get(id)!;
    if (data.email && [...this.rows.values()].some((r) => r.id !== id && r.email === data.email)) {
      throw Object.assign(new Error('Unique constraint'), { code: 'P2002', meta: { target: ['email'] } });
    }
    Object.assign(row, Object.fromEntries(Object.entries(data).filter(([, v]) => v !== undefined)));
    this.audit.push(audit(this.view(row)));
    return this.view(row);
  }
  async countActiveAdmins() {
    return [...this.rows.values()].filter((r) => r.role === 'ADMIN' && r.active).length;
  }
}
