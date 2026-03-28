/**
 * TraceLotHandler
 *
 * Executes the TraceLotQuery by retrieving all stock movements associated
 * with a specific lot number. Returns movements ordered by performedAt ASC
 * to provide a chronological audit trail from receipt to consumption.
 *
 * This is the core query for regulatory traceability:
 * - Auditors can trace a lot from supplier delivery (IN) through storage
 *   transfers (TRANSFER) to final consumption (OUT via feeding) or waste (WASTE).
 * - Response time should be <200ms for typical lot histories (<100 movements)
 *   thanks to the composite index on (tenantId, lot_number).
 *
 * Performance note: The query uses a simple WHERE + ORDER BY which leverages
 * the existing indexes on stock_movements. For tenants with >10K movements
 * per lot (unlikely in aquaculture), pagination should be added.
 */
import { QueryHandler, IQueryHandler } from '@platform/cqrs';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { TraceLotQuery } from '../queries/trace-lot.query';
import { StockMovement } from '../entities/stock-movement.entity';

@QueryHandler(TraceLotQuery)
export class TraceLotHandler implements IQueryHandler<TraceLotQuery> {
  constructor(
    @InjectRepository(StockMovement)
    private readonly movementRepository: Repository<StockMovement>,
  ) {}

  async execute(query: TraceLotQuery): Promise<StockMovement[]> {
    const { lotNumber, tenantId } = query;

    // Retrieve all movements for this lot, ordered chronologically.
    // This gives a complete lifecycle view: IN (delivery) -> TRANSFER -> OUT (feeding/usage) -> WASTE
    return this.movementRepository.find({
      where: {
        tenantId,
        lotNumber,
      },
      order: {
        performedAt: 'ASC',
      },
    });
  }
}
