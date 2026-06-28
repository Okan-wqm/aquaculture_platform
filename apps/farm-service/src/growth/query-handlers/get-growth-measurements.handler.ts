/**
 * GetGrowthMeasurementsHandler
 *
 * GetGrowthMeasurementsQuery'yi işler ve ölçümleri döner.
 *
 * @module Growth/QueryHandlers
 */
import { runInTenantRead } from '@aquaculture/backend-common/database';
import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { QueryHandler, IQueryHandler } from '@platform/cqrs';
import { PaginatedQueryResult, createPaginatedQueryResult } from '@platform/cqrs';
import { GetGrowthMeasurementsQuery } from '../queries/get-growth-measurements.query';
import { GrowthMeasurement } from '../entities/growth-measurement.entity';

@Injectable()
@QueryHandler(GetGrowthMeasurementsQuery)
export class GetGrowthMeasurementsHandler implements IQueryHandler<GetGrowthMeasurementsQuery, PaginatedQueryResult<GrowthMeasurement>> {
  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {}

  async execute(query: GetGrowthMeasurementsQuery): Promise<PaginatedQueryResult<GrowthMeasurement>> {
    const { tenantId, filter, page, limit, sortBy, sortOrder } = query;

    // Read through the fail-closed tenant boundary.
    const [measurements, total] = await runInTenantRead(this.dataSource, 'farm', tenantId, async (queryRunner) => {
      const queryBuilder = queryRunner.manager
        .createQueryBuilder(GrowthMeasurement, 'gm')
        .leftJoinAndSelect('gm.batch', 'batch')
        .where('gm.tenantId = :tenantId', { tenantId });

      // Filtreler
      if (filter) {
        if (filter.batchId) {
          queryBuilder.andWhere('gm.batchId = :batchId', { batchId: filter.batchId });
        }

        if (filter.tankId) {
          queryBuilder.andWhere('gm.tankId = :tankId', { tankId: filter.tankId });
        }

        if (filter.measurementType?.length) {
          queryBuilder.andWhere('gm.measurementType IN (:...types)', {
            types: filter.measurementType,
          });
        }

        if (filter.performance?.length) {
          queryBuilder.andWhere('gm.performance IN (:...performances)', {
            performances: filter.performance,
          });
        }

        if (filter.fromDate && filter.toDate) {
          queryBuilder.andWhere('gm.measurementDate BETWEEN :from AND :to', {
            from: filter.fromDate,
            to: filter.toDate,
          });
        } else if (filter.fromDate) {
          queryBuilder.andWhere('gm.measurementDate >= :from', { from: filter.fromDate });
        } else if (filter.toDate) {
          queryBuilder.andWhere('gm.measurementDate <= :to', { to: filter.toDate });
        }

        if (filter.isVerified !== undefined) {
          queryBuilder.andWhere('gm.isVerified = :isVerified', { isVerified: filter.isVerified });
        }

        if (filter.measuredBy) {
          queryBuilder.andWhere('gm.measuredBy = :measuredBy', { measuredBy: filter.measuredBy });
        }
      }

      // Sıralama
      const validSortFields = ['measurementDate', 'averageWeight', 'weightCV', 'performance', 'createdAt'];
      const sortField = validSortFields.includes(sortBy) ? sortBy : 'measurementDate';
      const validSortOrders: readonly string[] = ['ASC', 'DESC'];
      const safeSortOrder = validSortOrders.includes(sortOrder?.toUpperCase() ?? '')
        ? (sortOrder.toUpperCase() as 'ASC' | 'DESC')
        : 'DESC';
      queryBuilder.orderBy(`gm.${sortField}`, safeSortOrder);

      // Sayım
      const count = await queryBuilder.getCount();

      // Pagination
      const offset = (page - 1) * limit;
      queryBuilder.skip(offset).take(limit);

      const rows = await queryBuilder.getMany();

      return [rows, count] as [GrowthMeasurement[], number];
    });

    return createPaginatedQueryResult(measurements, page, limit, total);
  }
}
