import { numberOrUndefined } from '@aquaculture/backend-common/database';
import { Role } from '@aquaculture/backend-common/decorators';
import { SiteAuthorizationService } from '@aquaculture/backend-common/security';
import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { EntityManager } from 'typeorm';

import { AuditAction } from '../../database/entities/audit-log.entity';
import { AuditLogService } from '../../database/services/audit-log.service';
import { Equipment, EquipmentStatus } from '../../equipment/entities/equipment.entity';
import { Tank, TankStatus } from '../../tank/entities/tank.entity';
import {
  CapacityCalculation,
  TankCapacityService,
} from '../../tank/services/tank-capacity.service';
import { AllocationType } from '../commands/allocate-to-tank.command';
import { TankAllocation } from '../entities/tank-allocation.entity';
import { TankBatch } from '../entities/tank-batch.entity';
import { resolveSiteIdFromDepartment } from '../utils/tank-lookup.util';

import { TankBatchService } from './tank-batch.service';

/**
 * TankStockingService — the ONE way fish are placed into a tank.
 *
 * WHY THIS EXISTS
 *
 * `AllocateToTankHandler` and `CreateBatchHandler`'s `initialLocations` branch
 * both stock a tank, and the second was a weaker copy of the first. FARM-HIGH-139
 * closed the worst of it by routing both through `applyBatchDelta`, the single
 * counter writer — but that only unified the arithmetic. Everything AROUND the
 * arithmetic still differed, and each difference was its own finding:
 *
 *   - SEC-HIGH-167   create-batch asserted no site authorization at all
 *   - FARM-HIGH-323  create-batch took no locks and read capacity unlocked
 *   - FARM-MEDIUM-324 create-batch left the batch QUARANTINE after stocking it
 *   - FARM-MEDIUM-325 create-batch skipped an unresolvable tank and committed
 *
 * Fixing those one at a time on the copy would have left the copy. The sequence
 * that must not diverge lives here instead, so there stops being a second way to
 * stock a tank — a caller gets the locks, the site gate, the capacity decision,
 * the ledger row and the container update together or not at all.
 *
 * WHAT STAYS WITH THE CALLER
 *
 * Per-tank work is here; per-command work is not. The mobile-command receipt, the
 * batch status transition, the outbox event and the stock-projection refresh
 * remain in the handlers, because one command may stock several tanks and those
 * happen once per command, not once per tank.
 *
 * THE CAPACITY READ IS INSIDE THE LOCK
 *
 * This is the substantive change, not just relocation. create-batch used to read
 * its capacity inputs from a bulk pre-fetch taken before the loop, then call
 * `applyBatchDelta` — which acquires its own row lock — some lines later. The
 * value the decision was made on was therefore not the value the write was
 * applied to. Here the container is locked first and every input is read after,
 * so the decision and the write see the same state.
 */
@Injectable()
export class TankStockingService {
  private readonly logger = new Logger(TankStockingService.name);

  constructor(
    private readonly tankCapacityService: TankCapacityService,
    private readonly tankBatchService: TankBatchService,
    private readonly siteAuth: SiteAuthorizationService,
    private readonly auditLogService: AuditLogService,
  ) {}

