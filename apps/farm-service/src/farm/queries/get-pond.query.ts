import { IQuery } from '@platform/cqrs';

/**
 * Get Pond Query
 * Query to retrieve a single pond by ID
 */
export class GetPondQuery implements IQuery {
  readonly queryName = 'GetPond';

  constructor(
    public readonly pondId: string,
    public readonly tenantId: string,
    public readonly includeBatches: boolean = true,
    public readonly includeFarm: boolean = false,
  ) {}
}
