import { runInSourceRead, runInTenantRead } from '@aquaculture/backend-common/database';
import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { QueryHandler, IQueryHandler } from '@platform/cqrs';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { GetFarmQuery } from '../queries/get-farm.query';
import { Farm } from '../entities/farm.entity';

/**
 * Get Farm Query Handler
 * Handles retrieval of a single farm by ID.
 *
 * Two read paths:
 *  - tenant-scoped request (tenantId present) → fail-closed `runInTenantRead`,
 *  - federation `__resolveReference` (no tenantId) → sanctioned `runInSourceRead`
 *    (cross-tenant by design, security enforced at the gateway).
 */
@Injectable()
@QueryHandler(GetFarmQuery)
export class GetFarmQueryHandler
  implements IQueryHandler<GetFarmQuery, Farm>
{
  private readonly logger = new Logger(GetFarmQueryHandler.name);

  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {}

  async execute(query: GetFarmQuery): Promise<Farm> {
    const { farmId, tenantId } = query;
    this.logger.debug(`Getting farm ${farmId} for tenant ${tenantId || '(federation lookup)'}`);

    const relations: string[] = [];
    if (query.includePonds) {
      relations.push('ponds');
    }
    if (query.includeBatches) {
      relations.push('ponds.batches');
    }

    // Federation __resolveReference arrives with no tenant context and is
    // cross-tenant by design. Route it through the sanctioned source-read API
    // rather than the tenant boundary, which would reject the missing context.
    if (!tenantId) {
      return runInSourceRead(this.dataSource, 'farm', async (queryRunner) => {
        const farm = await queryRunner.manager.findOne(Farm, {
          where: { id: farmId },
          relations,
        });
        if (!farm) {
          throw new NotFoundException(`Farm with ID ${farmId} not found`);
        }
        return farm;
      });
    }

    return runInTenantRead(this.dataSource, 'farm', tenantId, async (queryRunner) => {
      const farm = await queryRunner.manager.findOne(Farm, {
        where: { id: farmId, tenantId },
        relations,
      });
      if (!farm) {
        throw new NotFoundException(`Farm with ID ${farmId} not found`);
      }
      return farm;
    });
  }
}
