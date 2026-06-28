import { runInTenantRead } from '@aquaculture/backend-common/database';
import { QueryHandler, IQueryHandler } from '@platform/cqrs';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { NotFoundException } from '@nestjs/common';
import { GetConsumableQuery } from '../queries/get-consumable.query';
import { Consumable } from '../entities/consumable.entity';

@QueryHandler(GetConsumableQuery)
export class GetConsumableHandler implements IQueryHandler<GetConsumableQuery> {
  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {}

  async execute(query: GetConsumableQuery): Promise<Consumable> {
    const { consumableId, tenantId } = query;

    // Read through the fail-closed tenant boundary.
    return runInTenantRead(this.dataSource, 'farm', tenantId, async (queryRunner) => {
      const consumable = await queryRunner.manager.findOne(Consumable, {
        where: { id: consumableId, tenantId },
      });

      if (!consumable) {
        throw new NotFoundException(`Consumable with ID "${consumableId}" not found`);
      }

      return consumable;
    });
  }
}
