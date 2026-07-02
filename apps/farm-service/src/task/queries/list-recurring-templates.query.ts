/**
 * List Recurring Templates Query
 */
import { IQuery } from '@platform/cqrs';

export class ListRecurringTemplatesQuery implements IQuery {
  constructor(public readonly tenantId: string) {}
}
