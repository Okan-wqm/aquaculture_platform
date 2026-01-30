/**
 * GetHarvestHandler
 *
 * Handles the GetHarvestQuery to retrieve a single harvest record by ID.
 *
 * @module Harvest/Handlers
 */
import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { QueryHandler, IQueryHandler } from '@platform/cqrs';
import { GetHarvestQuery } from '../queries/get-harvest.query';
import { HarvestRecord } from '../entities/harvest-record.entity';

@Injectable()
@QueryHandler(GetHarvestQuery)
export class GetHarvestHandler implements IQueryHandler<GetHarvestQuery, HarvestRecord | null> {
  constructor(
    @InjectRepository(HarvestRecord)
    private readonly harvestRepository: Repository<HarvestRecord>,
  ) {}

  async execute(query: GetHarvestQuery): Promise<HarvestRecord | null> {
    const { tenantId, harvestRecordId } = query;

    const harvestRecord = await this.harvestRepository.findOne({
      where: { id: harvestRecordId, tenantId },
    });

    return harvestRecord || null;
  }
}
