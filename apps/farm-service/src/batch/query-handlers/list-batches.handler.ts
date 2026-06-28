/**
 * ListBatchesHandler
 *
 * ListBatchesQuery'yi işler ve filtrelenmiş/paginated batch listesi döner.
 *
 * @module Batch/QueryHandlers
 */
import { runInTenantRead } from '@aquaculture/backend-common/database';
import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { QueryHandler, IQueryHandler } from '@platform/cqrs';
import { PaginatedQueryResult, createPaginatedQueryResult } from '@platform/cqrs';
import { ListBatchesQuery } from '../queries/list-batches.query';
import { Batch } from '../entities/batch.entity';

@Injectable()
@QueryHandler(ListBatchesQuery)
export class ListBatchesHandler implements IQueryHandler<ListBatchesQuery, PaginatedQueryResult<Batch>> {
  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {}

  async execute(query: ListBatchesQuery): Promise<PaginatedQueryResult<Batch>> {
    const { tenantId, filter, page, limit, sortBy, sortOrder } = query;

    // Read through the fail-closed tenant boundary so the query builder runs on a
    // connection whose search_path + RLS GUC are verified for this tenant.
    const [batches, total] = await runInTenantRead(
      this.dataSource,
      'farm',
      tenantId,
      async (queryRunner) => {
    const queryBuilder = queryRunner.manager
      .createQueryBuilder(Batch, 'batch')
      .leftJoinAndSelect('batch.species', 'species')
      .where('batch.tenantId = :tenantId', { tenantId });

    // Filters
    if (filter) {
      if (filter.status?.length) {
        queryBuilder.andWhere('batch.status IN (:...statuses)', { statuses: filter.status });
      }

      if (filter.speciesId) {
        queryBuilder.andWhere('batch.speciesId = :speciesId', { speciesId: filter.speciesId });
      }

      if (filter.inputType) {
        queryBuilder.andWhere('batch.inputType = :inputType', { inputType: filter.inputType });
      }

      if (filter.supplierId) {
        queryBuilder.andWhere('batch.supplierId = :supplierId', { supplierId: filter.supplierId });
      }

      if (filter.isActive !== undefined) {
        queryBuilder.andWhere('batch.isActive = :isActive', { isActive: filter.isActive });
      }

      if (filter.stockedAfter) {
        queryBuilder.andWhere('batch.stockedAt >= :stockedAfter', { stockedAfter: filter.stockedAfter });
      }

      if (filter.stockedBefore) {
        queryBuilder.andWhere('batch.stockedAt <= :stockedBefore', { stockedBefore: filter.stockedBefore });
      }

      if (filter.searchTerm) {
        queryBuilder.andWhere(
          '(batch.batchNumber ILIKE :search OR batch.name ILIKE :search)',
          { search: `%${filter.searchTerm}%` }
        );
      }

      // Tank filter - batch'in o tank'ta olup olmadığını kontrol et
      // OPTIMIZED: Subquery ile tek sorguda - hem primaryBatchId hem batchDetails JSONB destekli
      if (filter.tankId) {
        queryBuilder.andWhere(`batch.id IN (
          SELECT tb."primaryBatchId" FROM tank_batches tb
          WHERE tb."tankId" = :tankId AND tb."tenantId" = :batchTenantId AND tb."primaryBatchId" IS NOT NULL
          UNION ALL
          SELECT (bd->>'batchId')::uuid FROM tank_batches tb,
          jsonb_array_elements(COALESCE(tb."batchDetails", '[]'::jsonb)) bd
          WHERE tb."tankId" = :tankId AND tb."tenantId" = :batchTenantId
        )`, { tankId: filter.tankId, batchTenantId: tenantId });
      }

      // Site filter - batch'in bu site'taki tank'larda olup olmadığını kontrol et
      if (filter.siteId) {
        queryBuilder.andWhere(`batch.id IN (
          SELECT tb."primaryBatchId" FROM tank_batches tb
          INNER JOIN tanks t ON tb."tankId" = t.id
          INNER JOIN departments d ON t."departmentId" = d.id
          WHERE d."siteId" = :siteId
            AND tb."tenantId" = :siteTenantId
            AND tb."primaryBatchId" IS NOT NULL
          UNION ALL
          SELECT (bd->>'batchId')::uuid FROM tank_batches tb
          INNER JOIN tanks t ON tb."tankId" = t.id
          INNER JOIN departments d ON t."departmentId" = d.id,
          jsonb_array_elements(COALESCE(tb."batchDetails", '[]'::jsonb)) bd
          WHERE d."siteId" = :siteId
            AND tb."tenantId" = :siteTenantId
        )`, { siteId: filter.siteId, siteTenantId: tenantId });
      }

      // Department filter - batch'in bu departmandaki tank'larda olup olmadığını kontrol et
      if (filter.departmentId) {
        queryBuilder.andWhere(`batch.id IN (
          SELECT tb."primaryBatchId" FROM tank_batches tb
          INNER JOIN tanks t ON tb."tankId" = t.id
          WHERE t."departmentId" = :departmentId
            AND tb."tenantId" = :deptTenantId
            AND tb."primaryBatchId" IS NOT NULL
          UNION ALL
          SELECT (bd->>'batchId')::uuid FROM tank_batches tb
          INNER JOIN tanks t ON tb."tankId" = t.id,
          jsonb_array_elements(COALESCE(tb."batchDetails", '[]'::jsonb)) bd
          WHERE t."departmentId" = :departmentId
            AND tb."tenantId" = :deptTenantId
        )`, { departmentId: filter.departmentId, deptTenantId: tenantId });
      }
    }

    // Sorting
    const validSortFields = ['stockedAt', 'batchNumber', 'currentQuantity', 'status', 'createdAt'];
    const sortField = validSortFields.includes(sortBy) ? sortBy : 'stockedAt';
    const validSortOrders: readonly string[] = ['ASC', 'DESC'];
    const safeSortOrder = validSortOrders.includes(sortOrder?.toUpperCase() ?? '')
      ? (sortOrder.toUpperCase() as 'ASC' | 'DESC')
      : 'DESC';
    queryBuilder.orderBy(`batch.${sortField}`, safeSortOrder);

    // Count total
    const count = await queryBuilder.getCount();

    // Pagination
    const offset = (page - 1) * limit;
    queryBuilder.skip(offset).take(limit);

    const rows = await queryBuilder.getMany();

        return [rows, count] as [Batch[], number];
      },
    );

    return createPaginatedQueryResult(batches, page, limit, total);
  }
}
