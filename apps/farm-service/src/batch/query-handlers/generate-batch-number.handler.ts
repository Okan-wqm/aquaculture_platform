/**
 * GenerateBatchNumberHandler
 *
 * Generates the next sequential batch number for a tenant.
 * Format: B-YYYY-NNNNN (e.g., B-2024-00001)
 *
 * @module Batch/QueryHandlers
 */
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { QueryHandler, IQueryHandler } from '@platform/cqrs';
import { GenerateBatchNumberQuery } from '../queries/generate-batch-number.query';
import { Batch } from '../entities/batch.entity';

@Injectable()
@QueryHandler(GenerateBatchNumberQuery)
export class GenerateBatchNumberHandler implements IQueryHandler<GenerateBatchNumberQuery, string> {
  constructor(
    @InjectRepository(Batch)
    private readonly batchRepository: Repository<Batch>,
  ) {}

  async execute(query: GenerateBatchNumberQuery): Promise<string> {
    const { tenantId } = query;
    const currentYear = new Date().getFullYear();
    const prefix = `B-${currentYear}-`;

    // Find the highest batch number for this year
    const result = await this.batchRepository
      .createQueryBuilder('batch')
      .select('batch.batchNumber')
      .where('batch.tenantId = :tenantId', { tenantId })
      .andWhere('batch.batchNumber LIKE :prefix', { prefix: `${prefix}%` })
      .orderBy('batch.batchNumber', 'DESC')
      .limit(1)
      .getOne();

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
