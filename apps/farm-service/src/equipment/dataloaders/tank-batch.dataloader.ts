/**
 * TankBatch DataLoader
 *
 * Batches tank_batches lookups by tankId into a single IN query.
 * Reduces N queries to 1 per GraphQL request tick.
 */
import DataLoader from 'dataloader';
import { Repository } from 'typeorm';
import { TankBatchRow } from '../../common/types/graphql-context.types';

export function createTankBatchLoader(
  repo: Repository<any>,
  tenantId: string,
  schema: string,
): DataLoader<string, TankBatchRow | null> {
  const batchFn = async (tankIds: readonly string[]): Promise<(TankBatchRow | null)[]> => {
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
  };

  return new DataLoader(batchFn, { maxBatchSize: 100 });
}
