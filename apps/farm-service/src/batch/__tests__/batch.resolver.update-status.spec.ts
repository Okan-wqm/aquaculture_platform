/**
 * BatchResolver.updateBatchStatus → UpdateBatchStatusCommand argument order
 * (FARM-MEDIUM-360).
 *
 * The command takes `(tenantId, batchId, newStatus, reason?, updatedBy?)`.
 * The resolver passed `user.sub` as the reason and the free-text reason as
 * `updatedBy`, so the reason landed in the uuid `updatedBy` column and the
 * mutation failed with `invalid input syntax for type uuid`. Both slots are
 * plain optional strings, so only a test pins which value goes where.
 */
import { collaborator, stubMember } from '@aquaculture/testing';
import { Role } from '@aquaculture/backend-common/decorators';
import type { CommandBus, QueryBus } from '@platform/cqrs';
import type { Repository } from 'typeorm';

import { UpdateBatchStatusCommand } from '../commands/update-batch-status.command';
import type { BatchDocumentDataLoader } from '../dataloaders/batch-document.dataloader';
import type { BatchFeedAssignmentDataLoader } from '../dataloaders/batch-feed-assignment.dataloader';
import type { BatchLocationDataLoader } from '../dataloaders/batch-location.dataloader';
import type { BatchDocument } from '../entities/batch-document.entity';
import { BatchStatus } from '../entities/batch.types';
import { BatchResolver } from '../resolvers/batch.resolver';
import type { TankCountReconcileService } from '../services/tank-count-reconcile.service';

const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const BATCH_ID = '22222222-2222-4222-8222-222222222222';
const USER_ID = '33333333-3333-4333-8333-333333333333';

describe('BatchResolver.updateBatchStatus', () => {
  it('passes the reason as reason and the caller as updatedBy', async () => {
    const execute = jest.fn().mockResolvedValue({ id: BATCH_ID });
    const resolver = new BatchResolver(
      collaborator<CommandBus>(
        { execute: stubMember<CommandBus['execute']>(execute) },
        'CommandBus',
      ),
      collaborator<QueryBus>({}, 'QueryBus'),
      collaborator<Repository<BatchDocument>>({}, 'BatchDocumentRepository'),
      collaborator<BatchDocumentDataLoader>({}, 'BatchDocumentDataLoader'),
      collaborator<BatchLocationDataLoader>({}, 'BatchLocationDataLoader'),
      collaborator<BatchFeedAssignmentDataLoader>({}, 'BatchFeedAssignmentDataLoader'),
      collaborator<TankCountReconcileService>({}, 'TankCountReconcileService'),
    );

    await resolver.updateBatchStatus(
      BATCH_ID,
      BatchStatus.FAILED,
      TENANT_ID,
      {
        sub: USER_ID,
        email: 'manager@example.test',
        tenantId: TENANT_ID,
        roles: [Role.TENANT_ADMIN],
      },
      'disease outbreak in tank 4',
    );

    expect(execute).toHaveBeenCalledTimes(1);
    const command: unknown = execute.mock.calls[0]?.[0];
    expect(command).toBeInstanceOf(UpdateBatchStatusCommand);
    expect(command).toMatchObject({
      tenantId: TENANT_ID,
      batchId: BATCH_ID,
      newStatus: BatchStatus.FAILED,
      reason: 'disease outbreak in tank 4',
      updatedBy: USER_ID,
    });
  });
});
