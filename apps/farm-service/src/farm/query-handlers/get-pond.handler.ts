import { runInTenantRead } from '@aquaculture/backend-common/database';
import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { QueryHandler, IQueryHandler } from '@platform/cqrs';
import { DataSource } from 'typeorm';

import { Pond } from '../entities/pond.entity';
import { GetPondQuery } from '../queries/get-pond.query';

/**
 * Get Pond Query Handler
 * Handles retrieval of a single pond by ID
 */
@Injectable()
@QueryHandler(GetPondQuery)
export class GetPondQueryHandler implements IQueryHandler<GetPondQuery, Pond> {
  private readonly logger = new Logger(GetPondQueryHandler.name);

  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
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

    // Read through the fail-closed tenant boundary: a lost/wrong tenant context
    // throws TenantContextError instead of silently resolving zero rows, so the
    // NotFoundException below is a genuine 404, not a masked context failure.
    const pond = await runInTenantRead(
      this.dataSource,
      'farm',
      query.tenantId,
      (queryRunner) =>
        queryRunner.manager.findOne(Pond, {
          where: { id: query.pondId, tenantId: query.tenantId },
          relations,
        }),
    );

    if (!pond) {
      throw new NotFoundException(`Pond with ID ${query.pondId} not found`);
    }

    return pond;
  }
}
