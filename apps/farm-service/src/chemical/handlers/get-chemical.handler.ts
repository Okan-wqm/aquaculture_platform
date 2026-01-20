/**
 * Get Chemical Query Handler
 */
import { QueryHandler, IQueryHandler } from '@nestjs/cqrs';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { NotFoundException } from '@nestjs/common';
import { GetChemicalQuery } from '../queries/get-chemical.query';
import { Chemical } from '../entities/chemical.entity';

@QueryHandler(GetChemicalQuery)
export class GetChemicalHandler implements IQueryHandler<GetChemicalQuery> {
  constructor(
    @InjectRepository(Chemical)
    private readonly chemicalRepository: Repository<Chemical>,
  ) {}

  async execute(query: GetChemicalQuery): Promise<Chemical> {
    const { chemicalId, tenantId } = query;

    const chemical = await this.chemicalRepository.findOne({
      where: { id: chemicalId, tenantId },
    });

    if (!chemical) {
      throw new NotFoundException(`Chemical with ID "${chemicalId}" not found`);
    }

    return chemical;
  }
}
