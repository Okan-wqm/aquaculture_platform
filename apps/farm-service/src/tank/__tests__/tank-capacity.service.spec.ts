/**
 * TankCapacityService Unit Tests
 *
 * Covers the three-axis capacity invariant (status, biomass, density)
 * and the three enforcement modes (soft, hard, admin-override) used by
 * every handler that places fish into a tank:
 *
 *   - create-batch.handler.ts  (soft mode — initial stocking)
 *   - allocate-to-tank.handler.ts  (admin-override)
 *   - transfer-batch.handler.ts  (hard mode, destination tank)
 *   - deploy-cleaner-fish.handler.ts  (hard mode)
 *
 * See docs/illustrator/farm-modulu-kor-noktalar-dogrulama.md — Girdi
 * 15-B15 (welfare compliance) + orphan 2 / 3 (competing APIs
 * consolidated into this service).
 */
import { TankCapacityExceededError } from '../../common/errors/farm-errors';
import { TankCapacityService } from '../services/tank-capacity.service';
import {
  EquipmentStatus,
} from '../../equipment/entities/equipment.entity';
import type { Equipment } from '../../equipment/entities/equipment.entity';

type EquipmentInput = Pick<
  Equipment,
  'id' | 'code' | 'name' | 'specifications' | 'status' | 'volume' | 'isTank'
>;

function mkEquipment(
  partial: Partial<EquipmentInput> & {
    specs?: Record<string, unknown>;
  } = {},
): EquipmentInput {
  return {
    id: partial.id ?? 'eq-1',
    code: partial.code ?? 'TANK-01',
    name: partial.name ?? 'Test Tank',
    specifications: (partial.specs ??
      partial.specifications ??
      {}) as unknown as Equipment['specifications'],
    status: partial.status ?? EquipmentStatus.ACTIVE,
    volume: partial.volume ?? 0,
    isTank: partial.isTank ?? true,
  };
}

