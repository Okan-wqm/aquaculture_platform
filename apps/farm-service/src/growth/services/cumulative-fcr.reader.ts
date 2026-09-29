import type { TenantScope } from '@aquaculture/backend-common/database';

import { Batch } from '../../batch/entities/batch.entity';
import { OperationType, TankOperation } from '../../batch/entities/tank-operation.entity';
import { FeedingRecord } from '../../feeding/entities/feeding-record.entity';

/** Cumulative FCR of one batch, from its start to `endDate` (or now). */
export interface CumulativeFcr {
  fcr: number;
  totalFeed: number;
  totalGrowth: number;
  removedBiomassKg: number;
}

const NO_BATCH: CumulativeFcr = { fcr: 0, totalFeed: 0, totalGrowth: 0, removedBiomassKg: 0 };

/**
 * The single cumulative-FCR authority (FARM-HIGH-007), reading through the
 * tenant scope it is handed.
 *
 * WHY a function over a caller-supplied scope: the AI read handlers
 * (get_batch_performance, get_growth_analysis) must read ONLY on their
 * scope's tenant-pinned connection — search_path + RLS GUC pinned and
 * asserted (K10 layer 4, MT-HIGH-062). A service holding its own repositories
 * reads on whatever pooled connection the ambient context hands it. Callers
 * that start from a tenant id (FCRCalculationService.calculateCumulativeFCR)
 * open a scope first, so both paths share this one computation.
 *
 * WHAT: realized growth is corrected with the TankOperation ledger — biomass
 * that left the system via mortality / cull / harvest / transfer-out also grew
 * by consuming feed, so a plain `current − start` difference undercounts it
 * and overstates FCR. Transfer-ins are feed-free biomass entering the batch
 * and are subtracted.
 *
 *   realized growth = (current biomass + net removed biomass) − start
 *   net removed     = Σ(mortality + cull + harvest + transfer_out) − Σ(transfer_in)
 */
export async function readCumulativeFcr(
  scope: TenantScope,
  batchId: string,
  endDate?: Date,
): Promise<CumulativeFcr> {
  const { manager, tenantId } = scope;
  const batch = await manager.findOne(Batch, { where: { id: batchId, tenantId } });
  if (!batch) {
    return NO_BATCH;
  }

  const feedQuery = manager
    .createQueryBuilder(FeedingRecord, 'fr')
    .where('fr.tenantId = :tenantId', { tenantId })
    .andWhere('fr.batchId = :batchId', { batchId });
  if (endDate) {
    feedQuery.andWhere('fr.feedingDate <= :endDate', { endDate });
  }
  const feedResult = await feedQuery
    .select('SUM(fr.actualAmount)', 'totalFeed')
    .getRawOne<{ totalFeed: string | number | null }>();
  const totalFeed = Number(feedResult?.totalFeed || 0);

  // The latest growth measurement is NOT read here: current biomass is the
  // derive-on-read value (batch.getCurrentBiomass), so the stale-prone
  // measurement snapshot does not feed the FCR growth term.

  // Ledger: biomass that LEFT the batch (mortality/cull/harvest/transfer-out)
  // or entered it feed-free (transfer-in). Counting TRANSFER_OUT and
  // TRANSFER_IN together makes within-batch tank moves (same batchId out + in)
  // net to zero naturally. Tenant-filtered (op.tenantId) as defence in depth
  // on top of the tenant search_path routing (ADR-011).
  const ledgerQuery = manager
    .createQueryBuilder(TankOperation, 'op')
    .where('op.tenantId = :tenantId', { tenantId })
    .andWhere('op.batchId = :batchId', { batchId })
    .andWhere('op.isDeleted = false')
    .andWhere('op.operationType IN (:...ledgerTypes)', {
      ledgerTypes: [
        OperationType.MORTALITY,
        OperationType.CULL,
        OperationType.HARVEST,
        OperationType.TRANSFER_OUT,
        OperationType.TRANSFER_IN,
      ],
    });
  if (endDate) {
    ledgerQuery.andWhere('op.operationDate <= :endDate', { endDate });
  }
  const ledgerResult = await ledgerQuery
    .select(
      `COALESCE(SUM(CASE WHEN op.operationType = :transferIn THEN -COALESCE(op.biomassKg, 0) ELSE COALESCE(op.biomassKg, 0) END), 0)`,
      'netRemovedKg',
    )
    .setParameter('transferIn', OperationType.TRANSFER_IN)
    .getRawOne<{ netRemovedKg: string | number | null }>();
  const removedBiomassKg = Number(ledgerResult?.netRemovedKg ?? 0);

  const initialWeight = batch.weight?.initial?.avgWeight || 0;
  const startBiomass = (batch.initialQuantity * initialWeight) / 1000; // kg
  // Current biomass is the single derive-on-read value (currentQuantity ×
  // effectiveAvgWeightG / 1000) — the SAME source the GraphQL resolver and the
  // removal handlers read, so FCR growth and displayed biomass cannot diverge.
  // With no live count yet, fall back to the start biomass.
  const currentBiomass = batch.currentQuantity > 0 ? batch.getCurrentBiomass() : startBiomass;
  // Realized growth includes the growth of biomass that exited the system.
  const totalGrowth = currentBiomass + removedBiomassKg - startBiomass;
  const fcr = totalGrowth > 0 ? totalFeed / totalGrowth : 0;

  return { fcr, totalFeed, totalGrowth, removedBiomassKg };
}
