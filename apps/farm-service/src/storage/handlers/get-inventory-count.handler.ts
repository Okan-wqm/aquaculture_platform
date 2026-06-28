/**
 * GetInventoryCount Query Handler
 *
 * Returns a single inventory count by ID with all items eager-loaded.
 * Used by the count detail view to display items, variance, and status.
 */
import { runInTenantRead } from '@aquaculture/backend-common/database';
import { QueryHandler, IQueryHandler } from '@platform/cqrs';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { NotFoundException } from '@nestjs/common';
import { GetInventoryCountQuery } from '../queries/get-inventory-count.query';
import { InventoryCount } from '../entities/inventory-count.entity';

@QueryHandler(GetInventoryCountQuery)
export class GetInventoryCountHandler implements IQueryHandler<GetInventoryCountQuery> {
  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {}

  async execute(query: GetInventoryCountQuery): Promise<InventoryCount> {
    // Read through the fail-closed tenant boundary.
    return runInTenantRead(this.dataSource, 'farm', query.tenantId, async (queryRunner) => {
      const count = await queryRunner.manager.findOne(InventoryCount, {
        where: { id: query.id, tenantId: query.tenantId },
        relations: ['items'],
      });

      if (!count) {
        throw new NotFoundException(`Inventory count "${query.id}" not found`);
      }

      return count;
    });
  }
}
