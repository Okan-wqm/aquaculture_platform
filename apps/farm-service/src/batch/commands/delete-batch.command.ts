/**
 * DeleteBatchCommand
 *
 * Deprecated REST compatibility command for soft-deleting a batch.
 * New clients should close batches through lifecycle-specific commands.
 */
import { ITenantCommand } from '@platform/cqrs';

export interface DeleteBatchCommandEnvelope {
  readonly tenantId: string;
  readonly batchId: string;
  readonly actorUserId: string;
  readonly reason?: string;
  readonly correlationId?: string;
}

export class DeleteBatchCommand implements ITenantCommand {
  public readonly tenantId: string;
  public readonly batchId: string;
  public readonly actorUserId: string;
  public readonly reason?: string;
  public readonly correlationId?: string;

  constructor(envelope: DeleteBatchCommandEnvelope) {
    this.tenantId = envelope.tenantId;
    this.batchId = envelope.batchId;
    this.actorUserId = envelope.actorUserId;
    this.reason = envelope.reason;
    this.correlationId = envelope.correlationId;
  }
}
