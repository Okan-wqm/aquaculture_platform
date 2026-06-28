/**
 * Get Chemical Query Handler
 */
import { runInTenantRead } from '@aquaculture/backend-common/database';
import { QueryHandler, IQueryHandler } from '@platform/cqrs';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { NotFoundException } from '@nestjs/common';
import { GetChemicalQuery } from '../queries/get-chemical.query';
import { Chemical } from '../entities/chemical.entity';

@QueryHandler(GetChemicalQuery)
export class GetChemicalHandler implements IQueryHandler<GetChemicalQuery> {
  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {}

  async execute(query: GetChemicalQuery): Promise<Chemical> {
    const { chemicalId, tenantId } = query;

    // Read through the fail-closed tenant boundary.
    return runInTenantRead(this.dataSource, 'farm', tenantId, async (queryRunner) => {
      const chemical = await queryRunner.manager.findOne(Chemical, {
        where: { id: chemicalId, tenantId },
      });

      if (!chemical) {
        throw new NotFoundException(`Chemical with ID "${chemicalId}" not found`);
      }

      return chemical;
    });
  }
}
