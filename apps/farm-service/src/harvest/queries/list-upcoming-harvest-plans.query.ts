/**
 * List Upcoming Harvest Plans Query
 */
import { IQuery } from '@platform/cqrs';

export class ListUpcomingHarvestPlansQuery implements IQuery {
  constructor(
    public readonly tenantId: string,
    public readonly days: number = 30,
  ) {}
}
