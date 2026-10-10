import { BadRequestException } from '@nestjs/common';

import { BatchCloseReason } from '../../commands/close-batch.command';
import { Batch, BatchStatus } from '../../entities/batch.entity';
import {
  assertBatchHarvestable,
  BATCH_STATUS_TRANSITIONS,
  BatchLifecyclePolicyService,
  isHarvestableStatus,
  PARTIAL_HARVEST_SOURCE_STATUSES,
} from '../../services/batch-lifecycle-policy.service';

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

  describe('harvest rules derive from the one transition table (FARM-MEDIUM-401)', () => {
    it('the partial-harvest source set is exactly the statuses with an edge to HARVESTING', () => {
      const derived = Object.values(BatchStatus).filter((status) =>
        BATCH_STATUS_TRANSITIONS[status].includes(BatchStatus.HARVESTING),
      );
      expect([...PARTIAL_HARVEST_SOURCE_STATUSES]).toEqual(derived);
      expect([...PARTIAL_HARVEST_SOURCE_STATUSES]).toEqual([
        BatchStatus.ACTIVE,
        BatchStatus.GROWING,
        BatchStatus.PRE_HARVEST,
      ]);
    });

    it('a growing (or active) batch may be partially harvested', () => {
      expect(policy.canTransitionStatus(BatchStatus.GROWING, BatchStatus.HARVESTING)).toBe(true);
      expect(policy.canTransitionStatus(BatchStatus.ACTIVE, BatchStatus.HARVESTING)).toBe(true);
      expect(isHarvestableStatus(BatchStatus.GROWING)).toBe(true);
      expect(isHarvestableStatus(BatchStatus.HARVESTING)).toBe(true);
    });

    it('a quarantined batch may not be harvested', () => {
      expect(policy.canTransitionStatus(BatchStatus.QUARANTINE, BatchStatus.HARVESTING)).toBe(false);
      expect(isHarvestableStatus(BatchStatus.QUARANTINE)).toBe(false);
      expect(() =>
        assertBatchHarvestable({ batchNumber: 'B-1', status: BatchStatus.QUARANTINE }),
      ).toThrow(/B-1 is QUARANTINE and cannot be harvested: quarantined fish may not be harvested/);
    });

    it.each([BatchStatus.HARVESTED, BatchStatus.TRANSFERRED, BatchStatus.FAILED, BatchStatus.CLOSED])(
      'a finished %s batch may not be harvested',
      (status) => {
        expect(isHarvestableStatus(status)).toBe(false);
        expect(() => assertBatchHarvestable({ batchNumber: 'B-1', status })).toThrow(
          BadRequestException,
        );
      },
    );

  });
});
