/**
 * Get Harvest Plan Statistics Query
 */
import { IQuery } from '@platform/cqrs';

export class GetHarvestPlanStatsQuery implements IQuery {
  constructor(public readonly tenantId: string) {}
}