  /**
   * Place `quantity` fish of one batch into one tank.
   *
   * MUST be called inside the caller's tenant transaction: it takes row locks and
   * writes through the supplied manager so every effect commits or rolls back with
   * the caller's unit.
   */
  async stockTank(manager: EntityManager, args: StockTankArgs): Promise<StockTankResult> {
    const { tenantId, tankId, batch, quantity, avgWeightG } = args;

    const container = await this.lockContainer(manager, tenantId, tankId);
    await this.assertCallerMayStockSite(manager, container, args);

    // Read AFTER the lock — see the class docblock. The cleaner-fish component
    // lets the capacity check account for a mixed-use tank.
    const existingTankBatch = await manager.findOne(TankBatch, {
      where: { tenantId, tankId },
    });

    const biomassKg = (quantity * avgWeightG) / 1000;

    // LIFE-SAFETY: status, biomass and density are all enforced centrally so
    // every path that puts fish in a tank answers the question identically.
    const capacity = this.tankCapacityService.enforce({
      mode: args.capacityMode,
      equipment: container.equipment,
      existing: {
        salmonBiomassKg: Number(container.equipment.currentBiomass || 0),
        cleanerBiomassKg: Number(existingTankBatch?.cleanerFishBiomassKg || 0),
      },
      incomingBiomassKg: biomassKg,
      callerRoles: args.caller.roles,
      callerUserId: args.actorUserId,
    });

    const allocation = await this.writeAllocationLedgerRow(manager, args, {
      biomassKg,
      densityKgM3: capacity.projectedDensityKgM3,
      container,
    });

    // batchDetails[] is the SSoT; the aggregates are derived from it.
    const tankBatch = await this.tankBatchService.applyBatchDelta(
      manager,
      tenantId,
      tankId,
      {
        batchId: batch.id,
        batchNumber: batch.batchNumber,
        quantityDelta: quantity,
        biomassDelta: biomassKg,
        avgWeightG,
      },
      {
        code: container.equipment.code,
        name: container.equipment.name,
        volumeM3: Number(capacity.tankVolumeM3) || 0,
      },
    );

    // Capacity flags are not derivable from the composition, so the decision is
    // persisted onto the SSoT row. An admin override keeps the flag true for the
    // audit trail rather than pretending the tank is within limits.
    tankBatch.isOverCapacity = capacity.isOverCapacity;
    tankBatch.capacityUsedPercent = capacity.utilizationPercent;
    await manager.save(tankBatch);

    if (capacity.isOverCapacity) {
      await this.recordCapacityOverride(manager, args, {
        capacity,
        biomassKg,
        tankBatch,
        container,
      });
    }

    await this.updateContainerTotals(manager, container, tankBatch);

    return { tankBatch, allocation, capacity, container };
  }

  /**
   * Lock the container row before anything reads it.
   *
   * Equipment is the canonical container; a legacy `Tank` row is the fallback and
   * is adapted for the capacity check. Both are locked `pessimistic_write`,
   * because this row's `currentBiomass`/`currentCount`/`status` are written below.
   */
  private async lockContainer(
    manager: EntityManager,
    tenantId: string,
    tankId: string,
  ): Promise<StockingContainer> {
    const equipment = await manager.findOne(Equipment, {
      where: { id: tankId, tenantId, isActive: true, isDeleted: false },
      lock: { mode: 'pessimistic_write' },
    });
    if (equipment) {
      return { equipment, canonicalTank: null };
    }

    const canonicalTank = await manager.findOne(Tank, {
      where: { id: tankId, tenantId, isActive: true },
      lock: { mode: 'pessimistic_write' },
    });
    if (!canonicalTank) {
      // FARM-MEDIUM-325: an unresolvable container refuses the command. Skipping
      // it would commit a batch stocked into fewer tanks than asked for, with
      // nothing telling the caller which ones were dropped.
      throw new NotFoundException(`Tank ${tankId} bulunamadı`);
    }
    return { equipment: tankToCapacityEquipment(canonicalTank), canonicalTank };
  }

  /**
   * SEC-HIGH-051 / SEC-HIGH-167: object-level site authorization.
   *
   * The container is already loaded and locked, so the site resolves from the
   * known departmentId — one Department lookup, no redundant re-read. A legacy
   * Tank carries departmentId where its adapted Equipment may not, so the
   * canonical row wins. MODULE_MANAGER and above bypass by role hierarchy; for
   * anyone else an unassigned OR unresolvable site is denied.
   */
  private async assertCallerMayStockSite(
    manager: EntityManager,
    container: StockingContainer,
    args: StockTankArgs,
  ): Promise<void> {
    const departmentId = container.canonicalTank?.departmentId ?? container.equipment.departmentId;
    const siteId = await resolveSiteIdFromDepartment(manager, departmentId, args.tenantId);

    this.siteAuth.assertSiteAssignment({
      caller: {
        sub: args.actorUserId,
        roles: args.caller.roles,
        assignedSiteIds: args.caller.assignedSiteIds,
      },
      siteId,
    });
  }