describe('TankCapacityService', () => {
  const service = new TankCapacityService();

  describe('calculate()', () => {
    it('computes density and utilisation within limits', () => {
      const calc = service.calculate({
        equipment: mkEquipment({
          specs: { waterVolume: 100, maxDensity: 30 },
        }),
        existing: { salmonBiomassKg: 500, cleanerBiomassKg: 0 },
        incomingBiomassKg: 1000,
      });

      expect(calc.tankVolumeM3).toBe(100);
      expect(calc.maxDensityKgM3).toBe(30);
      expect(calc.projectedBiomassKg).toBe(1500);
      expect(calc.projectedDensityKgM3).toBe(15);
      expect(calc.utilizationPercent).toBe(50);
      expect(calc.isOverDensity).toBe(false);
      expect(calc.isOverBiomass).toBe(false);
      expect(calc.isStatusBlocked).toBe(false);
      expect(calc.isOverCapacity).toBe(false);
      expect(calc.primaryBlockReason).toBeNull();
    });

    describe('density axis', () => {
      it('flags over-density when projected density exceeds maxDensity', () => {
        const calc = service.calculate({
          equipment: mkEquipment({
            specs: { waterVolume: 50, maxDensity: 30 },
          }),
          existing: { salmonBiomassKg: 1200, cleanerBiomassKg: 100 },
          incomingBiomassKg: 300,
        });

        // 1200 + 100 + 300 = 1600; density = 1600/50 = 32
        expect(calc.projectedDensityKgM3).toBeCloseTo(32, 6);
        expect(calc.isOverDensity).toBe(true);
        expect(calc.isOverCapacity).toBe(true);
        expect(calc.primaryBlockReason).toBe('density');
        expect(calc.utilizationPercent).toBeGreaterThan(100);
      });

      it('applies the 30 kg/m³ industry default when maxDensity is unconfigured', () => {
        const calc = service.calculate({
          equipment: mkEquipment({ specs: { waterVolume: 10 } }),
          existing: { salmonBiomassKg: 0, cleanerBiomassKg: 0 },
          incomingBiomassKg: 400,
        });
        expect(calc.maxDensityKgM3).toBe(30);
        expect(calc.isOverDensity).toBe(true);
      });

      it('does not flag density when tank volume is 0 (unconfigured)', () => {
        const calc = service.calculate({
          equipment: mkEquipment({ specs: { maxDensity: 30 } }),
          existing: { salmonBiomassKg: 0, cleanerBiomassKg: 0 },
          incomingBiomassKg: 10000,
        });
        expect(calc.tankVolumeM3).toBe(0);
        expect(calc.isOverDensity).toBe(false);
      });

      it('prefers waterVolume, then effectiveVolume, then volume, then equipment.volume', () => {
        expect(
          service.calculate({
            equipment: mkEquipment({
              specs: { waterVolume: 100, effectiveVolume: 80, volume: 60 },
              volume: 40,
            }),
            existing: { salmonBiomassKg: 0, cleanerBiomassKg: 0 },
            incomingBiomassKg: 0,
          }).tankVolumeM3,
        ).toBe(100);

        expect(
          service.calculate({
            equipment: mkEquipment({
              specs: { effectiveVolume: 80, volume: 60 },
              volume: 40,
            }),
            existing: { salmonBiomassKg: 0, cleanerBiomassKg: 0 },
            incomingBiomassKg: 0,
          }).tankVolumeM3,
        ).toBe(80);

        expect(
          service.calculate({
            equipment: mkEquipment({
              specs: { volume: 60 },
              volume: 40,
            }),
            existing: { salmonBiomassKg: 0, cleanerBiomassKg: 0 },
            incomingBiomassKg: 0,
          }).tankVolumeM3,
        ).toBe(60);

        // Falls back to equipment.volume when specs are empty.
        expect(
          service.calculate({
            equipment: mkEquipment({ specs: {}, volume: 40 }),
            existing: { salmonBiomassKg: 0, cleanerBiomassKg: 0 },
            incomingBiomassKg: 0,
          }).tankVolumeM3,
        ).toBe(40);
      });
    });

    describe('biomass axis', () => {
      it('flags over-biomass when projected total exceeds maxBiomass', () => {
        const calc = service.calculate({
          equipment: mkEquipment({
            specs: { waterVolume: 1000, maxDensity: 30, maxBiomass: 5000 },
          }),
          existing: { salmonBiomassKg: 4500, cleanerBiomassKg: 0 },
          incomingBiomassKg: 600,
        });
        expect(calc.isOverBiomass).toBe(true);
        // Density at 5100/1000=5.1 still under 30, so density is fine —
        // biomass is the binding constraint.
        expect(calc.isOverDensity).toBe(false);
        expect(calc.primaryBlockReason).toBe('biomass');
      });

      it('does not flag biomass when maxBiomass is 0 (unconfigured)', () => {
        const calc = service.calculate({
          equipment: mkEquipment({
            specs: { waterVolume: 100, maxDensity: 30 },
          }),
          existing: { salmonBiomassKg: 2900, cleanerBiomassKg: 0 },
          incomingBiomassKg: 1000,
        });
        expect(calc.maxBiomassKg).toBe(0);
        expect(calc.isOverBiomass).toBe(false);
      });
    });

    describe('status axis', () => {
      it.each([
        [EquipmentStatus.OPERATIONAL],
        [EquipmentStatus.ACTIVE],
        [EquipmentStatus.PREPARING],
        [EquipmentStatus.FALLOW],
        [EquipmentStatus.STANDBY],
      ])('allows stocking when status is %s', (status) => {
        const calc = service.calculate({
          equipment: mkEquipment({
            specs: { waterVolume: 100, maxDensity: 30 },
            status,
          }),
          existing: { salmonBiomassKg: 0, cleanerBiomassKg: 0 },
          incomingBiomassKg: 100,
        });
        expect(calc.isStatusBlocked).toBe(false);
      });

      it('blocks stocking when status is OUT_OF_SERVICE', () => {
        const calc = service.calculate({
          equipment: mkEquipment({
            specs: { waterVolume: 100, maxDensity: 30 },
            status: EquipmentStatus.OUT_OF_SERVICE,
          }),
          existing: { salmonBiomassKg: 0, cleanerBiomassKg: 0 },
          incomingBiomassKg: 100,
        });
        expect(calc.isStatusBlocked).toBe(true);
        expect(calc.primaryBlockReason).toBe('status');
      });

      it('blocks stocking when equipment is not tank-shaped (no specs, no isTank)', () => {
        const calc = service.calculate({
          equipment: mkEquipment({ specs: {}, isTank: false }),
          existing: { salmonBiomassKg: 0, cleanerBiomassKg: 0 },
          incomingBiomassKg: 100,
        });
        expect(calc.isStatusBlocked).toBe(true);
      });
    });

    describe('primary block reason precedence', () => {
      it('status outranks biomass and density', () => {
        const calc = service.calculate({
          equipment: mkEquipment({
            specs: { waterVolume: 1, maxDensity: 1, maxBiomass: 1 },
            status: EquipmentStatus.OUT_OF_SERVICE,
          }),
          existing: { salmonBiomassKg: 100, cleanerBiomassKg: 0 },
          incomingBiomassKg: 100,
        });
        expect(calc.primaryBlockReason).toBe('status');
      });

      it('biomass outranks density when both fail', () => {
        const calc = service.calculate({
          equipment: mkEquipment({
            specs: { waterVolume: 100, maxDensity: 30, maxBiomass: 1000 },
          }),
          existing: { salmonBiomassKg: 900, cleanerBiomassKg: 0 },
          incomingBiomassKg: 5000, // 5900/100 = 59 > 30 AND > 1000
        });
        expect(calc.isOverBiomass).toBe(true);
        expect(calc.isOverDensity).toBe(true);
        expect(calc.primaryBlockReason).toBe('biomass');
      });
    });
  });

  describe('enforce()', () => {
    const blockedParams = {
      equipment: mkEquipment({
        specs: { waterVolume: 10, maxDensity: 30 },
      }),
      existing: { salmonBiomassKg: 0, cleanerBiomassKg: 0 },
      incomingBiomassKg: 400, // 400/10 = 40 > 30
    };
    const okParams = {
      equipment: mkEquipment({
        specs: { waterVolume: 100, maxDensity: 30 },
      }),
      existing: { salmonBiomassKg: 500, cleanerBiomassKg: 0 },
      incomingBiomassKg: 1000,
    };

    it('throws TankCapacityExceededError in hard mode when over capacity', () => {
      expect(() =>
        service.enforce({ ...blockedParams, mode: 'hard' }),
      ).toThrow(TankCapacityExceededError);
    });

    it('returns calculation without throwing in hard mode when within capacity', () => {
      const calc = service.enforce({ ...okParams, mode: 'hard' });
      expect(calc.isOverCapacity).toBe(false);
    });

    it('does not throw in soft mode even when over capacity', () => {
      const calc = service.enforce({ ...blockedParams, mode: 'soft' });
      expect(calc.isOverCapacity).toBe(true);
    });

    describe('admin-override mode', () => {
      it('accepts override when caller has SUPER_ADMIN role', () => {
        const calc = service.enforce({
          ...blockedParams,
          mode: 'admin-override',
          callerRoles: ['SUPER_ADMIN'],
          callerUserId: 'user-1',
        });
        expect(calc.isOverCapacity).toBe(true);
      });

      it('accepts override when caller has TENANT_ADMIN role', () => {
        const calc = service.enforce({
          ...blockedParams,
          mode: 'admin-override',
          callerRoles: ['TENANT_ADMIN'],
          callerUserId: 'user-2',
        });
        expect(calc.isOverCapacity).toBe(true);
      });

      it('rejects override when caller lacks admin role', () => {
        expect(() =>
          service.enforce({
            ...blockedParams,
            mode: 'admin-override',
            callerRoles: ['MODULE_USER'],
            callerUserId: 'user-3',
          }),
        ).toThrow(TankCapacityExceededError);
      });

      it('rejects when callerRoles is empty', () => {
        expect(() =>
          service.enforce({
            ...blockedParams,
            mode: 'admin-override',
            callerRoles: [],
          }),
        ).toThrow(TankCapacityExceededError);
      });

      it('does not throw when capacity is OK even without admin role', () => {
        const calc = service.enforce({
          ...okParams,
          mode: 'admin-override',
          callerRoles: ['MODULE_USER'],
        });
        expect(calc.isOverCapacity).toBe(false);
      });
    });

    describe('error messages', () => {
      it('cites the tank code and primary block reason', () => {
        expect.assertions(3);
        try {
          service.enforce({ ...blockedParams, mode: 'hard' });
        } catch (err) {
          const message = (err as Error).message;
          expect(message).toContain('TANK-01');
          expect(message).toContain('density');
          expect(message).toContain('40');
        }
      });

      it('mentions biomass when biomass is the primary block reason', () => {
        expect.assertions(2);
        try {
          service.enforce({
            mode: 'hard',
            equipment: mkEquipment({
              specs: { waterVolume: 1000, maxDensity: 30, maxBiomass: 5000 },
            }),
            existing: { salmonBiomassKg: 4500, cleanerBiomassKg: 0 },
            incomingBiomassKg: 600,
          });
        } catch (err) {
          const message = (err as Error).message;
          expect(message).toContain('TANK-01');
          expect(message).toContain('biomass');
        }
      });
    });
  });
});
