/**
 * AdjustFeedInventoryCommand
 *
 * Yem stoğunda manuel düzeltme yapmak için command.
 *
 * @module Feeding/Commands
 */
import { ITenantCommand } from '@platform/cqrs';

/**
 * Düzeltme tipi
 */
export enum AdjustmentType {
  INCREASE = 'increase',
  DECREASE = 'decrease',
  SET_QUANTITY = 'set_quantity',
}

/**
 * Stok düzeltme payload
 */
export interface AdjustFeedInventoryPayload {
  inventoryId: string;
  adjustmentType: AdjustmentType;
  quantity: number;
  reason: string;
  notes?: string;
}

export class AdjustFeedInventoryCommand implements ITenantCommand {
  readonly commandName = 'AdjustFeedInventoryCommand';

  constructor(
    public readonly tenantId: string,
    public readonly payload: AdjustFeedInventoryPayload,
    public readonly userId: string,
  ) {}
}
