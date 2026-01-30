/**
 * ListHarvestsHandler
 *
 * Handles the ListHarvestsQuery to retrieve harvest records with filtering and pagination.
 *
 * @module Harvest/Handlers
 */
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, SelectQueryBuilder, Brackets } from 'typeorm';
import { QueryHandler, IQueryHandler } from '@platform/cqrs';
import { ListHarvestsQuery } from '../queries/list-harvests.query';
import { HarvestRecord } from '../entities/harvest-record.entity';

export interface PaginatedHarvestRecords {
  items: HarvestRecord[];
  total: number;
  page: number;
  limit: number;
  hasMore: boolean;
}

@Injectable()
@QueryHandler(ListHarvestsQuery)
export class ListHarvestsHandler implements IQueryHandler<ListHarvestsQuery, PaginatedHarvestRecords> {
  constructor(
    @InjectRepository(HarvestRecord)
    private readonly harvestRepository: Repository<HarvestRecord>,
  ) {}

  async execute(query: ListHarvestsQuery): Promise<PaginatedHarvestRecords> {
    const { tenantId, filter, pagination } = query;

    const page = pagination?.page ?? 1;
    const limit = pagination?.limit ?? 20;
    const sortBy = pagination?.sortBy ?? 'harvestDate';
    const sortOrder = pagination?.sortOrder ?? 'DESC';
    const offset = (page - 1) * limit;

    // Build query
    const qb: SelectQueryBuilder<HarvestRecord> = this.harvestRepository
      .createQueryBuilder('harvest')
      .where('harvest.tenantId = :tenantId', { tenantId });

    // Apply filters
    if (filter) {
      if (filter.batchId) {
        qb.andWhere('harvest.batchId = :batchId', { batchId: filter.batchId });
      }

      if (filter.tankId) {
        qb.andWhere('harvest.tankId = :tankId', { tankId: filter.tankId });
      }

      if (filter.status) {
        qb.andWhere('harvest.status = :status', { status: filter.status });
      }

      if (filter.qualityGrade) {
        qb.andWhere('harvest.qualityGrade = :qualityGrade', { qualityGrade: filter.qualityGrade });
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

      if (filter.minBiomass !== undefined) {
        qb.andWhere('harvest.totalBiomass >= :minBiomass', { minBiomass: filter.minBiomass });
      }

      if (filter.maxBiomass !== undefined) {
        qb.andWhere('harvest.totalBiomass <= :maxBiomass', { maxBiomass: filter.maxBiomass });
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
    const total = await qb.getCount();

    // Apply pagination and sorting
    const validSortFields = ['harvestDate', 'createdAt', 'recordCode', 'lotNumber', 'totalBiomass', 'quantityHarvested', 'averageWeight', 'status'];
    const safeSortBy = validSortFields.includes(sortBy) ? sortBy : 'harvestDate';

    qb.orderBy(`harvest.${safeSortBy}`, sortOrder)
      .skip(offset)
      .take(limit);

    const items = await qb.getMany();

    return {
      items,
      total,
      page,
      limit,
      hasMore: offset + items.length < total,
    };
  }
}
