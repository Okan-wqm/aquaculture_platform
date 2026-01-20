import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { IQueryHandler, QueryHandler } from '@platform/cqrs';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { GetPondQuery } from '../queries/get-pond.query';
import { Pond } from '../entities/pond.entity';

/**
 * Get Pond Query Handler
 * Handles retrieval of a single pond by ID
 */
@Injectable()
@QueryHandler(GetPondQuery)
export class GetPondQueryHandler implements IQueryHandler<GetPondQuery, Pond> {
  private readonly logger = new Logger(GetPondQueryHandler.name);

  constructor(
    @InjectRepository(Pond)
    private readonly pondRepository: Repository<Pond>,
  ) {}

  async execute(query: GetPondQuery): Promise<Pond> {
    this.logger.debug(
      `Getting pond ${query.pondId} for tenant ${query.tenantId}`,
    );

    const relations: string[] = [];

    if (query.includeBatches) {
      relations.push('batches');
    }

    if (query.includeFarm) {
      relations.push('farm');
    }

    const pond = await this.pondRepository.findOne({
      where: {
        id: query.pondId,
        tenantId: query.tenantId,
      },
      relations,
    });

    if (!pond) {
      throw new NotFoundException(`Pond with ID ${query.pondId} not found`);
    }

    return pond;
  }
}
