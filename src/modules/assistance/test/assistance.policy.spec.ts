import { ForbiddenError } from '../../../shared/domain/errors';
import { UserRole } from '../../../shared/domain/roles';
import {
  Actor,
  assertCanComplete,
  assertNotOwnIncident,
  assertRoleCanAccept,
  isOverdue,
} from '../domain/assistance.policy';
import {
  AssistanceCallModel,
  AssistanceKind,
  ClaimModel,
  DriverIncidentModel,
} from '../domain/models/assistance.models';

const user = (id: string, role: UserRole): Actor => ({ id, role });

const call = (kind: AssistanceKind): AssistanceCallModel => ({
  id: 'c1',
  kind,
  incidentId: null,
  busId: 'b1',
  slots: 1,
  claimedCount: 0,
  rewardPoints: 10,
  status: 'OPEN',
  createdById: 'a',
  description: null,
  createdAt: new Date(),
  completedAt: null,
});

const claim = (userId: string, overrides: Partial<ClaimModel> = {}): ClaimModel => ({
  id: 'k',
  callId: 'c1',
  userId,
  status: 'ACTIVE',
  busId: null,
  arriveBy: new Date(Date.now() + 20 * 60_000),
  cancelledAt: null,
  cancelledById: null,
  createdAt: new Date(),
  ...overrides,
});

describe('Política de asistencia (reglas de dominio puras)', () => {
  it('apoyo → solo DRIVER; reparación → solo MECHANICAL', () => {
    expect(() => assertRoleCanAccept(call('DRIVER_SUPPORT'), user('d', 'DRIVER'))).not.toThrow();
    expect(() => assertRoleCanAccept(call('REPAIR'), user('m', 'MECHANICAL'))).not.toThrow();
    expect(() => assertRoleCanAccept(call('DRIVER_SUPPORT'), user('m', 'MECHANICAL'))).toThrow(ForbiddenError);
    expect(() => assertRoleCanAccept(call('REPAIR'), user('d', 'DRIVER'))).toThrow(ForbiddenError);
    expect(() => assertRoleCanAccept(call('REPAIR'), user('a', 'ADMIN'))).toThrow(ForbiddenError);
  });

  it('quien reportó el incidente no puede aceptarlo', () => {
    const incident = { reportedById: 'd1' } as DriverIncidentModel;
    expect(() => assertNotOwnIncident(incident, user('d1', 'DRIVER'))).toThrow(ForbiddenError);
    expect(() => assertNotOwnIncident(incident, user('d2', 'DRIVER'))).not.toThrow();
    expect(() => assertNotOwnIncident(null, user('d1', 'DRIVER'))).not.toThrow();
  });

  it('completar: ADMIN siempre; mecánico solo su reparación; conductor nunca', () => {
    const claims = [claim('m1')];
    expect(() => assertCanComplete(call('REPAIR'), user('a', 'ADMIN'), claims)).not.toThrow();
    expect(() => assertCanComplete(call('REPAIR'), user('m1', 'MECHANICAL'), claims)).not.toThrow();
    expect(() => assertCanComplete(call('REPAIR'), user('m2', 'MECHANICAL'), claims)).toThrow(ForbiddenError);
    expect(() => assertCanComplete(call('DRIVER_SUPPORT'), user('m1', 'MECHANICAL'), claims)).toThrow(ForbiddenError);
    expect(() => assertCanComplete(call('DRIVER_SUPPORT'), user('d1', 'DRIVER'), [claim('d1')])).toThrow(ForbiddenError);
  });

  it('vencida = activa y pasado su plazo; una cancelada nunca está vencida', () => {
    const past = new Date(Date.now() - 1000);
    expect(isOverdue(claim('d', { arriveBy: past }))).toBe(true);
    expect(isOverdue(claim('d'))).toBe(false);
    expect(isOverdue(claim('d', { arriveBy: past, status: 'CANCELLED' }))).toBe(false);
  });
});
