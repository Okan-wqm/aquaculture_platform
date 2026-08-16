import { Injectable } from '@nestjs/common';
import type { TenantMutationSession } from '@aquaculture/backend-common/database';

import { StockMovementService } from '../../storage/services/stock-movement.service';

export interface FeedingStorageCorrection {
  readonly tenantId: string;
  readonly userId: string;
  readonly feedId: string;
  readonly deltaKg: number;
  readonly siteId?: string;
  readonly movementDate: Date;
  readonly sourceDeductionKey: string;
  readonly correctionIdempotencyKey: string;
  readonly reference: string;
}

/** One inventory correction authority for meal pours and manual feeding records. */
@Injectable()
export class FeedingStorageCorrectionService {
  constructor(private readonly stockMovementService: StockMovementService) {}

  async apply(
    mutationSession: TenantMutationSession,
    correction: FeedingStorageCorrection,
  ): Promise<void> {
    if (correction.deltaKg === 0) return;
    await this.stockMovementService.recordFeedCorrection(
      mutationSession,
      {
        feedId: correction.feedId,
        deltaKg: correction.deltaKg,
        asOf: correction.movementDate,
        siteId: correction.siteId,
        sourceDeductionKey: correction.sourceDeductionKey,
        idempotencyKey: correction.correctionIdempotencyKey,
        reference: correction.reference,
      },
      { tenantId: correction.tenantId, userId: correction.userId, userName: 'Feeding' },
    );
  }
}
