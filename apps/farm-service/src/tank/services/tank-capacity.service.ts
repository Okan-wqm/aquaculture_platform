/**
 * Tank Capacity Service
 *
 * Centralises the "will this tank still be within its configured
 * biomass, density, and status limits after this allocation?" invariant.
 * This is the single source of truth used by every handler that places
 * fish into a tank. Three axes are checked in one place:
 *
 *   1. **Status** — equipment must `canHoldFish()` (is_tank, or has
 *      tank-like specs). OPERATIONAL/ACTIVE/PREPARING/FALLOW/STANDBY
 *      statuses are acceptable; OUT_OF_SERVICE/DECOMMISSIONED reject.
 *   2. **Biomass** — projected total biomass must not exceed
 *      `specifications.maxBiomass` (kg cap).
 *   3. **Density** — projected density must not exceed
 *      `specifications.maxDensity` (kg/m³ cap). Default 30 when
 *      unconfigured (industry default for salmonids).
 *
 * The service replaces three competing implementations:
 *
 *   a. `Equipment.hasCapacityFor(biomassToAdd)` entity method — still
 *      present but marked @deprecated and delegates here for the
 *      duration of the migration. Eventually it will be removed and
 *      all callers will consume the service directly.
 *   b. Inline ad-hoc checks in create-batch.handler.ts and
 *      transfer-batch.handler.ts that only computed the density flag
 *      without enforcement.
 *   c. The previous density-only version of this service (pre-Phase-1
 *      of the kalan-kör-noktalar plan; shipped in commit 80b16c1b and
 *      consumed by deployCleanerFish).
 *
 * Three enforcement modes:
 *
 *   - **'hard'** — throw BadRequestException when any axis would be
 *     violated. Used for operations placing fish into an already
 *     stocked tank: allocateBatchToTank, transferBatch (destination),
 *     deployCleanerFish.
 *
 *   - **'admin-override'** — like 'hard', but when the caller carries a
 *     SUPER_ADMIN or TENANT_ADMIN role the violation is logged and
 *     allowed. Used when the operator intentionally accepts
 *     over-stocking (e.g. triage during disease outbreak). The logged
 *     warning forms an audit trail; the caller is still expected to
 *     record an audit_log entry.
 *
 *   - **'soft'** — never throw. Return the flags so the caller can
 *     persist `isOverCapacity` / `capacityUsedPercent` on the TankBatch
 *     row. Used only for initial stocking (create-batch) where the
 *     operator may distribute fish across tanks as they grow.
 *
 * Volume priority follows the legacy create-batch handler so values
 * remain consistent across the system:
 *   specifications.waterVolume
 *   → specifications.effectiveVolume
 *   → specifications.volume
 *   → equipment.volume (top-level denormalised field)
 */
import {
  Injectable,
  Logger,
} from '@nestjs/common';

import { EquipmentStatus } from '../../equipment/entities/equipment.entity';
import type { Equipment } from '../../equipment/entities/equipment.entity';
import { TankCapacityExceededError } from '../../common/errors/farm-errors';

/** Shape of the biomass already present on the tank (from TankBatch / equipment.currentBiomass). */
export interface ExistingTankBiomass {
  /** Total salmon biomass currently on the tank in kg. 0 when no production batch is stocked. */
  salmonBiomassKg: number;
  /** Total cleaner-fish biomass currently on the tank in kg. 0 when none deployed. */
  cleanerBiomassKg: number;
}

/** Reasons a capacity check can fail. At most one axis is reported as the primary blocker per call. */
export type CapacityBlockReason =
  | 'status'
  | 'biomass'
  | 'density';

export interface CapacityCalculation {
  /** Effective tank volume in m³ — 0 when equipment specs do not configure it. */
  tankVolumeM3: number;
  /** Configured maxBiomass in kg, or 0 when unconfigured (means no biomass cap enforced). */
  maxBiomassKg: number;
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
  isOverDensity: boolean;
  /** True when the projected biomass would exceed the configured maxBiomass. */
  isOverBiomass: boolean;
  /** True when the equipment cannot hold fish (wrong type or wrong status). */
  isStatusBlocked: boolean;
  /** True if any of the above axes fails. */
  isOverCapacity: boolean;
  /** Primary blocking axis (null when capacity is OK). */
  primaryBlockReason: CapacityBlockReason | null;
}

