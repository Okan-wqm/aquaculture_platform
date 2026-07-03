/**
 * List Today's Tasks Query
 */
import { IQuery } from '@platform/cqrs';

export class ListTodaysTasksQuery implements IQuery {
  constructor(public readonly tenantId: string) {}
}
