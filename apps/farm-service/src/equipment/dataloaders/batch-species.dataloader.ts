/**
 * BatchSpecies DataLoader
 *
 * Batches batch + species lookups by batchId into a single IN query.
 * Fetches initialQuantity, mortality, FCR, SGR, and species code.
 *
 * Tenant scoping is structural: the batch function only ever runs with a
 * tenantId the factory resolved fail-closed from the request context, so the
 * `WHERE b."tenantId" = $1` clause can never be issued tenant-blind. The schema
 * is derived from that same verified tenantId.
 */
import DataLoader from 'dataloader';
import { ObjectLiteral, Repository } from 'typeorm';
import { createTenantScopedDataLoader } from '@aquaculture/backend-common/dataloader';
import { getTenantSchemaName } from '@aquaculture/backend-common/database';
import { BatchSpeciesRow } from '../../common/types/graphql-context.types';

export function createBatchSpeciesLoader(
  repo: Repository<ObjectLiteral>,
): DataLoader<string, BatchSpeciesRow | null> {
  return createTenantScopedDataLoader<string, BatchSpeciesRow | null>(
    async (tenantId: string, batchIds: readonly string[]): Promise<(BatchSpeciesRow | null)[]> => {
      const schema = getTenantSchemaName(tenantId);
      const rows: BatchSpeciesRow[] = await repo.query(
        `SELECT
          b."id",
          b."initialQuantity",
          b."totalMortality",
          b."cullCount",
          b."sgr",
          b."fcr",
          s."code" as "speciesCode"
        FROM "${schema}".batches_v2 b
        LEFT JOIN "${schema}".species s ON b."speciesId" = s."id"
        WHERE b."tenantId" = $1 AND b."id" = ANY($2::uuid[])`,
        [tenantId, [...batchIds]],
      );

      const map = new Map<string, BatchSpeciesRow>();
      for (const row of rows) {
        map.set(row.id, row);
      }

      return batchIds.map(id => map.get(id) ?? null);
    },
    { batchFnName: 'BatchSpeciesDataLoader', dataLoaderOptions: { maxBatchSize: 100 } },
  );
}
