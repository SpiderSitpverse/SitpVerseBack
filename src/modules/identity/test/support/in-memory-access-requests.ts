import { randomUUID } from 'crypto';
import { UserRole } from '../../../../shared/domain/roles';
import {
  AccessApplicant,
  AccessRequestRepositoryPort,
  AccessRequestView,
  RecordedRequest,
} from '../../domain/ports/access-request-repository.port';
import { AuditEntry } from '../../domain/ports/audit-log.port';
import { UserView } from '../../domain/ports/user-admin-repository.port';
import { InMemoryUsers } from './in-memory-users';

interface Row extends AccessRequestView {
  googleSub: string;
}

/**
 * Solicitudes de acceso en memoria. Comparte los usuarios con `InMemoryUsers` para que aceptar una solicitud cree de
 * verdad la cuenta, igual que la transacción del adaptador Prisma.
 */
export class InMemoryAccessRequests implements AccessRequestRepositoryPort {
  rows = new Map<string, Row>();
  /** Para probar el reintento: devuelve estos números de empleado "ya ocupados" antes de aceptar uno libre. */
  collideEmployeeIds: string[] = [];

  constructor(private readonly users: InMemoryUsers) {}

  async record(
    applicant: AccessApplicant,
    maxOpen: number,
    audit: (request: AccessRequestView) => AuditEntry,
  ): Promise<RecordedRequest | null> {
    const found = [...this.rows.values()].find((r) => r.googleSub === applicant.subject || r.email === applicant.email);
    if (found) {
      found.lastAttemptAt = new Date();
      return { request: this.view(found), created: false };
    }
    if ([...this.rows.values()].filter((r) => r.status === 'PENDING').length >= maxOpen) return null;
    const row: Row = {
      id: randomUUID(),
      email: applicant.email,
      googleSub: applicant.subject,
      name: applicant.name,
      photoUrl: applicant.photoUrl,
      status: 'PENDING',
      requestedAt: new Date(),
      lastAttemptAt: new Date(),
    };
    this.rows.set(row.id, row);
    this.users.audit.push(audit(this.view(row)));
    return { request: this.view(row), created: true };
  }

  private view({ googleSub: _sub, ...view }: Row): AccessRequestView {
    return { ...view };
  }

  async list() {
    return [...this.rows.values()].map((r) => this.view(r));
  }

  async findById(id: string) {
    const row = this.rows.get(id);
    return row ? this.view(row) : null;
  }

  async approve(
    id: string,
    data: { role: UserRole; employeeId?: string; name?: string },
    audit: (user: UserView) => AuditEntry,
  ): Promise<UserView | null> {
    const row = this.rows.get(id);
    if (!row) return null;
    this.rows.delete(id); // la "puerta": el segundo en llegar ya no la encuentra
    const employeeId = data.employeeId ?? this.collideEmployeeIds.shift() ?? this.nextEmployeeId(data.role);
    try {
      const created = await this.users.create(
        { employeeId, name: data.name?.trim() || row.name, role: data.role, email: row.email },
        audit,
      );
      this.users.rows.get(created.id)!.googleSub = row.googleSub;
      return created;
    } catch (error) {
      this.rows.set(id, row); // la transacción se deshace
      throw error;
    }
  }

  private nextEmployeeId(role: UserRole): string {
    const base = { ADMIN: 1000, DRIVER: 2000, MECHANICAL: 3000 }[role];
    const taken = [...this.users.rows.values()].map((u) => Number(u.employeeId)).filter((n) => n > base && n < base + 1000);
    return String(Math.max(base, ...taken) + 1);
  }

  async reject(id: string, _actorId: string, audit: AuditEntry): Promise<boolean> {
    const row = this.rows.get(id);
    if (!row) return false;
    row.status = 'REJECTED';
    this.users.audit.push(audit);
    return true;
  }
}
