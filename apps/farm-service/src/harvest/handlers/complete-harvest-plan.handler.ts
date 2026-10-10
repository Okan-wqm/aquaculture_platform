/**
 * CompleteHarvestPlanHandler
 *
 * Completes an IN_PROGRESS harvest plan and harvests the counted fish out of
 * every tank that holds the plan's batch.
 *
 * WHY (FARM-HIGH-394): #1670 completed a plan by reading the tank stock
 * outside any transaction, dispatching one CreateHarvestRecordCommand per
 * tank (each its own transaction) and saving the plan COMPLETED last, without
 * ever locking the plan row. A failure on tank 2 left tank 1 harvested and
 * the plan IN_PROGRESS; the retry harvested tank 1 again. Two concurrent
 * submits both saw IN_PROGRESS and both moved the stock.
 *
 * WHAT: ONE runInTenantTransaction —
 *   1. lock the plan row FOR UPDATE and check its status: IN_PROGRESS
 *      proceeds; COMPLETED with the same counted figures is an idempotent
 *      replay (returns the plan, moves nothing); COMPLETED with other
 *      figures is a 409; anything else is a 400;
 *   2. lock the batch, then the tank-batch rows holding it (the batch →
 *      tank-batch order every stock-removal path takes, so no deadlock with
 *      a direct harvest);
 *   3. split the counted quantity across those tanks
 *      ({@link allocateHarvestAcrossTanks}, FARM-MEDIUM-397);
 *   4. harvest each tank through {@link HarvestRecordWriter} — the one owner
 *      of the harvest write — with the caller's quality class and no buyer
 *      (FARM-HIGH-396: completion fabricated neither a SUPERIOR class nor a
 *      customer delivery);
 *   5. mark the plan COMPLETED in the same transaction.
 * Any failure rolls every tank back with the plan. The batch-closure chain
 * runs after the commit, as for a direct harvest.
 *
 * @module Harvest/Handlers
 */
import { runInTenantTransaction } from '@aquaculture/backend-common/database';
import { hasAnyRole } from '@aquaculture/backend-common/decorators';
import type { SiteScopeCaller } from '@aquaculture/backend-common/security';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { CommandHandler, ICommandHandler } from '@platform/cqrs';
import { DataSource, EntityManager } from 'typeorm';

import { Batch } from '../../batch/entities/batch.entity';
import { TankBatch } from '../../batch/entities/tank-batch.entity';
import { tankCompositionOf } from '../../batch/services/tank-batch.service';
import { MUTATION_ROLES } from '../../common/authz/permission-matrix';
import { FinanceSettingsService } from '../../finance/services/finance-settings.service';
import {
  CompleteHarvestPlanActuals,
  CompleteHarvestPlanCommand,
} from '../commands/complete-harvest-plan.command';
import { HarvestPlan, HarvestPlanStatus } from '../entities/harvest-plan.entity';
import { allocateHarvestAcrossTanks, type TankStock } from '../services/harvest-allocation';
import { HarvestRecordWriter } from '../services/harvest-record-writer.service';

/**
 * The completeHarvestPlan role set, read from the farm permission matrix (the
 * SSoT the mutation's @Roles mirrors). A missing entry yields an empty set, so
 * every caller is refused rather than any being admitted.
 */
const COMPLETE_HARVEST_PLAN_ROLES = [...(MUTATION_ROLES['completeHarvestPlan'] ?? [])];

/**
 * SEC-HIGH-188: refuse a caller whose roles do not reach the
 * completeHarvestPlan floor through the canonical role hierarchy — an empty
 * role set or a role string outside the hierarchy included. Generic message:
 * the response never discloses which role was missing.
 */
function assertMayCompleteHarvestPlan(caller: SiteScopeCaller): void {
  const authorised = caller.roles.some((role) => hasAnyRole(role, COMPLETE_HARVEST_PLAN_ROLES));
  if (!authorised) {
    throw new ForbiddenException('Access denied');
  }
}

/** Same counted figures as the completed plan (decimal columns compared numerically). */
function sameActuals(plan: HarvestPlan, actuals: CompleteHarvestPlanActuals): boolean {
  return (
    Number(plan.actualQuantityHarvested) === actuals.actualQuantity &&
    Number(plan.actualBiomassHarvested) === actuals.actualBiomass &&
    Number(plan.actualAvgWeight) === actuals.actualAvgWeight
  );
}

/** biomass (kg) of `quantity` fish out of the counted total, 3-decimal kg. */
function biomassShare(actuals: CompleteHarvestPlanActuals, quantity: number): number {
  return Number(((actuals.actualBiomass * quantity) / actuals.actualQuantity).toFixed(3));
}

interface CompletionOutcome {
  plan: HarvestPlan;
  /** Record code of the harvest that emptied the batch, when one did. */
  finalRecordCode: string | null;
}