  private async writeAllocationLedgerRow(
    manager: EntityManager,
    args: StockTankArgs,
    computed: { biomassKg: number; densityKgM3: number; container: StockingContainer },
  ): Promise<TankAllocation> {
    const allocation = manager.create(TankAllocation, {
      tenantId: args.tenantId,
      batchId: args.batch.id,
      tankId: args.tankId,
      allocationType: args.allocationType,
      allocationDate: args.allocationDate,
      quantity: args.quantity,
      avgWeightG: args.avgWeightG,
      biomassKg: computed.biomassKg,
      densityKgM3: computed.densityKgM3,
      // Denormalized for history: the tank may be renamed or retired later.
      batchNumber: args.batch.batchNumber,
      tankCode: computed.container.equipment.code,
      tankName: computed.container.equipment.name,
      allocatedBy: args.actorUserId,
      notes: args.notes,
      isDeleted: false,
    });
    return manager.save(allocation);
  }

  /**
   * Durable trail for a consciously overridden capacity gate.
   *
   * `enforce` already logged a warn line; a log is not queryable after the fact.
   * The row goes through the caller's manager so it commits atomically with the
   * stocking it describes — an override that rolled back must not leave an audit
   * row claiming it happened.
   */
  private async recordCapacityOverride(
    manager: EntityManager,
    args: StockTankArgs,
    ctx: {
      capacity: CapacityCalculation;
      biomassKg: number;
      tankBatch: TankBatch;
      container: StockingContainer;
    },
  ): Promise<void> {
    const { capacity } = ctx;
    await this.auditLogService.logWithManager(manager, {
      tenantId: args.tenantId,
      entityType: 'TankBatch',
      entityId: ctx.tankBatch.id,
      action: AuditAction.CAPACITY_BLOCKED,
      userId: args.actorUserId,
      changes: {
        after: {
          tankId: args.tankId,
          batchId: args.batch.id,
          incomingBiomassKg: ctx.biomassKg,
          projectedBiomassKg: capacity.projectedBiomassKg,
          projectedDensityKgM3: capacity.projectedDensityKgM3,
          maxBiomassKg: capacity.maxBiomassKg,
          maxDensityKgM3: capacity.maxDensityKgM3,
          utilizationPercent: capacity.utilizationPercent,
          isOverBiomass: capacity.isOverBiomass,
          isOverDensity: capacity.isOverDensity,
          primaryBlockReason: capacity.primaryBlockReason,
        },
      },
      metadata: { source: args.auditSource },
      summary:
        `Admin override: allocated ${ctx.biomassKg.toFixed(2)} kg into ` +
        `tank ${ctx.container.equipment.code ?? args.tankId} despite ${capacity.primaryBlockReason} ` +
        `cap (${capacity.utilizationPercent.toFixed(1)}% utilization)`,
    });
  }

  /**
   * Write the container's totals from the composition the service just derived.
   *
   * Taken from `tankBatch` rather than computed locally: local arithmetic is how
   * a container's count drifts from the batch details that are supposed to
   * explain it (FARM-HIGH-139). A container holding fish is no longer PREPARING
   * or FALLOW, so the status follows.
   */
  private async updateContainerTotals(
    manager: EntityManager,
    container: StockingContainer,
    tankBatch: TankBatch,
  ): Promise<void> {
    if (container.canonicalTank) {
      const tank = container.canonicalTank;
      tank.currentBiomass = tankBatch.totalBiomassKg;
      tank.currentCount = tankBatch.totalQuantity;
      if (tank.status === TankStatus.PREPARING || tank.status === TankStatus.FALLOW) {
        tank.status = TankStatus.ACTIVE;
        tank.statusChangedAt = new Date();
      }
      await manager.save(tank);
      return;
    }

    const equipment = container.equipment;
    equipment.currentBiomass = tankBatch.totalBiomassKg;
    equipment.currentCount = tankBatch.totalQuantity;
    if (
      equipment.status === EquipmentStatus.PREPARING ||
      equipment.status === EquipmentStatus.FALLOW
    ) {
      equipment.status = EquipmentStatus.ACTIVE;
    }
    await manager.save(equipment);
  }
}

