import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { IQueryHandler, QueryHandler } from '@platform/cqrs';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { GetFarmQuery } from '../queries/get-farm.query';
import { Farm } from '../entities/farm.entity';

/**
 * Get Farm Query Handler
 * Handles retrieval of a single farm by ID
 */
@Injectable()
@QueryHandler(GetFarmQuery)
export class GetFarmQueryHandler
  implements IQueryHandler<GetFarmQuery, Farm>
{
  private readonly logger = new Logger(GetFarmQueryHandler.name);

  constructor(
    @InjectRepository(Farm)
    private readonly farmRepository: Repository<Farm>,
  ) {}

  async execute(query: GetFarmQuery): Promise<Farm> {
    this.logger.debug(`Getting farm ${query.farmId} for tenant ${query.tenantId}`);

    const relations: string[] = [];

    if (query.includePonds) {
      relations.push('ponds');
    }

    if (query.includeBatches) {
      relations.push('ponds.batches');
    }

    const farm = await this.farmRepository.findOne({
      where: {
        id: query.farmId,
        tenantId: query.tenantId,
      },
      relations,
    });

    if (!farm) {
      throw new NotFoundException(`Farm with ID ${query.farmId} not found`);
    }

    return farm;
  }
}
