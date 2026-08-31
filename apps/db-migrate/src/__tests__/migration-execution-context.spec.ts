import { createMockDataSource } from '@aquaculture/testing';

import {
  MIGRATION_DIRECTION_GUC,
  MIGRATION_NAME_GUC,
  setMigrationExecutionContext,
} from '../migration-orchestrator';

describe('setMigrationExecutionContext', () => {
  it('sets exact name and direction as transaction-local GUCs', async () => {
    const { mockQueryRunner } = createMockDataSource();
    const queryMock = jest.fn();
    mockQueryRunner.query = queryMock;
    Object.defineProperty(mockQueryRunner, 'isTransactionActive', { value: true });

    await setMigrationExecutionContext(
      mockQueryRunner,
      'BackfillExecutionsToFeedingRecords1806600000000',
      'down',
    );

    expect(queryMock).toHaveBeenCalledWith(
      `SELECT pg_catalog.set_config($1, $2, true), pg_catalog.set_config($3, $4, true)`,
      [
        MIGRATION_NAME_GUC,
        'BackfillExecutionsToFeedingRecords1806600000000',
        MIGRATION_DIRECTION_GUC,
        'down',
      ],
    );
  });

  it('refuses a context that could escape an outer migration transaction', async () => {
    const { mockQueryRunner } = createMockDataSource();
    const queryMock = jest.fn();
    mockQueryRunner.query = queryMock;
    Object.defineProperty(mockQueryRunner, 'isTransactionActive', { value: false });

    await expect(
      setMigrationExecutionContext(mockQueryRunner, 'Migration1800000000000', 'up'),
    ).rejects.toThrow(/active transaction/i);
    expect(queryMock).not.toHaveBeenCalled();
  });
});
