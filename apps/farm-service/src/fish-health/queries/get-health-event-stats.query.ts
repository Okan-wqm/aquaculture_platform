/**
 * Get Health Event Statistics Query
 */
import { IQuery } from '@platform/cqrs';

export class GetHealthEventStatsQuery implements IQuery {
  constructor(public readonly tenantId: string) {}
}
