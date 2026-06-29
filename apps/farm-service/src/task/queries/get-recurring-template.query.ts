/**
 * Get Recurring Template Query
 */
import { IQuery } from '@platform/cqrs';

export class GetRecurringTemplateQuery implements IQuery {
  constructor(
    public readonly tenantId: string,
    public readonly id: string,
  ) {}
}
