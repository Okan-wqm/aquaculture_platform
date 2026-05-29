/**
 * UpdateBatchStatusCommand
 *
 * Batch durumunu değiştirir.
 * Status geçişleri batch entity'deki canTransitionTo metoduyla valide edilir.
 *
 * @module Batch/Commands
 */
import { ITenantCommand } from '@platform/cqrs';

import { BatchStatus } from '../entities/batch.entity';

export interface UpdateBatchStatusOptions {
  readonly tenantId: string;
  readonly batchId: string;
  readonly newStatus: BatchStatus;
  readonly updatedBy: string;
  readonly reason?: string;
}

export class UpdateBatchStatusCommand implements ITenantCommand {
  public readonly tenantId: string;
  public readonly batchId: string;
  public readonly newStatus: BatchStatus;
  public readonly updatedBy: string;
  public readonly reason?: string;

  constructor(options: UpdateBatchStatusOptions) {
    this.tenantId = options.tenantId;
    this.batchId = options.batchId;
    this.newStatus = options.newStatus;
    this.updatedBy = options.updatedBy;
    this.reason = options.reason;
  }
}
