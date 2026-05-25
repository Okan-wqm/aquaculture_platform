import type { QueryRunner } from 'typeorm';

import { CreateFarmStockReadModel1800400000000 } from '../1800400000000-CreateFarmStockReadModel';
import { AssertFarmStockBatchSnapshotMetadata1800500000000 } from '../1800500000000-AssertFarmStockBatchSnapshotMetadata';

describe('AssertFarmStockBatchSnapshotMetadata1800500000000', () => {
  let queryRunner: QueryRunner;
  let query: jest.Mock;
  let repair: jest.SpyInstance;

  beforeEach(() => {
    query = jest.fn();
    queryRunner = { query } as unknown as QueryRunner;
    repair = jest
      .spyOn(CreateFarmStockReadModel1800400000000.prototype, 'up')
      .mockResolvedValue(undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('delegates to the read-model DDL owner when the contract tables are absent', async () => {
    query
      .mockResolvedValueOnce([{ complete: false }])
      .mockResolvedValueOnce(undefined);

    await new AssertFarmStockBatchSnapshotMetadata1800500000000().up(queryRunner);

    expect(repair).toHaveBeenCalledWith(queryRunner);
    expect(query).toHaveBeenLastCalledWith(
      expect.stringContaining('ADD COLUMN IF NOT EXISTS "batchNumber" VARCHAR(50) NULL'),
    );
  });

  it('does not re-run the owner migration when the read model is already present', async () => {
    query
      .mockResolvedValueOnce([{ complete: true }])
      .mockResolvedValueOnce(undefined);

    await new AssertFarmStockBatchSnapshotMetadata1800500000000().up(queryRunner);

    expect(repair).not.toHaveBeenCalled();
    expect(query).toHaveBeenCalledTimes(2);
  });
});
