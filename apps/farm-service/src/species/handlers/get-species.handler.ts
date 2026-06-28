/**
 * Get Species Query Handler
 * @module Species/Handlers
 */
import { runInTenantRead } from '@aquaculture/backend-common/database';
import { QueryHandler, IQueryHandler } from '@platform/cqrs';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { NotFoundException } from '@nestjs/common';
import { GetSpeciesQuery } from '../queries/get-species.query';
import { Species } from '../entities/species.entity';

@QueryHandler(GetSpeciesQuery)
export class GetSpeciesHandler
  implements IQueryHandler<GetSpeciesQuery, Species>
{
  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {}

  async execute(query: GetSpeciesQuery): Promise<Species> {
    const { tenantId, id } = query;

    // Read through the fail-closed tenant boundary.
    return runInTenantRead(this.dataSource, 'farm', tenantId, async (queryRunner) => {
      const species = await queryRunner.manager.findOne(Species, {
        where: { id, tenantId },
      });

      if (!species) {
        throw new NotFoundException(`Species with id "${id}" not found`);
      }

      return species;
    });
  }
}
