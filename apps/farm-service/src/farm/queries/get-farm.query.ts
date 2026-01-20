import { IQuery } from '@platform/cqrs';

/**
 * Get Farm Query
 * Query to retrieve a single farm by ID
 */
export class GetFarmQuery implements IQuery {
  readonly queryName = 'GetFarm';

  constructor(
    public readonly farmId: string,
    public readonly tenantId: string,
    public readonly includePonds: boolean = true,
    public readonly includeBatches: boolean = false,
  ) {}
}
