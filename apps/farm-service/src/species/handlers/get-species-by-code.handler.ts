/**
 * Get Species By Code Query Handler
 * @module Species/Handlers
 */
import { QueryHandler, IQueryHandler } from '@platform/cqrs';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { NotFoundException } from '@nestjs/common';
import { GetSpeciesByCodeQuery } from '../queries/get-species-by-code.query';
import { Species } from '../entities/species.entity';

@QueryHandler(GetSpeciesByCodeQuery)
export class GetSpeciesByCodeHandler
  implements IQueryHandler<GetSpeciesByCodeQuery, Species>
{
  constructor(
    @InjectRepository(Species)
    private readonly speciesRepository: Repository<Species>,
  ) {}

  async execute(query: GetSpeciesByCodeQuery): Promise<Species> {
    const { tenantId, code } = query;

    const species = await this.speciesRepository.findOne({
      where: { tenantId, code: code.toUpperCase() },
    });

    if (!species) {
      throw new NotFoundException(`Species with code "${code}" not found`);
    }

    return species;
  }
}
