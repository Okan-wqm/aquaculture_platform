/**
 * Get Harvest Plan (by plan code) Query
 */
import { IQuery } from '@platform/cqrs';

export class GetHarvestPlanByCodeQuery implements IQuery {
  constructor(
    public readonly tenantId: string,
    public readonly planCode: string,
  ) {}
}
