/**
 * GetTankOperationsQuery
 *
 * Belirli bir tank'taki operasyonları filtreli olarak getirir.
 *
 * @module Tank/Queries
 */
import { ITenantQuery, IPaginatedQuery } from '@platform/cqrs';
import { OperationType } from '../../batch/entities/tank-operation.entity';

/**
 * Tank operasyon filtresi
 */
export interface TankOperationFilter {
  operationType?: OperationType[];
  batchId?: string;
  fromDate?: Date;
  toDate?: Date;
  performedBy?: string;
}

export class GetTankOperationsQuery implements ITenantQuery, IPaginatedQuery {
  readonly queryName = 'GetTankOperationsQuery';

  constructor(
    public readonly tenantId: string,
    public readonly tankId: string,
    public readonly filter?: TankOperationFilter,
    public readonly page: number = 1,
    public readonly limit: number = 20,
    public readonly sortBy: string = 'operationDate',
    public readonly sortOrder: 'ASC' | 'DESC' = 'DESC',
  ) {}
}
