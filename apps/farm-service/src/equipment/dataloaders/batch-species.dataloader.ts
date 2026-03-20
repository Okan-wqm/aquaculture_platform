/**
 * BatchSpecies DataLoader
 *
 * Batches batch + species lookups by batchId into a single IN query.
 * Fetches initialQuantity, mortality, FCR, SGR, and species code.
 */
import DataLoader from 'dataloader';
import { Repository } from 'typeorm';
import { BatchSpeciesRow } from '../../common/types/graphql-context.types';

export function createBatchSpeciesLoader(
  repo: Repository<any>,
  tenantId: string,
  schema: string,
): DataLoader<string, BatchSpeciesRow | null> {
  const batchFn = async (batchIds: readonly string[]): Promise<(BatchSpeciesRow | null)[]> => {
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
  };

  return new DataLoader(batchFn, { maxBatchSize: 100 });
}
