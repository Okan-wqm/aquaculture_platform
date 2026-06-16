import { Role } from '@aquaculture/backend-common/decorators';

import { RecordStockMovementInput } from '../dto/record-stock-movement.input';

export class RecordStockMovementCommand {
  constructor(
    public readonly input: RecordStockMovementInput,
    public readonly tenantId: string,
    public readonly userId: string,
    /** Denormalized user display name from JWT for audit trail */
    public readonly userName?: string,
    // SEC-HIGH-051: caller authz context for the object-level site check.
    public readonly userRoles: Role[] = [],
    public readonly callerAssignedSiteIds: string[] = [],
  ) {}
}
