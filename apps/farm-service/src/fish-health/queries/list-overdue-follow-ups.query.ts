/**
 * List Health Events with overdue follow-ups Query
 */
import { IQuery } from '@platform/cqrs';

export class ListOverdueFollowUpsQuery implements IQuery {
  constructor(public readonly tenantId: string) {}
}
