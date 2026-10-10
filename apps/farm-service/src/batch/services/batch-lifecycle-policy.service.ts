import { BadRequestException, Injectable } from '@nestjs/common';

import { BatchCloseReason } from '../commands/close-batch.command';
import { Batch, BatchStatus } from '../entities/batch.entity';

/**
 * The batch status state machine — the ONE table every status rule derives
 * from (FARM-MEDIUM-401): manual status updates (canTransitionStatus), the
 * statuses a harvest may run in and the statuses a partial-harvest signal
 * advances to HARVESTING. Batch carries no copy (its canTransitionTo table was
 * removed); farm-batch-policy-transaction-ssot.spec keeps it that way.
 *
 * ACTIVE and GROWING -> HARVESTING are legal: a partial harvest of a growing
 * batch (thinning, size-graded harvest) is normal aquaculture practice.
 * QUARANTINE has no edge to HARVESTING: quarantined fish (biosecurity hold,
 * medication withdrawal) may not be harvested until released to ACTIVE.
 */
export const BATCH_STATUS_TRANSITIONS: Readonly<Record<BatchStatus, readonly BatchStatus[]>> =
  Object.freeze({
    [BatchStatus.QUARANTINE]: [BatchStatus.ACTIVE, BatchStatus.FAILED],
    [BatchStatus.ACTIVE]: [
      BatchStatus.GROWING,
      BatchStatus.HARVESTING,
      BatchStatus.TRANSFERRED,
      BatchStatus.FAILED,
    ],
    [BatchStatus.GROWING]: [
      BatchStatus.PRE_HARVEST,
      BatchStatus.HARVESTING,
      BatchStatus.TRANSFERRED,
      BatchStatus.FAILED,
    ],
    [BatchStatus.PRE_HARVEST]: [BatchStatus.HARVESTING, BatchStatus.GROWING, BatchStatus.FAILED],
    [BatchStatus.HARVESTING]: [BatchStatus.HARVESTED, BatchStatus.FAILED],
    [BatchStatus.HARVESTED]: [BatchStatus.CLOSED],
    [BatchStatus.TRANSFERRED]: [BatchStatus.CLOSED],
    [BatchStatus.FAILED]: [BatchStatus.CLOSED],
    [BatchStatus.CLOSED]: [],
  });


/**
 * The statuses a PARTIAL-harvest signal (BatchHarvested with isFinal=false)
 * advances to HARVESTING — derived from {@link BATCH_STATUS_TRANSITIONS}: every
 * status with an edge to HARVESTING (FARM-HIGH-399, FARM-MEDIUM-401).
 *
 * WHY derived and not "anything but HARVESTING": the signal arrives
 * asynchronously, after the harvest committed. A plan completion across two
 * tanks emits a non-final event for the first tank and a final one for the
 * last, and the final one closes the batch (HARVESTED -> CLOSED, isActive
 * false) before the listener drains the non-final one. A finished cycle has
 * no edge to HARVESTING, so it never leaves its status on such a signal.
 */
export const PARTIAL_HARVEST_SOURCE_STATUSES: readonly BatchStatus[] = Object.freeze(
  Object.values(BatchStatus).filter((status) =>
    BATCH_STATUS_TRANSITIONS[status].includes(BatchStatus.HARVESTING),
  ),
);

/**
 * May fish of a batch in `status` be harvested? Yes in HARVESTING and in every
 * status the table lets advance to HARVESTING; never in QUARANTINE or a
 * finished cycle. The one predicate the harvest writer and the partial-harvest
 * listener share (FARM-MEDIUM-401).
 */
export function isHarvestableStatus(status: BatchStatus): boolean {
  return status === BatchStatus.HARVESTING || PARTIAL_HARVEST_SOURCE_STATUSES.includes(status);
}

/** Refuse a harvest of a batch whose status {@link isHarvestableStatus} rejects. */
export function assertBatchHarvestable(batch: Pick<Batch, 'batchNumber' | 'status'>): void {
  if (isHarvestableStatus(batch.status)) {
    return;
  }
  const reason =
    batch.status === BatchStatus.QUARANTINE
      ? 'quarantined fish may not be harvested. Release the batch from quarantine first ' +
        '(batch detail → "Release from quarantine", module manager or tenant admin)'
      : 'the batch has no harvestable stock in this status';
  throw new BadRequestException(
    `Batch ${batch.batchNumber} is ${batch.status} and cannot be harvested: ${reason}.`,
  );
}

/**
 * Transitions the table allows but only a dedicated command may perform, with
 * the mutation that owns each (FARM-MEDIUM-402). QUARANTINE -> ACTIVE ends a
 * biosecurity hold and makes the batch harvestable, so it goes through
 * releaseBatchFromQuarantine (MODULE_MANAGER+, reason, audit row), never the
 * generic updateBatchStatus.
 */
const DEDICATED_TRANSITIONS: ReadonlyArray<{
  from: BatchStatus;
  to: BatchStatus;
  mutation: string;
}> = Object.freeze([
  { from: BatchStatus.QUARANTINE, to: BatchStatus.ACTIVE, mutation: 'releaseBatchFromQuarantine' },
]);

@Injectable()
export class BatchLifecyclePolicyService {
  private readonly closeReasonPreviousStatuses: Readonly<Record<BatchCloseReason, readonly BatchStatus[]>> = {
    [BatchCloseReason.HARVEST_COMPLETED]: [BatchStatus.HARVESTED, BatchStatus.HARVESTING],
    [BatchCloseReason.TRANSFERRED]: [BatchStatus.TRANSFERRED],
    [BatchCloseReason.FAILED]: [BatchStatus.FAILED, BatchStatus.QUARANTINE, BatchStatus.ACTIVE, BatchStatus.GROWING],
    [BatchCloseReason.CANCELLED]: [BatchStatus.QUARANTINE, BatchStatus.ACTIVE],
    [BatchCloseReason.OTHER]: [BatchStatus.HARVESTED, BatchStatus.TRANSFERRED, BatchStatus.FAILED],
  };

  canTransitionStatus(currentStatus: BatchStatus, nextStatus: BatchStatus): boolean {
    return BATCH_STATUS_TRANSITIONS[currentStatus].includes(nextStatus);
  }

  assertCanTransitionStatus(batch: Batch, nextStatus: BatchStatus): void {
    if (this.canTransitionStatus(batch.status, nextStatus)) {
      return;
    }

    throw new BadRequestException(
      `Geçersiz status geçişi: ${batch.status} -> ${nextStatus}. ` +
        `Bu batch ${batch.status} durumundan ${nextStatus} durumuna geçemez.`,
    );
  }

  /**
   * The generic status update (updateBatchStatus) may perform a table
   * transition only when no dedicated command owns it.
   */
  assertGenericStatusUpdateAllowed(batch: Batch, nextStatus: BatchStatus): void {
    const dedicated = DEDICATED_TRANSITIONS.find(
      (transition) => transition.from === batch.status && transition.to === nextStatus,
    );
    if (dedicated) {
      throw new BadRequestException(
        `${batch.status} -> ${nextStatus} is not a plain status update; use ${dedicated.mutation}.`,
      );
    }
  }

  allowedCloseStatuses(reason: BatchCloseReason): readonly BatchStatus[] {
    return this.closeReasonPreviousStatuses[reason];
  }

  assertCanCloseForReason(batch: Batch, reason: BatchCloseReason): void {
    if (this.allowedCloseStatuses(reason).includes(batch.status)) {
      return;
    }

    throw new BadRequestException(
      `Batch ${reason} nedeniyle kapatılamaz. Mevcut durum: ${batch.status}`,
    );
  }
}
