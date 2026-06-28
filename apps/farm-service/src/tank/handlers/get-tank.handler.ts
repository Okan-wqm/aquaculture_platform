/**
 * Get Tank Query Handler
 * @module Tank/Handlers
 */
import { runInTenantRead } from '@aquaculture/backend-common/database';
import { QueryHandler, IQueryHandler } from '@platform/cqrs';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { NotFoundException } from '@nestjs/common';
import { GetTankQuery } from '../queries/get-tank.query';
import { Tank } from '../entities/tank.entity';

@QueryHandler(GetTankQuery)
export class GetTankHandler implements IQueryHandler<GetTankQuery, Tank> {
  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {}

  async execute(query: GetTankQuery): Promise<Tank> {
    const { tenantId, id } = query;

    // Read through the fail-closed tenant boundary.
    return runInTenantRead(this.dataSource, 'farm', tenantId, async (queryRunner) => {
      const tank = await queryRunner.manager.findOne(Tank, {
        where: { id, tenantId },
        relations: ['department'],
      });

      if (!tank) {
        throw new NotFoundException(`Tank with id "${id}" not found`);
      }

      return tank;
    });
  }
}
