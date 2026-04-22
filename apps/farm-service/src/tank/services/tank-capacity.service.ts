/**
 * Tank Capacity Service
 *
 * Centralises the "will this tank still be within its configured
 * biomass/density limits after this allocation?" invariant. The rule is
 * density-based (kg/m³), matching the legacy ad-hoc logic previously
 * embedded in create-batch.handler.ts and transfer-batch.handler.ts
 * (`density > maxDensity` sets `isOverCapacity`). This service extracts
 * that logic into a single, testable surface so every handler that
 * grows the biomass on a tank uses the same decision rule.
 *
 * Why now: deployCleanerFish, allocateBatchToTank, and transferBatch
 * did not all apply the check consistently. deployCleanerFish in
 * particular created a fresh TankBatch with `isOverCapacity: false`
 * unconditionally — welfare invariant broken (see docs/illustrator/
 * Girdi 15-B15). Two modes are supported:
 *
 *   - 'hard' — throw BadRequestException when projected density exceeds
 *              the tank's configured maxDensity. Used for operations
 *              that place fish into an already-stocked tank
 *              (deploy, transfer-in, allocate).
 *
 *   - 'soft' — never throw, but return `isOverCapacity: true` so the
 *              caller can still record the flag on TankBatch. Used for
 *              initial stocking where the operator may intentionally
 *              accept short-term over-density (fish distributed across
 *              tanks as they grow).
 *
 * Density model:
 *   projected_biomass = current_salmon_biomass + current_cleaner_biomass + incoming
 *   density           = projected_biomass / tank_volume_m3
 *   is_over_capacity  = density > equipment.specifications.maxDensity
 *
 * tank_volume_m3 is read from equipment.specifications using the same
 * priority chain as the legacy handlers: waterVolume → effectiveVolume
 * → volume. maxDensity defaults to 30 kg/m³ when unconfigured (industry
 * default for salmonids; matches the legacy handler fallback).
 */
import {
  BadRequestException,
  Injectable,
  Logger,
} from '@nestjs/common';

import type { Equipment } from '../../equipment/entities/equipment.entity';

/** Shape of the biomass already present on the tank (from TankBatch). */
export interface ExistingTankBiomass {
  /** Total salmon biomass currently on the tank in kg. 0 when no production batch is stocked. */
  salmonBiomassKg: number;
  /** Total cleaner-fish biomass currently on the tank in kg. 0 when none deployed. */
  cleanerBiomassKg: number;
}

export interface CapacityCalculation {
  /** Effective tank volume in m³ — 0 when equipment specs do not configure it. */
  tankVolumeM3: number;
  /** Configured maxDensity in kg/m³, or the industry fallback (30) when unconfigured. */
  maxDensityKgM3: number;
  /** Biomass already present before the new allocation. */
  currentBiomassKg: number;
  /** Biomass after the new allocation is applied. */
  projectedBiomassKg: number;
  /** Projected density in kg/m³ after allocation. */
  projectedDensityKgM3: number;
  /** Utilisation as a percentage of the density cap (0–>100 if overflow). */
  utilizationPercent: number;
  /** True when the projected density would exceed the configured maxDensity. */
  isOverCapacity: boolean;
}

export interface CapacityEnforceParams {
  /** Tank equipment row (specifications.waterVolume, specifications.maxDensity). */
  equipment: Pick<Equipment, 'id' | 'code' | 'name' | 'specifications'>;
  /** Biomass already on the tank before this allocation. */
  existing: ExistingTankBiomass;
  /** Biomass about to be added by the caller, in kg. */
  incomingBiomassKg: number;
}

/** Industry default used when the tank does not declare its own maxDensity. */
const DEFAULT_MAX_DENSITY_KG_M3 = 30;

@Injectable()
export class TankCapacityService {
  private readonly logger = new Logger(TankCapacityService.name);

  /**
   * Compute the projected density and capacity flags for the tank after
   * an allocation. Pure function — no I/O, no side effects.
   */
  calculate(params: CapacityEnforceParams): CapacityCalculation {
    const { equipment, existing, incomingBiomassKg } = params;
    const specs = (equipment.specifications ?? {}) as Record<string, unknown>;

    // Volume priority matches the legacy create-batch handler so
    // values remain consistent across the system.
    const tankVolumeM3 = Number(
      specs.waterVolume || specs.effectiveVolume || specs.volume || 0,
    );
    const maxDensityKgM3 = Number(specs.maxDensity || DEFAULT_MAX_DENSITY_KG_M3);

    const currentBiomassKg =
      Number(existing.salmonBiomassKg || 0) +
      Number(existing.cleanerBiomassKg || 0);
    const projectedBiomassKg = currentBiomassKg + Number(incomingBiomassKg || 0);

    const projectedDensityKgM3 =
      tankVolumeM3 > 0 ? projectedBiomassKg / tankVolumeM3 : 0;
    const utilizationPercent =
      maxDensityKgM3 > 0
        ? (projectedDensityKgM3 / maxDensityKgM3) * 100
        : 0;

    // tankVolumeM3 === 0 means the tank is not configured; we cannot
    // decide capacity and must not block. The caller sees isOverCapacity
    // === false and can log a warning if desired.
    const isOverCapacity =
      tankVolumeM3 > 0 && projectedDensityKgM3 > maxDensityKgM3;

    return {
      tankVolumeM3,
      maxDensityKgM3,
      currentBiomassKg,
      projectedBiomassKg,
      projectedDensityKgM3,
      utilizationPercent,
      isOverCapacity,
    };
  }

  /**
   * Run the capacity calculation and apply the requested enforcement
   * policy. In 'hard' mode, throws BadRequestException when
   * isOverCapacity is true. Returns the calculation in both modes so
   * the caller can persist `isOverCapacity` / `capacityUsedPercent` on
   * the TankBatch row.
   */
  enforce(
    params: CapacityEnforceParams & { mode: 'hard' | 'soft' },
  ): CapacityCalculation {
    const calc = this.calculate(params);

    if (params.mode === 'hard' && calc.isOverCapacity) {
      const details =
        `tank=${params.equipment.code} ` +
        `projected=${calc.projectedBiomassKg.toFixed(1)}kg ` +
        `volume=${calc.tankVolumeM3}m³ ` +
        `density=${calc.projectedDensityKgM3.toFixed(2)}kg/m³ ` +
        `max=${calc.maxDensityKgM3}kg/m³ ` +
        `utilization=${calc.utilizationPercent.toFixed(0)}%`;

      this.logger.warn(`Tank capacity exceeded: ${details}`);
      throw new BadRequestException(
        `Tank ${params.equipment.code} cannot accept the requested biomass ` +
          `without exceeding its density cap. ` +
          `Projected density ${calc.projectedDensityKgM3.toFixed(2)} kg/m³ ` +
          `exceeds configured maximum ${calc.maxDensityKgM3} kg/m³ ` +
          `(${calc.utilizationPercent.toFixed(0)}% utilisation).`,
      );
    }

    return calc;
  }
}
