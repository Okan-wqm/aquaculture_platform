import { BadRequestException, Injectable } from '@nestjs/common';

import { BatchCloseReason } from '../commands/close-batch.command';
import { Batch, BatchStatus } from '../entities/batch.entity';

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