export interface CapacityEnforceParams {
  /** Tank equipment row. specifications, status, volume, isTank all consulted. */
  equipment: Pick<
    Equipment,
    | 'id'
    | 'code'
    | 'name'
    | 'specifications'
    | 'status'
    | 'volume'
    | 'isTank'
  >;
  /** Biomass already on the tank before this allocation. */
  existing: ExistingTankBiomass;
  /** Biomass about to be added by the caller, in kg. */
  incomingBiomassKg: number;
}

export interface EnforceOptions {
  /** Enforcement mode — see class docstring. */
  mode: 'hard' | 'soft' | 'admin-override';
  /** Roles of the caller — consulted only when mode is 'admin-override'. */
  callerRoles?: ReadonlyArray<string>;
  /** User ID — included in the admin-override audit log message. */
  callerUserId?: string;
}

/** Industry default used when the tank does not declare its own maxDensity. */
const DEFAULT_MAX_DENSITY_KG_M3 = 30;

/** Statuses acceptable for holding fish — matches allocate-to-tank.handler.ts pre-migration behaviour. */
const STATUSES_ALLOWED_FOR_STOCKING: ReadonlySet<string> = new Set([
  EquipmentStatus.OPERATIONAL,
  EquipmentStatus.ACTIVE,
  EquipmentStatus.PREPARING,
  EquipmentStatus.FALLOW,
  EquipmentStatus.STANDBY,
]);

/** Roles authorised to override a hard capacity/biomass/density block. */
const ADMIN_OVERRIDE_ROLES: ReadonlySet<string> = new Set([
  'SUPER_ADMIN',
  'TENANT_ADMIN',
]);

@Injectable()
export class TankCapacityService {
  private readonly logger = new Logger(TankCapacityService.name);

  /**
   * Compute every capacity flag for the tank after an allocation.
   * Pure function — no I/O, no side effects, deterministic.
   *
   * Callers that just want to flag TankBatch rows (soft mode) can use
   * this directly and skip enforce().
   */
  calculate(params: CapacityEnforceParams): CapacityCalculation {
    const { equipment, existing, incomingBiomassKg } = params;
    const specs = (equipment.specifications ?? {}) as Record<string, unknown>;

    const tankVolumeM3 = Number(
      specs.waterVolume ||
        specs.effectiveVolume ||
        specs.volume ||
        equipment.volume ||
        0,
    );
    const maxBiomassKg = Number(specs.maxBiomass || 0);
    const maxDensityKgM3 = Number(
      specs.maxDensity || DEFAULT_MAX_DENSITY_KG_M3,
    );

    const currentBiomassKg =
      Number(existing.salmonBiomassKg || 0) +
      Number(existing.cleanerBiomassKg || 0);
    const projectedBiomassKg =
      currentBiomassKg + Number(incomingBiomassKg || 0);

    const projectedDensityKgM3 =
      tankVolumeM3 > 0 ? projectedBiomassKg / tankVolumeM3 : 0;
    const utilizationPercent =
      maxDensityKgM3 > 0
        ? (projectedDensityKgM3 / maxDensityKgM3) * 100
        : 0;

    // Status axis — mirrors Equipment.canHoldFish() logic:
    // - must be a tank (isTank=true) OR carry tank-like specs
    // - status must be in the stocking-allowed set
    const hasTankShape =
      equipment.isTank ||
      Boolean(specs.maxBiomass || specs.maxDensity || specs.volume);
    const statusOk = STATUSES_ALLOWED_FOR_STOCKING.has(equipment.status);
    const isStatusBlocked = !hasTankShape || !statusOk;

    // Biomass axis — only enforced when maxBiomass is configured.
    const isOverBiomass =
      maxBiomassKg > 0 && projectedBiomassKg > maxBiomassKg;

    // Density axis — only enforced when volume is known.
    const isOverDensity =
      tankVolumeM3 > 0 && projectedDensityKgM3 > maxDensityKgM3;

    const isOverCapacity = isStatusBlocked || isOverBiomass || isOverDensity;

    // Primary reason is the "strongest" axis — status outranks biomass
    // outranks density, because status is a hard gate and biomass is a
    // harder physical cap than density (which can be eased temporarily).
    let primaryBlockReason: CapacityBlockReason | null = null;
    if (isStatusBlocked) primaryBlockReason = 'status';
    else if (isOverBiomass) primaryBlockReason = 'biomass';
    else if (isOverDensity) primaryBlockReason = 'density';

    return {
      tankVolumeM3,
      maxBiomassKg,
      maxDensityKgM3,
      currentBiomassKg,
      projectedBiomassKg,
      projectedDensityKgM3,
      utilizationPercent,
      isStatusBlocked,
      isOverBiomass,
      isOverDensity,
      isOverCapacity,
      primaryBlockReason,
    };
  }

