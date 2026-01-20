/**
 * Get Species Query Handler
 * @module Species/Handlers
 */
import { QueryHandler, IQueryHandler } from '@platform/cqrs';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { NotFoundException } from '@nestjs/common';
import { GetSpeciesQuery } from '../queries/get-species.query';
import { Species } from '../entities/species.entity';

@QueryHandler(GetSpeciesQuery)
export class GetSpeciesHandler
  implements IQueryHandler<GetSpeciesQuery, Species>
{
  constructor(
    @InjectRepository(Species)
    private readonly speciesRepository: Repository<Species>,
  ) {}

  async execute(query: GetSpeciesQuery): Promise<Species> {
    const { tenantId, id } = query;

    const species = await this.speciesRepository.findOne({
      where: { id, tenantId },
    });

    if (!species) {
      throw new NotFoundException(`Species with id "${id}" not found`);
    }

    return species;
  }
}
