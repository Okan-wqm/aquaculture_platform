/**
 * ListHarvestsHandler
 *
 * Handles the ListHarvestsQuery to retrieve harvest records with filtering and pagination.
 *
 * @module Harvest/Handlers
 */
import { runInTenantRead } from '@aquaculture/backend-common/database';
import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, SelectQueryBuilder, Brackets } from 'typeorm';
import { QueryHandler, IQueryHandler } from '@platform/cqrs';
import { PaginatedQueryResult, createPaginatedQueryResult } from '@platform/cqrs';
import { ListHarvestsQuery } from '../queries/list-harvests.query';
import { HarvestRecord } from '../entities/harvest-record.entity';

@Injectable()
@QueryHandler(ListHarvestsQuery)
export class ListHarvestsHandler implements IQueryHandler<ListHarvestsQuery, PaginatedQueryResult<HarvestRecord>> {
  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {}

  async execute(query: ListHarvestsQuery): Promise<PaginatedQueryResult<HarvestRecord>> {
    const { tenantId, filter, pagination } = query;

    const page = pagination?.page ?? 1;
    const limit = pagination?.limit ?? 20;
    const sortBy = pagination?.sortBy ?? 'harvestDate';
    const sortOrder = pagination?.sortOrder ?? 'DESC';
    const offset = (page - 1) * limit;

    // Read through the fail-closed tenant boundary.
    const [items, total] = await runInTenantRead(this.dataSource, 'farm', tenantId, async (queryRunner) => {
      // Build query
      const qb: SelectQueryBuilder<HarvestRecord> = queryRunner.manager
        .createQueryBuilder(HarvestRecord, 'harvest')
        .where('harvest.tenantId = :tenantId', { tenantId });

      // Apply filters
      if (filter) {
        if (filter.batchId) {
          qb.andWhere('harvest.batchId = :batchId', { batchId: filter.batchId });
        }

        if (filter.batchIds?.length) {
          qb.andWhere('harvest.batchId IN (:...batchIds)', { batchIds: filter.batchIds });
        }

        if (filter.tankId) {
          qb.andWhere('harvest.tankId = :tankId', { tankId: filter.tankId });
        }

        if (filter.tankIds?.length) {
          qb.andWhere('harvest.tankId IN (:...tankIds)', { tankIds: filter.tankIds });
        }

        if (filter.pondId) {
          qb.andWhere('harvest.pondId = :pondId', { pondId: filter.pondId });
        }

        if (filter.siteId) {
          qb.andWhere('harvest.siteId = :siteId', { siteId: filter.siteId });
        }

        if (filter.status) {
          qb.andWhere('harvest.status = :status', { status: filter.status });
        }

        if (filter.statuses?.length) {
          qb.andWhere('harvest.status IN (:...statuses)', { statuses: filter.statuses });
        }

        if (filter.qualityGrade) {
          qb.andWhere('harvest.qualityGrade = :qualityGrade', { qualityGrade: filter.qualityGrade });
        }

        if (filter.qualityGrades?.length) {
          qb.andWhere('harvest.qualityGrade IN (:...qualityGrades)', { qualityGrades: filter.qualityGrades });
        }

        if (filter.method) {
          qb.andWhere('harvest.method = :method', { method: filter.method });
        }

        if (filter.productForm) {
          qb.andWhere('harvest.productForm = :productForm', { productForm: filter.productForm });
        }

        if (filter.startDate) {
          qb.andWhere('harvest.harvestDate >= :startDate', { startDate: filter.startDate });
        }

        if (filter.endDate) {
          qb.andWhere('harvest.harvestDate <= :endDate', { endDate: filter.endDate });
        }

        if (filter.qualityApproved !== undefined) {
          qb.andWhere('harvest.qualityApproved = :qualityApproved', { qualityApproved: filter.qualityApproved });
        }

        if (filter.harvestedBy) {
          qb.andWhere('harvest.harvestedBy = :harvestedBy', { harvestedBy: filter.harvestedBy });
        }

        if (filter.minBiomass !== undefined) {
          qb.andWhere('harvest.totalBiomass >= :minBiomass', { minBiomass: filter.minBiomass });
        }

        if (filter.maxBiomass !== undefined) {
          qb.andWhere('harvest.totalBiomass <= :maxBiomass', { maxBiomass: filter.maxBiomass });
        }

        if (filter.minAverageWeight !== undefined) {
          qb.andWhere('harvest.averageWeight >= :minAverageWeight', { minAverageWeight: filter.minAverageWeight });
        }

        if (filter.maxAverageWeight !== undefined) {
          qb.andWhere('harvest.averageWeight <= :maxAverageWeight', { maxAverageWeight: filter.maxAverageWeight });
        }

        if (filter.minQuantity !== undefined) {
          qb.andWhere('harvest.quantityHarvested >= :minQuantity', { minQuantity: filter.minQuantity });
        }

        if (filter.maxQuantity !== undefined) {
          qb.andWhere('harvest.quantityHarvested <= :maxQuantity', { maxQuantity: filter.maxQuantity });
        }

        if (filter.search) {
          qb.andWhere(
            new Brackets(subQb => {
              subQb
                .where('harvest.recordCode ILIKE :search', { search: `%${filter.search}%` })
                .orWhere('harvest.lotNumber ILIKE :search', { search: `%${filter.search}%` })
                .orWhere('harvest.notes ILIKE :search', { search: `%${filter.search}%` });
            })
          );
        }
      }

      // Get total count
      const count = await qb.getCount();

      // Apply pagination and sorting
      const validSortFields = ['harvestDate', 'createdAt', 'recordCode', 'lotNumber', 'totalBiomass', 'quantityHarvested', 'averageWeight', 'status'];
      const safeSortBy = validSortFields.includes(sortBy) ? sortBy : 'harvestDate';
      const validSortOrders: readonly string[] = ['ASC', 'DESC'];
      const safeSortOrder = validSortOrders.includes(sortOrder?.toUpperCase() ?? '')
        ? (sortOrder.toUpperCase() as 'ASC' | 'DESC')
        : 'DESC';

      qb.orderBy(`harvest.${safeSortBy}`, safeSortOrder)
        .skip(offset)
        .take(limit);

      const rows = await qb.getMany();

      return [rows, count] as [HarvestRecord[], number];
    });

    return createPaginatedQueryResult(items, page, limit, total);
  }
}