/** The locked container, plus the legacy row when that is what backed it. */
export interface StockingContainer {
  readonly equipment: Equipment;
  /** Set only when the tank exists solely as a legacy `tanks` row. */
  readonly canonicalTank: Tank | null;
}

export interface StockTankArgs {
  readonly tenantId: string;
  readonly tankId: string;
  /** The batch being placed; `batchNumber` is denormalized onto the ledger row. */
  readonly batch: { readonly id: string; readonly batchNumber: string };
  readonly quantity: number;
  readonly avgWeightG: number;
  readonly allocationType: AllocationType;
  readonly allocationDate: Date;
  readonly notes?: string;
  /** Who is stocking — recorded on the ledger row and the override audit row. */
  readonly actorUserId: string;
  /**
   * The caller's authority. Defaults of `[]` are fail-closed: a command that
   * forgets to thread identity is denied for a MODULE_USER rather than allowed.
   */
  readonly caller: { readonly roles: Role[]; readonly assignedSiteIds: string[] };
  /**
   * `admin-override` lets an admin exceed the cap with an audit row;
   * `soft` records the breach without blocking. `hard` is available but no
   * stocking path uses it today.
   */
  readonly capacityMode: 'hard' | 'soft' | 'admin-override';
  /** Names the handler in the override audit row's metadata. */
  readonly auditSource: string;
}

export interface StockTankResult {
  readonly tankBatch: TankBatch;
  readonly allocation: TankAllocation;
  readonly capacity: CapacityCalculation;
  readonly container: StockingContainer;
}

/**
 * Adapt a legacy `Tank` row to the Equipment shape the capacity check and the
 * ledger row read. MOVED VERBATIM from AllocateToTankHandler rather than
 * rewritten: `specifications` is what TankCapacityService reads maxBiomass,
 * maxDensity, volume and waterVolume from, so a reconstruction that omitted it
 * would silently drop a legacy tank's limits and fall back to the industry
 * default density — on a life-safety check.
 */
function tankToCapacityEquipment(tank: Tank): Equipment {
  const equipment = new Equipment();
  equipment.id = tank.id;
  equipment.tenantId = tank.tenantId;
  equipment.name = tank.name;
  equipment.code = tank.code;
  equipment.status = mapTankStatusToEquipmentStatus(tank.status);
  equipment.isTank = true;
  equipment.isActive = tank.isActive;
  equipment.isDeleted = false;
  equipment.volume = Number(tank.volume);
  equipment.currentBiomass = Number(tank.currentBiomass);
  equipment.currentCount = tank.currentCount;
  equipment.specifications = {
    tankType: tank.tankType,
    material: tank.material,
    waterType: tank.waterType,
    dimensions: {
      diameter: tank.diameter,
      length: tank.length,
      width: tank.width,
      depth: tank.depth,
      waterDepth: tank.waterDepth,
      freeboard: tank.freeboard,
    },
    volume: Number(tank.volume),
    waterVolume: numberOrUndefined(tank.waterVolume),
    maxBiomass: Number(tank.maxBiomass),
    maxDensity: Number(tank.maxDensity),
    waterFlow: tank.waterFlow,
    aeration: tank.aeration,
  };
  return equipment;
}

function mapTankStatusToEquipmentStatus(status: TankStatus): EquipmentStatus {
  const mapping: Record<TankStatus, EquipmentStatus> = {
    [TankStatus.ACTIVE]: EquipmentStatus.ACTIVE,
    [TankStatus.PREPARING]: EquipmentStatus.PREPARING,
    [TankStatus.CLEANING]: EquipmentStatus.CLEANING,
    [TankStatus.MAINTENANCE]: EquipmentStatus.MAINTENANCE,
    [TankStatus.HARVESTING]: EquipmentStatus.HARVESTING,
    [TankStatus.FALLOW]: EquipmentStatus.FALLOW,
    [TankStatus.QUARANTINE]: EquipmentStatus.QUARANTINE,
    [TankStatus.INACTIVE]: EquipmentStatus.OUT_OF_SERVICE,
  };
  return mapping[status] ?? EquipmentStatus.OPERATIONAL;
}
