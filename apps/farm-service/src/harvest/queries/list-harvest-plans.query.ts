/**
 * List Harvest Plans (filtered, paginated) Query
 */
import { IQuery } from '@platform/cqrs';
import { HarvestPlanFilterInput } from '../dto/harvest-plan-filter.input';

export class ListHarvestPlansQuery implements IQuery {
  constructor(
    public readonly tenantId: string,
    public readonly filter?: HarvestPlanFilterInput,
  ) {}
}
