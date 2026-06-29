/**
 * List Overdue Harvest Plans Query
 */
import { IQuery } from '@platform/cqrs';

export class ListOverdueHarvestPlansQuery implements IQuery {
  constructor(public readonly tenantId: string) {}
}