  /**
   * Run the capacity calculation and apply the requested enforcement
   * policy. Returns the calculation in every mode so the caller can
   * persist `isOverCapacity` / `capacityUsedPercent` on the TankBatch.
   *
   * Throws BadRequestException when mode='hard' and any axis fails,
   * or when mode='admin-override' and the caller lacks an override
   * role.
   *
   * When mode='admin-override' and the caller is an admin, the
   * override is logged at warn level; the caller is still expected to
   * record an audit_log entry at the domain layer.
   */
  enforce(
    params: CapacityEnforceParams & EnforceOptions,
  ): CapacityCalculation {
    const calc = this.calculate(params);

    if (!calc.isOverCapacity) {
      return calc;
    }

    // Soft mode — never throw.
    if (params.mode === 'soft') {
      return calc;
    }

    const message = this.buildBlockMessage(params.equipment.code, calc);

    // Admin override allowed? Check caller role.
    if (params.mode === 'admin-override') {
      const hasOverrideRole = (params.callerRoles ?? []).some((r) =>
        ADMIN_OVERRIDE_ROLES.has(r),
      );
      if (hasOverrideRole) {
        this.logger.warn(
          `ADMIN OVERRIDE accepted for tank ${params.equipment.code} by user ` +
            `${params.callerUserId ?? 'unknown'}: ${message}`,
        );
        return calc;
      }
    }

    // Hard mode (or admin-override without the role) — reject.
    this.logger.warn(`Tank capacity check failed: ${message}`);
    throw new TankCapacityExceededError({
      userMessage: message,
      axis: this.mapAxis(calc.primaryBlockReason),
      mode: this.mapMode(params.mode),
      projectedBiomassKg: calc.projectedBiomassKg,
      maxBiomassKg: calc.maxBiomassKg > 0 ? calc.maxBiomassKg : undefined,
      projectedDensityKgM3: calc.projectedDensityKgM3,
      maxDensityKgM3: calc.maxDensityKgM3,
    });
  }

  private mapAxis(
    reason: CapacityCalculation['primaryBlockReason'],
  ): 'biomass' | 'density' | 'status' {
    if (reason === 'biomass') return 'biomass';
    if (reason === 'density') return 'density';
    return 'status';
  }

  private mapMode(mode: EnforceOptions['mode']): 'hard' | 'admin_override' | 'soft' {
    if (mode === 'admin-override') return 'admin_override';
    return mode;
  }

  /**
   * Human-readable block message with full context. Exposed so the
   * audit logger can reuse it.
   */
  private buildBlockMessage(
    tankCode: string,
    calc: CapacityCalculation,
  ): string {
    const axis = calc.primaryBlockReason ?? 'unknown';
    const base = `Tank ${tankCode} cannot accept the requested biomass (${axis} limit).`;

    const parts: string[] = [base];
    parts.push(
      `projected=${calc.projectedBiomassKg.toFixed(1)}kg ` +
        `current=${calc.currentBiomassKg.toFixed(1)}kg ` +
        `volume=${calc.tankVolumeM3}m³`,
    );
    if (calc.maxBiomassKg > 0) {
      parts.push(`maxBiomass=${calc.maxBiomassKg}kg`);
    }
    parts.push(
      `density=${calc.projectedDensityKgM3.toFixed(2)}/${calc.maxDensityKgM3}kg/m³ ` +
        `(${calc.utilizationPercent.toFixed(0)}%)`,
    );
    if (calc.isStatusBlocked) {
      parts.push(`status=blocked`);
    }
    return parts.join(' ');
  }
}
