/**
 * AddFeedInventoryCommand
 *
 * Yem stoğu eklemek için command.
 *
 * @module Feeding/Commands
 */
import { ITenantCommand } from '@platform/cqrs';

/**
 * Yem stoğu ekleme payload
 */
export interface AddFeedInventoryPayload {
  feedId: string;
  siteId: string;
  departmentId?: string;

  quantityKg: number;
  minStockKg?: number;

  lotNumber?: string;
  manufacturingDate?: Date;
  expiryDate?: Date;
  receivedDate?: Date;

  unitPricePerKg?: number;
  currency?: string;

  storageLocation?: string;
  storageTemperature?: number;

  notes?: string;
}

export class AddFeedInventoryCommand implements ITenantCommand {
  readonly commandName = 'AddFeedInventoryCommand';

  constructor(
    public readonly tenantId: string,
    public readonly payload: AddFeedInventoryPayload,
    public readonly userId: string,
  ) {}
}
