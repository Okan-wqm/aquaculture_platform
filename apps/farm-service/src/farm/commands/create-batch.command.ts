import { ICommand } from '@platform/cqrs';

/**
 * Create Pond Batch Command
 * Command to create a new batch in a pond (Farm module version)
 * Note: Renamed from CreateBatchCommand to avoid conflict with Batch module
 */
export class CreatePondBatchCommand implements ICommand {
  readonly commandName = 'CreatePondBatch';

  constructor(
    public readonly name: string,
    public readonly species: string,
    public readonly quantity: number,
    public readonly pondId: string,
    public readonly tenantId: string,
    public readonly userId: string,
    public readonly stockedAt: Date,
    public readonly strain?: string,
    public readonly averageWeight?: number,
    public readonly expectedHarvestDate?: Date,
    public readonly notes?: string,
  ) {}
}
