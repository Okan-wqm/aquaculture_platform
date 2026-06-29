/**
 * List Auto Rules Query
 */
import { IQuery } from '@platform/cqrs';

export class ListAutoRulesQuery implements IQuery {
  constructor(public readonly tenantId: string) {}
}
