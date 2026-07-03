/**
 * Get Species By Code Query Handler
 * @module Species/Handlers
 */
import { runInTenantRead } from '@aquaculture/backend-common/database';
import { QueryHandler, IQueryHandler } from '@platform/cqrs';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { NotFoundException } from '@nestjs/common';
import { GetSpeciesByCodeQuery } from '../queries/get-species-by-code.query';
import { Species } from '../entities/species.entity';

@QueryHandler(GetSpeciesByCodeQuery)
export class GetSpeciesByCodeHandler
  implements IQueryHandler<GetSpeciesByCodeQuery, Species>
{
  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {}

  async execute(query: GetSpeciesByCodeQuery): Promise<Species> {
    const { tenantId, code } = query;

    // Read through the fail-closed tenant boundary.
    return runInTenantRead(this.dataSource, 'farm', tenantId, async (queryRunner) => {
      const species = await queryRunner.manager.findOne(Species, {
        where: { tenantId, code: code.toUpperCase() },
      });

      if (!species) {
        throw new NotFoundException(`Species with code "${code}" not found`);
      }

      return species;
    });
  }
}
