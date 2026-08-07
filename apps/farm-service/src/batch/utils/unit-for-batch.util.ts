/**
 * Which UNIT does a batch-scoped event belong to?
 *
 * WHY: a weighing is an observation OF A TANK — fish are size-graded before
 * stocking, so a tank holds one size class and a sample is representative of
 * the whole unit. But the growth-sample command is BATCH-scoped and its
 * `tankId` is optional, so the tank a measurement re-bases has to be resolved
 * before the measurement can reach the feeding plan at all.
 *
 * The resolution is deliberately FAIL-CLOSED on ambiguity. A batch split across
 * two tanks has two different cohorts with two different weights; applying one
 * tank's sample to both would move fish nobody weighed. Rather than pick a
 * "dominant" unit and silently corrupt the other, the caller is told to name
 * the tank. Guessing here is exactly the class of invented number this phase
 * exists to remove.
 *
 * @module Batch/Utils
 */
import { BadRequestException } from '@nestjs/common';
import type { EntityManager } from 'typeorm';

/**
 * Resolve the unit whose stock a batch-scoped measurement applies to.
 *
 * @param explicitUnitId Unit named by the caller; when present it is authoritative
 *   and returned as-is (the operator weighed a specific tank).
 * @returns The unit id, or `null` when the batch is in no unit at all (e.g. a
 *   pond-held or not-yet-allocated batch) — the caller then records the
 *   measurement without a tank reconciliation.
 * @throws BadRequestException when the batch sits in MORE THAN ONE unit and the
 *   caller did not say which one was sampled.
 */
export async function resolveUnitHoldingBatch(
  manager: EntityManager,
  tenantId: string,
  batchId: string,
  explicitUnitId?: string,
): Promise<string | null> {
  if (explicitUnitId) return explicitUnitId;

  const rows: Array<{ tankId: string }> = await manager.query(
    `SELECT tb."tankId" AS "tankId"
       FROM "tank_batches" tb
      WHERE tb."tenantId" = $1
        AND (
          tb."primaryBatchId" = $2
          OR EXISTS (
            SELECT 1
              FROM jsonb_array_elements(COALESCE(tb."batchDetails", '[]'::jsonb)) AS detail(value)
             WHERE detail.value->>'batchId' = $2
          )
        )
      ORDER BY tb."tankId" ASC`,
    [tenantId, batchId],
  );

  if (rows.length === 0) return null;
  if (rows.length === 1) return rows[0]!.tankId;

  throw new BadRequestException(
    `Batch ${batchId} is stocked in ${rows.length} units ` +
      `(${rows.map((row) => row.tankId).join(', ')}); a sample sizes ONE tank, ` +
      'so the measurement must name the tank it was taken from.',
  );
}
