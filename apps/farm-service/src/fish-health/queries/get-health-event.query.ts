/**
 * Get Health Event (by id) Query
 */
import { IQuery } from '@platform/cqrs';

export class GetHealthEventQuery implements IQuery {
  constructor(
    public readonly tenantId: string,
    public readonly id: string,
  ) {}
}
