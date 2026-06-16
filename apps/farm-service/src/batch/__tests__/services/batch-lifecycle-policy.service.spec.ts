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

  // close-batch-enum (FARM-HIGH): the four newly exposed reasons must each
  // declare a non-empty prior-status set and gate correctly.
  it('accepts the new close reasons from a valid prior status', () => {
    expect(() =>
      policy.assertCanCloseForReason(
        batchWithStatus(BatchStatus.GROWING),
        BatchCloseReason.TOTAL_MORTALITY,
      ),
    ).not.toThrow();
    expect(() =>
      policy.assertCanCloseForReason(
        batchWithStatus(BatchStatus.QUARANTINE),
        BatchCloseReason.DISEASE_OUTBREAK,
      ),
    ).not.toThrow();
    expect(() =>
      policy.assertCanCloseForReason(
        batchWithStatus(BatchStatus.PRE_HARVEST),
        BatchCloseReason.COMMERCIAL_DECISION,
      ),
    ).not.toThrow();
    expect(() =>
      policy.assertCanCloseForReason(
        batchWithStatus(BatchStatus.TRANSFERRED),
        BatchCloseReason.MERGED,
      ),
    ).not.toThrow();
  });

  it('rejects a new close reason from an invalid (terminal) prior status', () => {
    // A CLOSED batch can never be re-closed under any operational reason.
    expect(() =>
      policy.assertCanCloseForReason(
        batchWithStatus(BatchStatus.CLOSED),
        BatchCloseReason.TOTAL_MORTALITY,
      ),
    ).toThrow(BadRequestException);
  });

  it('declares a non-empty prior-status set for EVERY close reason (exhaustive)', () => {
    for (const reason of Object.values(BatchCloseReason)) {
      expect(policy.allowedCloseStatuses(reason).length).toBeGreaterThan(0);
    }
  });
});
