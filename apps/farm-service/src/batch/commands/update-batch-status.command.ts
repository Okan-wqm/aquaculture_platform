/**
 * UpdateBatchStatusCommand
 *
 * Batch durumunu değiştirir.
 * Status geçişleri BatchLifecyclePolicyService.assertCanTransitionStatus ile
 * (tek geçiş tablosu: BATCH_STATUS_TRANSITIONS) valide edilir.
 *
 * @module Batch/Commands
 */
import { ITenantCommand } from '@platform/cqrs';
import { BatchStatus } from '../entities/batch.entity';

export class UpdateBatchStatusCommand implements ITenantCommand {
  constructor(
    public readonly tenantId: string,
    public readonly batchId: string,
    public readonly newStatus: BatchStatus,
    public readonly reason?: string,
    public readonly updatedBy?: string,
  ) {}
}
