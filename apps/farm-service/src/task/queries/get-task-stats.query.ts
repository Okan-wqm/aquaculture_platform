/**
 * Get Task Stats Query
 */
import { IQuery } from '@platform/cqrs';

export class GetTaskStatsQuery implements IQuery {
  constructor(public readonly tenantId: string) {}
}
