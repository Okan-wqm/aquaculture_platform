/**
 * TraceLotHandler
 *
 * Executes the TraceLotQuery by retrieving all stock movements that
 * carried a specific lot number — including composite MIX identifiers
 * produced when the lot physically converged with another in a shared
 * container. Returns movements ordered by performedAt ASC so the
 * caller receives a chronological audit trail from receipt through
 * transfers, mix events, and final consumption.
 *
 * This is the core query for regulatory traceability:
 *   - Auditors can trace a lot from supplier delivery (IN) through
 *     storage transfers (TRANSFER) and mix events (out of mixed
 *     containers stamped with the composite effectiveLotNumber) to
 *     final consumption (OUT via feeding) or waste (WASTE).
 *   - Mattilsynet + EU 178/2002 require that a mix event never erases
 *     the recall provenance of the contributing lots; the join against
 *     `StorageLotMix` guarantees that.
 *
 * Performance note: the mix resolution is a single JSONB-containment
 * lookup that is well-covered by the `(tenantId, effectiveLotNumber)`
 * index on `storage_lot_mixes`. The subsequent `stock_movements` scan
 * uses `WHERE lot_number IN (...)` with ≤ ~10 distinct values in the
 * common case, so the existing `(tenantId, lot_number)` composite
 * index still serves the query in < 200ms for typical volumes.
 */
import { runInTenantRead } from '@aquaculture/backend-common/database';
import { QueryHandler, IQueryHandler } from '@platform/cqrs';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, In } from 'typeorm';
import { TraceLotQuery } from '../queries/trace-lot.query';
import { StockMovement } from '../entities/stock-movement.entity';
import { LotMixService } from '../services/lot-mix.service';

@QueryHandler(TraceLotQuery)
export class TraceLotHandler implements IQueryHandler<TraceLotQuery> {
  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
    private readonly lotMixService: LotMixService,
  ) {}

  async execute(query: TraceLotQuery): Promise<StockMovement[]> {
    const { lotNumber, tenantId } = query;

    // Read through the fail-closed tenant boundary so both the mix
    // resolution and the movement scan run on the same pinned + asserted
    // tenant connection.
    return runInTenantRead(this.dataSource, 'farm', tenantId, async (queryRunner) => {
      // Every composite lot identifier this lot participated in. When
      // the lot never mixed with another, the set is empty and the
      // caller sees the legacy lot-number-only trace.
      const mixes = await this.lotMixService.findMixesForLot(
        queryRunner.manager,
        tenantId,
        lotNumber,
      );
      const compositeLotNumbers = mixes.map((m) => m.effectiveLotNumber);

      const searchLots = [lotNumber, ...compositeLotNumbers];

      return queryRunner.manager.find(StockMovement, {
        where: {
          tenantId,
          lotNumber: In(searchLots),
        },
        order: {
          performedAt: 'ASC',
        },
      });
    });
  }
}
