/**
 * GetInventoryCount Query Handler
 *
 * Returns a single inventory count by ID with all items eager-loaded.
 * Used by the count detail view to display items, variance, and status.
 */
import { QueryHandler, IQueryHandler } from '@platform/cqrs';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { NotFoundException } from '@nestjs/common';
import { GetInventoryCountQuery } from '../queries/get-inventory-count.query';
import { InventoryCount } from '../entities/inventory-count.entity';

@QueryHandler(GetInventoryCountQuery)
export class GetInventoryCountHandler implements IQueryHandler<GetInventoryCountQuery> {
  constructor(
    @InjectRepository(InventoryCount)
    private readonly countRepository: Repository<InventoryCount>,
  ) {}

  async execute(query: GetInventoryCountQuery): Promise<InventoryCount> {
    const count = await this.countRepository.findOne({
      where: { id: query.id, tenantId: query.tenantId },
      relations: ['items'],
    });

    if (!count) {
      throw new NotFoundException(`Inventory count "${query.id}" not found`);
    }

    return count;
  }
}
