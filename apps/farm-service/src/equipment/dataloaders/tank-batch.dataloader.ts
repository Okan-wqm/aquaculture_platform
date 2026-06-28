/**
 * TankBatch DataLoader
 *
 * Batches tank_batches lookups by tankId into a single IN query.
 * Reduces N queries to 1 per GraphQL request tick.
 *
 * Tenant scoping is structural: the batch function only ever runs with a
 * tenantId the factory resolved fail-closed from the request context, so the
 * `WHERE "tenantId" = $1` clause can never be issued tenant-blind. The schema is
 * derived from that same verified tenantId.
 */
import DataLoader from 'dataloader';
import { Repository } from 'typeorm';
import { createTenantScopedDataLoader } from '@aquaculture/backend-common/dataloader';
import { getTenantSchemaName } from '@aquaculture/backend-common/database';
import { TankBatchRow } from '../../common/types/graphql-context.types';

export function createTankBatchLoader(
  repo: Repository<unknown>,
): DataLoader<string, TankBatchRow | null> {
  return createTenantScopedDataLoader<string, TankBatchRow | null>(
    async (tenantId: string, tankIds: readonly string[]): Promise<(TankBatchRow | null)[]> => {
      const schema = getTenantSchemaName(tenantId);
      const rows: TankBatchRow[] = await repo.query(
        `SELECT * FROM "${schema}".tank_batches
         WHERE "tenantId" = $1 AND "tankId" = ANY($2::uuid[])`,
        [tenantId, [...tankIds]],
      );

      const map = new Map<string, TankBatchRow>();
      for (const row of rows) {
        map.set(row.tankId, row);
      }

      return tankIds.map(id => map.get(id) ?? null);
    },
    { batchFnName: 'TankBatchDataLoader', dataLoaderOptions: { maxBatchSize: 100 } },
  );
}
