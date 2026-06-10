import { BadRequestException } from '@nestjs/common';

import { BatchCloseReason } from '../../commands/close-batch.command';
import { Batch, BatchStatus } from '../../entities/batch.entity';
import { BatchLifecyclePolicyService } from '../../services/batch-lifecycle-policy.service';

describe('BatchLifecyclePolicyService', () => {
  const policy = new BatchLifecyclePolicyService();
  const batchWithStatus = (status: BatchStatus): Batch =>
    Object.assign(new Batch(), { status });

  it('allows only declared status transitions', () => {
    expect(policy.canTransitionStatus(BatchStatus.QUARANTINE, BatchStatus.ACTIVE)).toBe(true);
    expect(policy.canTransitionStatus(BatchStatus.ACTIVE, BatchStatus.HARVESTED)).toBe(false);
  });

  it('rejects invalid close reason/status pairs', () => {
    expect(() =>
      policy.assertCanCloseForReason(
        batchWithStatus(BatchStatus.GROWING),
        BatchCloseReason.HARVEST_COMPLETED,
      ),
    ).toThrow(BadRequestException);
  });

  it('keeps OTHER closure restricted to terminal statuses', () => {
    expect(policy.allowedCloseStatuses(BatchCloseReason.OTHER)).toEqual([
      BatchStatus.HARVESTED,
      BatchStatus.TRANSFERRED,
      BatchStatus.FAILED,
    ]);
  });
});
