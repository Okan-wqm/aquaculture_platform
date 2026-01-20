/**
 * ListBatchesQuery
 *
 * Batch'leri filtreler ve paginasyonla listeler.
 *
 * @module Batch/Queries
 */
import { ITenantQuery, IPaginatedQuery } from '@platform/cqrs';
import { BatchStatus, BatchInputType } from '../entities/batch.entity';

export interface BatchFilterInput {
  status?: BatchStatus[];
  speciesId?: string;
  inputType?: BatchInputType;
  siteId?: string;
  departmentId?: string;
  tankId?: string;
  supplierId?: string;
  isActive?: boolean;
  stockedAfter?: Date;
  stockedBefore?: Date;
  searchTerm?: string;           // batchNumber, name içinde arama
}

export class ListBatchesQuery implements ITenantQuery, IPaginatedQuery {
  constructor(
    public readonly tenantId: string,
    public readonly filter?: BatchFilterInput,
    public readonly page: number = 1,
    public readonly limit: number = 20,
    public readonly sortBy: string = 'stockedAt',
    public readonly sortOrder: 'ASC' | 'DESC' = 'DESC',
  ) {}
}
