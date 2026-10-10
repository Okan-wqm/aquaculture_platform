import { BadRequestException, Injectable } from '@nestjs/common';

import { BatchCloseReason } from '../commands/close-batch.command';
import { Batch, BatchStatus } from '../entities/batch.entity';

/**
 * The statuses a PARTIAL-harvest signal (BatchHarvested with isFinal=false)
 * may advance to HARVESTING — the batch still holds live stock in a
 * pre-harvest stage (FARM-HIGH-399).
 *
 * WHY a set and not "anything but HARVESTING": the signal arrives
 * asynchronously, after the harvest committed. A plan completion across two
 * tanks emits a non-final event for the first tank and a final one for the
 * last, and the final one closes the batch (HARVESTED -> CLOSED, isActive
 * false) before the listener drains the non-final one. Moving any status but
 * HARVESTING reopened that CLOSED batch as HARVESTING, which also let a
 * second close through the HARVEST_COMPLETED guard. A finished cycle
 * (HARVESTED, TRANSFERRED, FAILED, CLOSED) never leaves its status on a
 * partial-harvest signal; HARVESTING is already the target.
 */
export const PARTIAL_HARVEST_SOURCE_STATUSES: readonly BatchStatus[] = Object.freeze([
  BatchStatus.QUARANTINE,
  BatchStatus.ACTIVE,
  BatchStatus.GROWING,
  BatchStatus.PRE_HARVEST,
]);

@Injectable()
export class BatchLifecyclePolicyService {
  private readonly statusTransitions: Readonly<Record<BatchStatus, readonly BatchStatus[]>> = {
    [BatchStatus.QUARANTINE]: [BatchStatus.ACTIVE, BatchStatus.FAILED],
    [BatchStatus.ACTIVE]: [BatchStatus.GROWING, BatchStatus.TRANSFERRED, BatchStatus.FAILED],
    [BatchStatus.GROWING]: [BatchStatus.PRE_HARVEST, BatchStatus.TRANSFERRED, BatchStatus.FAILED],
    [BatchStatus.PRE_HARVEST]: [BatchStatus.HARVESTING, BatchStatus.GROWING, BatchStatus.FAILED],
    [BatchStatus.HARVESTING]: [BatchStatus.HARVESTED, BatchStatus.FAILED],
    [BatchStatus.HARVESTED]: [BatchStatus.CLOSED],
    [BatchStatus.TRANSFERRED]: [BatchStatus.CLOSED],
    [BatchStatus.FAILED]: [BatchStatus.CLOSED],
    [BatchStatus.CLOSED]: [],
  };

  private readonly closeReasonPreviousStatuses: Readonly<Record<BatchCloseReason, readonly BatchStatus[]>> = {
    [BatchCloseReason.HARVEST_COMPLETED]: [BatchStatus.HARVESTED, BatchStatus.HARVESTING],
    [BatchCloseReason.TRANSFERRED]: [BatchStatus.TRANSFERRED],
    [BatchCloseReason.FAILED]: [BatchStatus.FAILED, BatchStatus.QUARANTINE, BatchStatus.ACTIVE, BatchStatus.GROWING],
    [BatchCloseReason.CANCELLED]: [BatchStatus.QUARANTINE, BatchStatus.ACTIVE],
    [BatchCloseReason.OTHER]: [BatchStatus.HARVESTED, BatchStatus.TRANSFERRED, BatchStatus.FAILED],
  };

  canTransitionStatus(currentStatus: BatchStatus, nextStatus: BatchStatus): boolean {
    return this.statusTransitions[currentStatus]?.includes(nextStatus) ?? false;
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
