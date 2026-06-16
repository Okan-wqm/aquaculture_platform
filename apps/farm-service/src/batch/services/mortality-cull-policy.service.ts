import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';

import type { Batch } from '../entities/batch.entity';
import type { TankBatch } from '../entities/tank-batch.entity';

type MortalityCullOperation = 'Mortality' | 'Cull';

/**
 * MortalityCullPolicyService
 *
 * The ONE place that owns the stock-mutation guards shared by the mortality and
 * cull handlers. Centralising them keeps the two handlers honest: a guard added
 * here is enforced on both write paths, and the rules cannot drift apart.
 */
@Injectable()
export class MortalityCullPolicyService {
  /**
   * Point-in-time guard: the removal cannot exceed the batch's current count.
   */
  assertQuantityWithinCurrent(args: {
    readonly operation: MortalityCullOperation;
    readonly quantity: number;
    readonly currentQuantity: number;
  }): void {
    if (args.quantity <= args.currentQuantity) {
      return;
    }

    const label = args.operation === 'Mortality' ? 'Mortality sayısı' : 'Cull sayısı';
    throw new BadRequestException(
      `${label} (${args.quantity}) mevcut sayıdan (${args.currentQuantity}) fazla olamaz`,
    );
  }

  /**
   * FARM-CRITICAL-050 — reject mortality/cull on a terminal (closed) batch.
   *
   * WHY: the handlers previously gated only on `isActive === true`, but
   * update-batch-status reaches HARVESTED/FAILED/TRANSFERRED while leaving
   * isActive=true, so a closed cycle still accepted removals and corrupted
   * inventory. `isActive` is overloaded as a soft-delete flag; the authoritative
   * signal is the STATUS. We gate on `batch.isStockMutable()` — the live-stock
   * states (operational PLUS QUARANTINE), NOT isOperational() alone: quarantined
   * fish are alive and legitimately die / get culled, so excluding QUARANTINE
   * would reject valid removals and inflate the count. Only the terminal states
   * (HARVESTED / TRANSFERRED / FAILED / CLOSED) are rejected.
   */
  assertStockMutable(batch: Batch): void {
    if (batch.isStockMutable()) {
      return;
    }
    throw new ConflictException(
      `Batch ${batch.batchNumber} is not in a stock-mutable state (${batch.status}); ` +
        `mortality/cull is rejected on closed/terminal cycles`,
    );
  }

  /**
   * FARM-HIGH-053 — assert the batch is actually held in the supplied tank.
   *
   * WHY: the handlers loaded the TankBatch by {tenantId, tankId} only and never
   * checked that the batchId being decremented is present in that tank. A
   * wrong/empty tankId would decrement a tank holding a DIFFERENT batch and
   * diverge batch-vs-tank inventory. Membership = the tank's single primary
   * batch (batchId / primaryBatchId) OR a row in the mixed-batch batchDetails.
   * Must be called INSIDE the locked transaction with the locked TankBatch.
   */
  assertBatchInTank(args: { readonly batchId: string; readonly tankBatch: TankBatch | null }): void {
    const { batchId, tankBatch } = args;
    if (!tankBatch) {
      throw new NotFoundException(`Batch ${batchId} is not held in this tank`);
    }

    const isPrimary = tankBatch.primaryBatchId === batchId;
    const isInDetails = tankBatch.batchDetails?.some((detail) => detail.batchId === batchId) ?? false;

    if (!isPrimary && !isInDetails) {
      throw new NotFoundException(`Batch ${batchId} is not held in this tank`);
    }
  }

  /**
   * FARM-LOW-050 — lifecycle ceiling: cumulative removals (mortality + cull +
   * harvest) plus this removal must never exceed what was ever stocked.
   *
   * WHY: assertQuantityWithinCurrent is a point-in-time check against the
   * running currentQuantity; it cannot catch a re-stock / backdated edge case
   * where cumulative removals quietly exceed initialQuantity. This hard ceiling
   * makes "removed more than ever existed" structurally impossible. Reads the
   * freshly-locked batch row, so a concurrent re-stock is reflected.
   */
  assertAggregateWithinInitial(args: { readonly batch: Batch; readonly addedRemoval: number }): void {
    const { batch, addedRemoval } = args;
    const cumulativeRemovals =
      batch.totalMortality + batch.cullCount + (batch.harvestedQuantity ?? 0) + addedRemoval;

    if (cumulativeRemovals > batch.initialQuantity) {
      throw new BadRequestException(
        `Cumulative removals (${cumulativeRemovals}) for batch ${batch.batchNumber} ` +
          `would exceed the initial stocked quantity (${batch.initialQuantity})`,
      );
    }
  }
}
