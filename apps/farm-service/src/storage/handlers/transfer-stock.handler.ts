import { runInTenantTransaction } from '@aquaculture/backend-common/database';
import { CommandHandler, ICommandHandler } from '@platform/cqrs';
import { DataSource } from 'typeorm';

import { TransferStockCommand } from '../commands/transfer-stock.command';
import { MovementType, StockMovement } from '../entities/stock-movement.entity';
import { StockMovementService } from '../services/stock-movement.service';

/**
 * Transfer adapter. Inventory projection, provenance, fencing, authorization,
 * item roll-up and immutable movement creation all belong to one sink.
 */
@CommandHandler(TransferStockCommand)
export class TransferStockHandler implements ICommandHandler<TransferStockCommand, StockMovement> {
  constructor(
    private readonly dataSource: DataSource,
    private readonly stockMovements: StockMovementService,
  ) {}

  async execute(command: TransferStockCommand): Promise<StockMovement> {
    const { input, tenantId, userId, userName } = command;
    return runInTenantTransaction(this.dataSource, 'farm', tenantId, async (queryRunner) => {
      const result = await this.stockMovements.recordMovement(
        queryRunner.manager,
        {
          movementType: MovementType.TRANSFER,
          itemType: input.itemType,
          itemId: input.itemId,
          quantity: input.quantity,
          fromLocationId: input.fromLocationId,
          toLocationId: input.toLocationId,
          lotNumber: input.lotNumber,
          reference: input.reference,
          reason: input.reason,
          idempotencyKey: input.idempotencyKey,
        },
        {
          tenantId,
          userId,
          userName,
          siteAuthorization: {
            sub: userId,
            roles: command.userRoles,
            assignedSiteIds: command.callerAssignedSiteIds,
          },
        },
      );
      return result.saved;
    });
  }
}
