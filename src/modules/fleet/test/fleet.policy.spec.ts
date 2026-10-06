import { ForbiddenError } from '../../../shared/domain/errors';
import { Bus } from '../domain/entities/bus.entity';
import {
  assertCanOperateBus,
  assertCanViewBus,
  canOperateBus,
  canViewBus,
} from '../domain/fleet.policy';
import { BusStatus } from '../domain/value-objects/bus-status.enum';

const bus = (driverId: string | null) =>
  Bus.fromPersistence({
    id: 'b1',
    plate: 'TMX-001',
    route: 'Caracas',
    driverId,
    status: BusStatus.IDLE,
    updatedAt: new Date(),
  });

const admin = { id: 'a', role: 'ADMIN' as const };
const mechanic = { id: 'm', role: 'MECHANICAL' as const };
const owner = { id: 'd1', role: 'DRIVER' as const };
const otherDriver = { id: 'd2', role: 'DRIVER' as const };

describe('Política de acceso a buses', () => {
  it('ADMIN ve y opera cualquier bus', () => {
    expect(canViewBus(admin, bus('d1'))).toBe(true);
    expect(canOperateBus(admin, bus('d1'))).toBe(true);
  });

  it('MECHANICAL puede ver cualquier bus pero NO operarlo', () => {
    expect(canViewBus(mechanic, bus('d1'))).toBe(true);
    expect(canOperateBus(mechanic, bus('d1'))).toBe(false);
    expect(() => assertCanOperateBus(mechanic, bus('d1'))).toThrow(ForbiddenError);
  });

  it('DRIVER ve y opera SOLO su bus', () => {
    expect(canViewBus(owner, bus('d1'))).toBe(true);
    expect(canOperateBus(owner, bus('d1'))).toBe(true);
    expect(canViewBus(otherDriver, bus('d1'))).toBe(false);
    expect(canOperateBus(otherDriver, bus('d1'))).toBe(false);
    expect(() => assertCanViewBus(otherDriver, bus('d1'))).toThrow(ForbiddenError);
  });

  it('un bus sin conductor asignado no es de ningún DRIVER', () => {
    expect(canOperateBus(owner, bus(null))).toBe(false);
  });
});
