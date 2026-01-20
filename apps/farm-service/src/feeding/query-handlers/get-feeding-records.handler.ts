/**
 * GetFeedingRecordsHandler
 *
 * GetFeedingRecordsQuery'yi işler ve yemleme kayıtlarını döner.
 *
 * @module Feeding/QueryHandlers
 */
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { QueryHandler, IQueryHandler, PaginatedQueryResult, createPaginatedQueryResult } from '@platform/cqrs';
import { GetFeedingRecordsQuery } from '../queries/get-feeding-records.query';
import { FeedingRecord } from '../entities/feeding-record.entity';

@Injectable()
@QueryHandler(GetFeedingRecordsQuery)
export class GetFeedingRecordsHandler implements IQueryHandler<GetFeedingRecordsQuery, PaginatedQueryResult<FeedingRecord>> {
  constructor(
    @InjectRepository(FeedingRecord)
    private readonly feedingRecordRepository: Repository<FeedingRecord>,
  ) {}

  async execute(query: GetFeedingRecordsQuery): Promise<PaginatedQueryResult<FeedingRecord>> {
    const { tenantId, filter, page, limit, sortBy, sortOrder } = query;

    const queryBuilder = this.feedingRecordRepository
      .createQueryBuilder('fr')
      .leftJoinAndSelect('fr.batch', 'batch')
      .leftJoinAndSelect('fr.feed', 'feed')
      .leftJoinAndSelect('fr.tank', 'tank')
      .where('fr.tenantId = :tenantId', { tenantId });

    // Filtreler
    if (filter) {
      if (filter.batchId) {
        queryBuilder.andWhere('fr.batchId = :batchId', { batchId: filter.batchId });
      }

      if (filter.tankId) {
        queryBuilder.andWhere('fr.tankId = :tankId', { tankId: filter.tankId });
      }

      if (filter.feedId) {
        queryBuilder.andWhere('fr.feedId = :feedId', { feedId: filter.feedId });
      }

      if (filter.fromDate && filter.toDate) {
        queryBuilder.andWhere('fr.feedingDate BETWEEN :from AND :to', {
          from: filter.fromDate,
          to: filter.toDate,
        });
      } else if (filter.fromDate) {
        queryBuilder.andWhere('fr.feedingDate >= :from', { from: filter.fromDate });
      } else if (filter.toDate) {
        queryBuilder.andWhere('fr.feedingDate <= :to', { to: filter.toDate });
      }

      if (filter.feedingMethod?.length) {
        queryBuilder.andWhere('fr.feedingMethod IN (:...methods)', {
          methods: filter.feedingMethod,
        });
      }

      if (filter.appetite?.length) {
        queryBuilder.andWhere("fr.fishBehavior->>'appetite' IN (:...appetites)", {
          appetites: filter.appetite,
        });
      }

      if (filter.fedBy) {
        queryBuilder.andWhere('fr.fedBy = :fedBy', { fedBy: filter.fedBy });
      }

      if (filter.hasVariance !== undefined) {
        if (filter.hasVariance) {
          queryBuilder.andWhere('fr.variance != 0');
        } else {
          queryBuilder.andWhere('fr.variance = 0');
        }
      }
    }

    // Sıralama
    const validSortFields = ['feedingDate', 'feedingTime', 'actualAmount', 'variance', 'createdAt'];
    const sortField = validSortFields.includes(sortBy) ? sortBy : 'feedingDate';
    queryBuilder.orderBy(`fr.${sortField}`, sortOrder);

    // Sayım
    const total = await queryBuilder.getCount();

    // Pagination
    const offset = (page - 1) * limit;
    queryBuilder.skip(offset).take(limit);

    const records = await queryBuilder.getMany();

    return createPaginatedQueryResult(records, page, limit, total);
  }
}
