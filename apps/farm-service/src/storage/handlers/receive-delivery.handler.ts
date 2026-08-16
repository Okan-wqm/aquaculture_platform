import { runInTenantTransaction } from '@aquaculture/backend-common/database';
import { CommandHandler, ICommandHandler } from '@platform/cqrs';
import { DataSource } from 'typeorm';

import { ReceiveDeliveryCommand } from '../commands/receive-delivery.command';
import { PurchaseOrder } from '../entities/purchase-order.entity';
import { StockMovementService } from '../services/stock-movement.service';

/**
 * Tenant-transaction adapter for the canonical stock mutation authority.
 *
 * PO state is intentionally not read here. StockMovementService acquires the
 * caller operation fence, locks and reads the PO inside this pinned tenant
 * transaction, writes immutable movement evidence, advances PO cumulative
 * state, and enqueues outbox facts as one atomic unit.
 */
@CommandHandler(ReceiveDeliveryCommand)
export class ReceiveDeliveryHandler
  implements ICommandHandler<ReceiveDeliveryCommand, PurchaseOrder>
{
  constructor(
    private readonly dataSource: DataSource,
    private readonly stockMovementService: StockMovementService,
  ) {}

  async execute(command: ReceiveDeliveryCommand): Promise<PurchaseOrder> {
    return runInTenantTransaction(this.dataSource, 'farm', command.tenantId, async (queryRunner) =>
      this.stockMovementService.recordPurchaseOrderReceipt(queryRunner.manager, command.input, {
        tenantId: command.tenantId,
        userId: command.userId,
        siteAuthorization: {
          sub: command.userId,
          roles: command.userRoles,
          assignedSiteIds: command.callerAssignedSiteIds,
        },
      }),
    );
  }
}