@Injectable()
@CommandHandler(CompleteHarvestPlanCommand)
export class CompleteHarvestPlanHandler
  implements ICommandHandler<CompleteHarvestPlanCommand, HarvestPlan>
{
  constructor(
    private readonly dataSource: DataSource,
    private readonly financeSettings: FinanceSettingsService,
    private readonly harvestRecordWriter: HarvestRecordWriter,
  ) {}

  async execute(command: CompleteHarvestPlanCommand): Promise<HarvestPlan> {
    const { tenantId, planId, actuals, caller } = command;
    assertMayCompleteHarvestPlan(caller);

    const harvestDate = new Date();
    const defaultCurrency = await this.financeSettings.getDefaultCurrency(tenantId);

    const outcome = await runInTenantTransaction(
      this.dataSource,
      'farm',
      tenantId,
      async (queryRunner): Promise<CompletionOutcome> => {
        const manager = queryRunner.manager;

        const plan = await manager.findOne(HarvestPlan, {
          where: { id: planId, tenantId },
          lock: { mode: 'pessimistic_write' },
        });
        if (!plan) {
          throw new NotFoundException(`Harvest plan with ID ${planId} not found`);
        }
        if (plan.status === HarvestPlanStatus.COMPLETED) {
          if (sameActuals(plan, actuals)) {
            // A retried or double-submitted completion: the first one moved
            // the stock; this one moves nothing.
            return { plan, finalRecordCode: null };
          }
          throw new ConflictException(
            `Harvest plan ${plan.planCode} is already completed with different results.`,
          );
        }
        if (plan.status !== HarvestPlanStatus.IN_PROGRESS) {
          throw new BadRequestException(
            `Cannot complete harvest plan with status ${plan.status}. Plan must be in progress.`,
          );
        }

        const batch = await manager.findOne(Batch, {
          where: { id: plan.batchId, tenantId, isActive: true },
          lock: { mode: 'pessimistic_write' },
        });
        if (!batch) {
          throw new NotFoundException(`Batch ${plan.batchId} not found`);
        }

        const stocks = await this.lockStockOfBatch(manager, tenantId, plan.batchId);
        const shares = allocateHarvestAcrossTanks(stocks, actuals.actualQuantity);

        let finalRecordCode: string | null = null;
        let biomassBooked = 0;
        for (const [index, share] of shares.entries()) {
          const isLast = index === shares.length - 1;
          // The last tank takes the remainder so the booked biomass sums to
          // exactly the counted biomass.
          const totalBiomass = isLast
            ? Number((actuals.actualBiomass - biomassBooked).toFixed(3))
            : biomassShare(actuals, share.quantity);
          biomassBooked += totalBiomass;

          const written = await this.harvestRecordWriter.write(manager, {
            tenantId,
            input: {
              batchId: plan.batchId,
              tankId: share.tankId,
              quantityHarvested: share.quantity,
              averageWeight: actuals.actualAvgWeight,
              totalBiomass,
              qualityClass: actuals.qualityClass,
              harvestDate,
              notes: `Harvest plan ${plan.planCode} completion`,
              harvestPlanId: plan.id,
            },
            harvestDate,
            caller,
            defaultCurrency,
          });
          if (written.isFinalHarvest) {
            finalRecordCode = written.recordCode;
          }
        }

        plan.complete(actuals.actualQuantity, actuals.actualBiomass, actuals.actualAvgWeight);
        const saved = await manager.save(HarvestPlan, plan);
        return { plan: saved, finalRecordCode };
      },
    );

    if (outcome.finalRecordCode !== null) {
      await this.harvestRecordWriter.closeBatchAfterFinalHarvest(
        tenantId,
        outcome.plan.batchId,
        caller.sub,
        outcome.finalRecordCode,
      );
    }
    return outcome.plan;
  }

  /**
   * The batch's book stock per tank, read under a FOR UPDATE lock on every
   * tank-batch row holding it (tank order, so concurrent completions lock in
   * the same order). Per-tank quantity comes from {@link tankCompositionOf},
   * the same reading the SSoT writer debits.
   */
  private async lockStockOfBatch(
    manager: EntityManager,
    tenantId: string,
    batchId: string,
  ): Promise<TankStock[]> {
    const rows = await manager
      .createQueryBuilder(TankBatch, 'tb')
      .where('tb.tenantId = :tenantId', { tenantId })
      .andWhere(
        `(tb.primaryBatchId = :batchId OR EXISTS (
            SELECT 1 FROM jsonb_array_elements(COALESCE(tb."batchDetails", '[]'::jsonb)) AS detail(value)
            WHERE detail.value->>'batchId' = CAST(:batchId AS text)))`,
        { batchId },
      )
      .orderBy('tb.tankId', 'ASC')
      .setLock('pessimistic_write')
      .getMany();

    const stocks: TankStock[] = [];
    for (const row of rows) {
      const entry = tankCompositionOf(row).find((detail) => detail.batchId === batchId);
      if (entry && entry.quantity > 0) {
        stocks.push({ tankId: row.tankId, quantity: entry.quantity });
      }
    }
    return stocks;
  }
}
