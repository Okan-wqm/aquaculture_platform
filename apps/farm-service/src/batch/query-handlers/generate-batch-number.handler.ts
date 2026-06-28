/**
 * GenerateBatchNumberHandler
 *
 * Generates the next sequential batch number for a tenant.
 * Format: B-YYYY-NNNNN (e.g., B-2024-00001)
 *
 * @module Batch/QueryHandlers
 */
import { runInTenantRead } from '@aquaculture/backend-common/database';
import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { QueryHandler, IQueryHandler } from '@platform/cqrs';
import { DataSource } from 'typeorm';

import { Batch } from '../entities/batch.entity';
import { GenerateBatchNumberQuery } from '../queries/generate-batch-number.query';

@Injectable()
@QueryHandler(GenerateBatchNumberQuery)
export class GenerateBatchNumberHandler implements IQueryHandler<GenerateBatchNumberQuery, string> {
  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {}

  async execute(query: GenerateBatchNumberQuery): Promise<string> {
    const { tenantId } = query;
    const currentYear = new Date().getFullYear();
    const prefix = `B-${currentYear}-`;

    // Find the highest batch number for this year through the tenant boundary.
    const result = await runInTenantRead(this.dataSource, 'farm', tenantId, (queryRunner) =>
      queryRunner.manager
        .createQueryBuilder(Batch, 'batch')
        .select('batch.batchNumber')
        .where('batch.tenantId = :tenantId', { tenantId })
        .andWhere('batch.batchNumber LIKE :prefix', { prefix: `${prefix}%` })
        .orderBy('batch.batchNumber', 'DESC')
        .limit(1)
        .getOne(),
    );

    let nextNumber = 1;

    if (result?.batchNumber) {
      // Extract the number part from the batch number (e.g., "B-2024-00012" -> 12)
      const match = result.batchNumber.match(/B-\d{4}-(\d+)/);
      if (match && match[1]) {
        nextNumber = parseInt(match[1], 10) + 1;
      }
    }

    // Format with leading zeros (5 digits)
    const formattedNumber = nextNumber.toString().padStart(5, '0');

    return `${prefix}${formattedNumber}`;
  }
}
