/**
 * List Critical Health Events Query
 */
import { IQuery } from '@platform/cqrs';

export class ListCriticalHealthEventsQuery implements IQuery {
  constructor(public readonly tenantId: string) {}
}
