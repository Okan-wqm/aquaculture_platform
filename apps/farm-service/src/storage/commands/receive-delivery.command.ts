import { Role } from '@aquaculture/backend-common/decorators';

import { ReceiveDeliveryInput } from '../dto/receive-delivery.input';

export class ReceiveDeliveryCommand {
  constructor(
    public readonly input: ReceiveDeliveryInput,
    public readonly tenantId: string,
    public readonly userId: string,
    // SEC-HIGH-051: caller authz context for the object-level site check at
    // the stock-movement sink (mirrors RecordStockMovementCommand).
    public readonly userRoles: Role[] = [],
    public readonly callerAssignedSiteIds: string[] = [],
  ) {}
}
