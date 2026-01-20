/**
 * Get Species By Code Query
 * @module Species/Queries
 */
import { IQuery } from '@platform/cqrs';

export class GetSpeciesByCodeQuery implements IQuery {
  constructor(
    public readonly tenantId: string,
    public readonly code: string,
  ) {}
}
