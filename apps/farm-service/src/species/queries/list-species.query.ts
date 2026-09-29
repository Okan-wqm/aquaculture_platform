/**
 * List Species Query
 * @module Species/Queries
 */
import { SpeciesFilterInput } from '../dto/species-filter.dto';
import type { TenantScope } from '@aquaculture/backend-common/database';

export class ListSpeciesQuery {
  constructor(
    public readonly scope: TenantScope,
    public readonly filter?: SpeciesFilterInput,
  ) {}
}
