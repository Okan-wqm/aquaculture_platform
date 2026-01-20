/**
 * Get Species Query
 * @module Species/Queries
 */
import { IQuery } from '@platform/cqrs';

export class GetSpeciesQuery implements IQuery {
  constructor(
    public readonly tenantId: string,
    public readonly id: string,
  ) {}
}
