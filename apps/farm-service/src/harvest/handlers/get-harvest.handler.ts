/**
 * GetHarvestHandler
 *
 * Handles the GetHarvestQuery to retrieve a single harvest record by ID.
 *
 * @module Harvest/Handlers
 */
import { runInTenantRead } from '@aquaculture/backend-common/database';
import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { QueryHandler, IQueryHandler } from '@platform/cqrs';
import { GetHarvestQuery } from '../queries/get-harvest.query';
import { HarvestRecord } from '../entities/harvest-record.entity';

@Injectable()
@QueryHandler(GetHarvestQuery)
export class GetHarvestHandler implements IQueryHandler<GetHarvestQuery, HarvestRecord | null> {
  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {}

  async execute(query: GetHarvestQuery): Promise<HarvestRecord | null> {
    const { tenantId, harvestRecordId } = query;

    // Read through the fail-closed tenant boundary.
    return runInTenantRead(this.dataSource, 'farm', tenantId, async (queryRunner) => {
      const harvestRecord = await queryRunner.manager.findOne(HarvestRecord, {
        where: { id: harvestRecordId, tenantId },
      });

      return harvestRecord || null;
    });
  }
}
