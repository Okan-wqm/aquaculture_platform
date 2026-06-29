/**
 * Get Task Query
 */
import { IQuery } from '@platform/cqrs';

export class GetTaskQuery implements IQuery {
  constructor(
    public readonly tenantId: string,
    public readonly id: string,
  ) {}
}
