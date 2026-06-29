/**
 * Get Auto Rule Query
 */
import { IQuery } from '@platform/cqrs';

export class GetAutoRuleQuery implements IQuery {
  constructor(
    public readonly tenantId: string,
    public readonly id: string,
  ) {}
}
