/**
 * UpdateBatchCommand
 *
 * Mevcut bir batch'in bilgilerini günceller.
 * Status değişikliği için UpdateBatchStatusCommand kullanılmalıdır.
 *
 * @module Batch/Commands
 */
import { ITenantCommand } from '@platform/cqrs';

export interface UpdateBatchPayload {
  name?: string;
  description?: string;
  strain?: string;
  targetFCR?: number;
  expectedHarvestDate?: Date;
  notes?: string;
}

export class UpdateBatchCommand implements ITenantCommand {
  constructor(
    public readonly tenantId: string,
    public readonly batchId: string,
    public readonly payload: UpdateBatchPayload,
    public readonly updatedBy: string,
  ) {}
}
