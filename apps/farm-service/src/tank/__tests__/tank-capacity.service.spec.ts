/**
 * TankCapacityService Unit Tests
 *
 * Covers the density-based capacity invariant used by create-batch,
 * allocate-to-tank, transfer-batch, and deploy-cleaner-fish handlers.
 * See docs/illustrator/ Girdi 15-B15 (welfare compliance driver).
 */
import { BadRequestException } from '@nestjs/common';
import { TankCapacityService } from '../services/tank-capacity.service';
import type { Equipment } from '../../equipment/entities/equipment.entity';

function mkEquipment(specs: Record<string, unknown>): Pick<
  Equipment,
  'id' | 'code' | 'name' | 'specifications'
> {
  return {
    id: 'eq-1',
    code: 'TANK-01',
    name: 'Test Tank',
    specifications: specs as unknown as Equipment['specifications'],
  };
}

describe('TankCapacityService', () => {
  const service = new TankCapacityService();

  describe('calculate()', () => {
    it('computes density and utilisation within limits', () => {
      const calc = service.calculate({
        equipment: mkEquipment({ waterVolume: 100, maxDensity: 30 }),
        existing: { salmonBiomassKg: 500, cleanerBiomassKg: 0 },
        incomingBiomassKg: 1000,
      });

      expect(calc.tankVolumeM3).toBe(100);
      expect(calc.maxDensityKgM3).toBe(30);
      expect(calc.projectedBiomassKg).toBe(1500);
      expect(calc.projectedDensityKgM3).toBe(15); // 1500 / 100
      expect(calc.utilizationPercent).toBe(50);
      expect(calc.isOverCapacity).toBe(false);
    });

    it('flags over-capacity when projected density exceeds maxDensity', () => {
      const calc = service.calculate({
        equipment: mkEquipment({ waterVolume: 50, maxDensity: 30 }),
        existing: { salmonBiomassKg: 1200, cleanerBiomassKg: 100 },
        incomingBiomassKg: 300,
      });

      // total = 1200 + 100 + 300 = 1600; density = 1600/50 = 32
      expect(calc.projectedDensityKgM3).toBeCloseTo(32, 6);
      expect(calc.isOverCapacity).toBe(true);
      expect(calc.utilizationPercent).toBeGreaterThan(100);
    });

    it('applies the 30 kg/m³ industry default when maxDensity is unconfigured', () => {
      const calc = service.calculate({
        equipment: mkEquipment({ waterVolume: 10 }),
        existing: { salmonBiomassKg: 0, cleanerBiomassKg: 0 },
        incomingBiomassKg: 400,
      });
      expect(calc.maxDensityKgM3).toBe(30);
      expect(calc.isOverCapacity).toBe(true); // 400/10 = 40 > 30
    });

    it('never flags over-capacity when tank volume is 0 (unconfigured)', () => {
      const calc = service.calculate({
        equipment: mkEquipment({ maxDensity: 30 }),
        existing: { salmonBiomassKg: 0, cleanerBiomassKg: 0 },
        incomingBiomassKg: 10000,
      });
      expect(calc.tankVolumeM3).toBe(0);
      expect(calc.isOverCapacity).toBe(false);
    });

    it('prefers waterVolume, then effectiveVolume, then volume', () => {
      expect(
        service.calculate({
          equipment: mkEquipment({
            waterVolume: 100,
            effectiveVolume: 80,
            volume: 60,
          }),
          existing: { salmonBiomassKg: 0, cleanerBiomassKg: 0 },
          incomingBiomassKg: 0,
        }).tankVolumeM3,
      ).toBe(100);

      expect(
        service.calculate({
          equipment: mkEquipment({ effectiveVolume: 80, volume: 60 }),
          existing: { salmonBiomassKg: 0, cleanerBiomassKg: 0 },
          incomingBiomassKg: 0,
        }).tankVolumeM3,
      ).toBe(80);

      expect(
        service.calculate({
          equipment: mkEquipment({ volume: 60 }),
          existing: { salmonBiomassKg: 0, cleanerBiomassKg: 0 },
          incomingBiomassKg: 0,
        }).tankVolumeM3,
      ).toBe(60);
    });
  });

  describe('enforce()', () => {
    it('throws BadRequestException in hard mode when over capacity', () => {
      expect(() =>
        service.enforce({
          mode: 'hard',
          equipment: mkEquipment({ waterVolume: 10, maxDensity: 30 }),
          existing: { salmonBiomassKg: 0, cleanerBiomassKg: 0 },
          incomingBiomassKg: 400, // 400/10 = 40 > 30
        }),
      ).toThrow(BadRequestException);
    });

    it('returns calculation without throwing in hard mode when within capacity', () => {
      const calc = service.enforce({
        mode: 'hard',
        equipment: mkEquipment({ waterVolume: 100, maxDensity: 30 }),
        existing: { salmonBiomassKg: 500, cleanerBiomassKg: 0 },
        incomingBiomassKg: 1000,
      });
      expect(calc.isOverCapacity).toBe(false);
    });

    it('does not throw in soft mode even when over capacity', () => {
      const calc = service.enforce({
        mode: 'soft',
        equipment: mkEquipment({ waterVolume: 10, maxDensity: 30 }),
        existing: { salmonBiomassKg: 0, cleanerBiomassKg: 0 },
        incomingBiomassKg: 400,
      });
      expect(calc.isOverCapacity).toBe(true);
    });

    it('error message cites the tank code, density, and cap for operator clarity', () => {
      try {
        service.enforce({
          mode: 'hard',
          equipment: mkEquipment({ waterVolume: 10, maxDensity: 30 }),
          existing: { salmonBiomassKg: 0, cleanerBiomassKg: 0 },
          incomingBiomassKg: 400,
        });
        fail('expected BadRequestException');
      } catch (err) {
        const message = (err as Error).message;
        expect(message).toContain('TANK-01');
        expect(message).toContain('40');
        expect(message).toContain('30');
      }
    });
  });
});
