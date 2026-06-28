/**
 * GetFeedInventoryHandler
 *
 * GetFeedInventoryQuery'yi işler ve stok bilgilerini döner.
 *
 * @module Feeding/QueryHandlers
 */
import { runInTenantRead } from '@aquaculture/backend-common/database';
import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { QueryHandler, IQueryHandler } from '@platform/cqrs';
import { PaginatedQueryResult, createPaginatedQueryResult } from '@platform/cqrs';
import { GetFeedInventoryQuery } from '../queries/get-feed-inventory.query';
import { FeedInventory, InventoryStatus } from '../entities/feed-inventory.entity';

@Injectable()
@QueryHandler(GetFeedInventoryQuery)
export class GetFeedInventoryHandler implements IQueryHandler<GetFeedInventoryQuery, PaginatedQueryResult<FeedInventory>> {
  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {}

  async execute(query: GetFeedInventoryQuery): Promise<PaginatedQueryResult<FeedInventory>> {
    const { tenantId, filter, page, limit, sortBy, sortOrder } = query;

    // Read through the fail-closed tenant boundary.
    const [inventory, total] = await runInTenantRead(this.dataSource, 'farm', tenantId, async (queryRunner) => {
    const queryBuilder = queryRunner.manager
      .createQueryBuilder(FeedInventory, 'inv')
      .leftJoinAndSelect('inv.feed', 'feed')
      .leftJoinAndSelect('inv.site', 'site')
      .leftJoinAndSelect('inv.department', 'department')
      .where('inv.tenantId = :tenantId', { tenantId });

    // Filtreler
    if (filter) {
      if (filter.feedId) {
        queryBuilder.andWhere('inv.feedId = :feedId', { feedId: filter.feedId });
      }

      if (filter.siteId) {
        queryBuilder.andWhere('inv.siteId = :siteId', { siteId: filter.siteId });
      }

      if (filter.departmentId) {
        queryBuilder.andWhere('inv.departmentId = :departmentId', {
          departmentId: filter.departmentId,
        });
      }

      if (filter.status?.length) {
        queryBuilder.andWhere('inv.status IN (:...statuses)', {
          statuses: filter.status,
        });
      }

      if (filter.lowStockOnly) {
        queryBuilder.andWhere('inv.status IN (:...lowStatuses)', {
          lowStatuses: [InventoryStatus.LOW_STOCK, InventoryStatus.OUT_OF_STOCK],
        });
      }

      if (filter.expiringWithinDays !== undefined) {
        const expiryDate = new Date();
        expiryDate.setDate(expiryDate.getDate() + filter.expiringWithinDays);
        queryBuilder.andWhere('inv.expiryDate <= :expiryDate', { expiryDate });
        queryBuilder.andWhere('inv.expiryDate >= :today', { today: new Date() });
      }
    }

    // Sıralama
    const validSortFields = ['quantityKg', 'expiryDate', 'status', 'createdAt'];
    const sortField = validSortFields.includes(sortBy) ? sortBy : 'quantityKg';
    queryBuilder.orderBy(`inv.${sortField}`, sortOrder);

    // Sayım
    const count = await queryBuilder.getCount();

    // Pagination
    const offset = (page - 1) * limit;
    queryBuilder.skip(offset).take(limit);

    const rows = await queryBuilder.getMany();

      return [rows, count] as [FeedInventory[], number];
    });

    return createPaginatedQueryResult(inventory, page, limit, total);
  }
}
