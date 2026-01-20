/**
 * List Tanks Query
 * @module Tank/Queries
 */
import { IQuery } from '@platform/cqrs';
import { TankFilterInput } from '../dto/tank-filter.dto';

export class ListTanksQuery implements IQuery {
  constructor(
    public readonly tenantId: string,
    public readonly filter?: TankFilterInput,
  ) {}
}
