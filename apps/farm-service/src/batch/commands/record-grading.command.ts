/**
 * RecordGradingCommand (FARM-MEDIUM-117)
 *
 * First-class grading operation: fish from ONE source tank are sorted
 * into size classes and distributed across destination tanks. Each
 * output movement is executed as an individual TransferBatchCommand
 * (reason 'grading') with its OWN idempotency envelope — grading
 * physically happens output-by-output through the grader, so each
 * committed movement standing alone is the correct domain model, and a
 * mid-operation failure leaves only movements that actually happened.
 *
 * @module Batch/Commands
 */
import { Role } from '@aquaculture/backend-common/decorators';
import { ITenantCommand } from '@platform/cqrs';

export interface GradingOutput {
  destinationTankId: string;
  quantity: number;
  avgWeightG: number;
  sizeClass?: string;
  /** Per-output at-most-once envelope (transfer rejects envelope-less writes). */
  clientCommandId: string;
  payloadHash: string;
}

export interface RecordGradingPayload {
  sourceTankId: string;
  gradedAt?: Date;
  notes?: string;
  outputs: GradingOutput[];
  /** Envelope metadata shared by every output movement. */
  deviceId?: string;
  clientCreatedAt?: string;
  schemaVersion?: string;
}

export class RecordGradingCommand implements ITenantCommand {
  constructor(
    public readonly tenantId: string,
    public readonly batchId: string,
    public readonly payload: RecordGradingPayload,
    public readonly gradedBy: string,
    public readonly userRoles: Role[] = [],
    public readonly callerAssignedSiteIds: string[] = [],
  ) {}
}
