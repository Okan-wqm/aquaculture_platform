/**
 * ReleaseBatchFromQuarantineCommand
 *
 * Releases a QUARANTINE batch to ACTIVE — the biosecurity / medication-
 * withdrawal hold ends and the batch becomes harvestable (FARM-MEDIUM-402).
 * A dedicated, MODULE_MANAGER+ command with a mandatory reason and an audit
 * row, because the release is the gate the harvest writer relies on.
 *
 * @module Batch/Commands
 */
import type { Role } from '@aquaculture/backend-common/decorators';
import { ITenantCommand } from '@platform/cqrs';

export class ReleaseBatchFromQuarantineCommand implements ITenantCommand {
  constructor(
    public readonly tenantId: string,
    public readonly batchId: string,
    /** Why the hold ends (inspection passed, withdrawal elapsed, ...). */
    public readonly reason: string,
    /** The verified caller; its roles are re-checked against the permission matrix. */
    public readonly caller: { sub: string; roles: Role[] },
  ) {}
}
