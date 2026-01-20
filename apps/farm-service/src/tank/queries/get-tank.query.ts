/**
 * Get Tank Query
 * @module Tank/Queries
 */
import { IQuery } from '@platform/cqrs';

export class GetTankQuery implements IQuery {
  constructor(
    public readonly tenantId: string,
    public readonly id: string,
  ) {}
}
