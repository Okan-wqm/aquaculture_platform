import { ICommand } from '@platform/cqrs';

/**
 * Harvest Batch Command
 * Command to mark a batch as harvested
 */
export class HarvestBatchCommand implements ICommand {
  readonly commandName = 'HarvestBatch';

  constructor(
    public readonly batchId: string,
    public readonly tenantId: string,
    public readonly userId: string,
    public readonly harvestedQuantity: number,
    public readonly harvestedWeight: number,
    public readonly harvestedAt?: Date,
    public readonly notes?: string,
  ) {}
}
