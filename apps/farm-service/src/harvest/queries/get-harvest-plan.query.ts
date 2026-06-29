/**
 * Get Harvest Plan (by id) Query
 */
import { IQuery } from '@platform/cqrs';

export class GetHarvestPlanQuery implements IQuery {
  constructor(
    public readonly tenantId: string,
    public readonly id: string,
  ) {}
}
