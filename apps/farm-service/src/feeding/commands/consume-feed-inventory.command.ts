/**
 * ConsumeFeedInventoryCommand
 *
 * Yem stoğundan tüketim yapmak için command.
 *
 * @module Feeding/Commands
 */
import { ITenantCommand } from '@platform/cqrs';

/**
 * Tüketim nedeni
 */
export enum ConsumptionReason {
  FEEDING = 'feeding',
  WASTE = 'waste',
  ADJUSTMENT = 'adjustment',
  EXPIRED = 'expired',
  TRANSFER = 'transfer',
}

/**
 * Yem tüketim payload
 */
export interface ConsumeFeedInventoryPayload {
  inventoryId: string;
  quantityKg: number;
  reason: ConsumptionReason;
  feedingRecordId?: string;
  notes?: string;
}

export class ConsumeFeedInventoryCommand implements ITenantCommand {
  readonly commandName = 'ConsumeFeedInventoryCommand';

  constructor(
    public readonly tenantId: string,
    public readonly payload: ConsumeFeedInventoryPayload,
    public readonly userId: string,
  ) {}
}
