import { Role } from '@aquaculture/backend-common/decorators';

import { TransferStockInput } from '../dto/transfer-stock.input';

export class TransferStockCommand {
  constructor(
    public readonly input: TransferStockInput,
    public readonly tenantId: string,
    public readonly userId: string,
    /** Denormalized user display name from JWT for audit trail */
    public readonly userName?: string,
    // SEC-HIGH-051: caller authz context. Transfer touches TWO locations
    // (from + to), so the handler asserts EACH location's site.
    public readonly userRoles: Role[] = [],
    public readonly callerAssignedSiteIds: string[] = [],
  ) {}
}
