/**
 * ReleaseBatchFromQuarantineHandler (FARM-MEDIUM-402).
 *
 * A quarantined batch cannot be harvested (FARM-MEDIUM-401), so the release is
 * the operator's path back to a harvestable batch. It is the only way out of
 * QUARANTINE to ACTIVE: MODULE_MANAGER+ (permission matrix, re-checked here),
 * through the status table, with an audit row and a BatchStatusChanged event
 * in the same transaction.
 */
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { Role } from '@aquaculture/backend-common/decorators';
import { collaborator, createMockDataSource, createMockRepository } from '@aquaculture/testing';
import type { OutboxPublisher } from '@platform/outbox';

import { AuditAction } from '../../../database/entities/audit-log.entity';
import type { AuditLogService } from '../../../database/services/audit-log.service';
import { ReleaseBatchFromQuarantineCommand } from '../../commands/release-batch-from-quarantine.command';
import { Batch, BatchStatus } from '../../entities/batch.entity';
import { ReleaseBatchFromQuarantineHandler } from '../../handlers/release-batch-from-quarantine.handler';
import {
  BatchLifecyclePolicyService,
  isHarvestableStatus,
} from '../../services/batch-lifecycle-policy.service';

const TENANT = '11111111-1111-4111-8111-111111111111';
const BATCH_ID = '22222222-2222-4222-8222-222222222222';
const USER = '33333333-3333-4333-8333-333333333333';

function harness(status: BatchStatus) {
  const batch = Object.assign(new Batch(), {
    id: BATCH_ID,
    tenantId: TENANT,
    batchNumber: 'B-2026-001',
    status,
    isActive: true,
  });
  const { mockDataSource, mockQueryRunner, mockManager } = createMockDataSource();
  const batchRepo = createMockRepository<Batch>();
  batchRepo.findOne.mockResolvedValue(batch);
  batchRepo.save.mockImplementation(async (saved) => Object.assign(new Batch(), saved));
  mockManager.getRepository.mockReturnValue(batchRepo);
  const enqueue = jest.fn().mockResolvedValue(undefined);
  const logWithManager = jest.fn().mockResolvedValue({});
  const handler = new ReleaseBatchFromQuarantineHandler(
    mockDataSource,
    collaborator<OutboxPublisher>({ enqueue }, 'OutboxPublisher'),
    new BatchLifecyclePolicyService(),
    collaborator<AuditLogService>({ logWithManager }, 'AuditLogService'),
  );
  return { handler, batch, batchRepo, enqueue, logWithManager, mockManager, mockQueryRunner };
}

function release(roles: Role[]): ReleaseBatchFromQuarantineCommand {
  return new ReleaseBatchFromQuarantineCommand(
    TENANT,
    BATCH_ID,
    'Inspection passed, withdrawal elapsed',
    {
      sub: USER,
      roles,
    },
  );
}

describe('ReleaseBatchFromQuarantineHandler', () => {
  it('moves a QUARANTINE batch to ACTIVE with an audit row and a status event, making it harvestable', async () => {
    const h = harness(BatchStatus.QUARANTINE);

    const result = await h.handler.execute(release([Role.MODULE_MANAGER]));

    expect(result.status).toBe(BatchStatus.ACTIVE);
    expect(result.statusReason).toBe(
      'Released from quarantine: Inspection passed, withdrawal elapsed',
    );
    expect(result.updatedBy).toBe(USER);
    expect(isHarvestableStatus(result.status)).toBe(true);
    expect(h.logWithManager).toHaveBeenCalledWith(
      h.mockManager,
      expect.objectContaining({
        tenantId: TENANT,
        entityType: 'Batch',
        entityId: BATCH_ID,
        action: AuditAction.UPDATE,
        userId: USER,
        changes: expect.objectContaining({ before: { status: BatchStatus.QUARANTINE } }),
      }),
    );
    expect(h.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'BatchStatusChanged',
        batchId: BATCH_ID,
        previousStatus: BatchStatus.QUARANTINE,
        newStatus: BatchStatus.ACTIVE,
      }),
      h.mockManager,
    );
    expect(h.mockQueryRunner.commitTransaction).toHaveBeenCalled();
  });

  it('locks the batch row before deciding', async () => {
    const h = harness(BatchStatus.QUARANTINE);

    await h.handler.execute(release([Role.TENANT_ADMIN]));

    expect(h.batchRepo.findOne).toHaveBeenCalledWith(
      expect.objectContaining({ lock: { mode: 'pessimistic_write' } }),
    );
  });

  it.each([[[Role.MODULE_USER]], [[]]])(
    'refuses a caller below MODULE_MANAGER (%p) before any read',
    async (roles) => {
      const h = harness(BatchStatus.QUARANTINE);

      await expect(h.handler.execute(release(roles))).rejects.toThrow(ForbiddenException);
      expect(h.batchRepo.findOne).not.toHaveBeenCalled();
      expect(h.logWithManager).not.toHaveBeenCalled();
    },
  );

  it('refuses a batch that is not in quarantine and writes nothing', async () => {
    const h = harness(BatchStatus.GROWING);

    await expect(h.handler.execute(release([Role.MODULE_MANAGER]))).rejects.toThrow(
      BadRequestException,
    );
    expect(h.batchRepo.save).not.toHaveBeenCalled();
    expect(h.logWithManager).not.toHaveBeenCalled();
    expect(h.enqueue).not.toHaveBeenCalled();
  });
});
