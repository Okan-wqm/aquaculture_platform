/**
 * List Species Query
 * @module Species/Queries
 */
import { IQuery } from '@platform/cqrs';
import { SpeciesFilterInput } from '../dto/species-filter.dto';

export class ListSpeciesQuery implements IQuery {
  constructor(
    public readonly tenantId: string,
    public readonly filter?: SpeciesFilterInput,
  ) {}
}
