/**
 * GetGrowthMeasurementsHandler
 *
 * GetGrowthMeasurementsQuery'yi işler ve ölçümleri döner.
 *
 * @module Growth/QueryHandlers
 */
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { QueryHandler, IQueryHandler, PaginatedQueryResult, createPaginatedQueryResult } from '@platform/cqrs';
import { GetGrowthMeasurementsQuery } from '../queries/get-growth-measurements.query';
import { GrowthMeasurement } from '../entities/growth-measurement.entity';

@Injectable()
@QueryHandler(GetGrowthMeasurementsQuery)
export class GetGrowthMeasurementsHandler implements IQueryHandler<GetGrowthMeasurementsQuery, PaginatedQueryResult<GrowthMeasurement>> {
  constructor(
    @InjectRepository(GrowthMeasurement)
    private readonly measurementRepository: Repository<GrowthMeasurement>,
  ) {}

  async execute(query: GetGrowthMeasurementsQuery): Promise<PaginatedQueryResult<GrowthMeasurement>> {
    const { tenantId, filter, page, limit, sortBy, sortOrder } = query;

    const queryBuilder = this.measurementRepository
      .createQueryBuilder('gm')
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
    queryBuilder.orderBy(`gm.${sortField}`, sortOrder);

    // Sayım
    const total = await queryBuilder.getCount();

    // Pagination
    const offset = (page - 1) * limit;
    queryBuilder.skip(offset).take(limit);

    const measurements = await queryBuilder.getMany();

    return createPaginatedQueryResult(measurements, page, limit, total);
  }
}
