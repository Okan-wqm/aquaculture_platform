import { RLS_TENANT_GUC } from '@aquaculture/backend-common/database';
import { DataSource, EntityManager, QueryRunner } from 'typeorm';

import {
  pinRlsTenantScope,
  runInRlsScopedRead,
  runInRlsScopedSnapshotRead,
} from '../rls-scoped-session';

const TENANT_ID = '123e4567-e89b-42d3-a456-426614174000';
const SYSTEM_TENANT_ID = '00000000-0000-0000-0000-000000000000';

type QueryRunnerSurface = Pick<
  QueryRunner,
  | 'connect'
  | 'startTransaction'
  | 'commitTransaction'
  | 'rollbackTransaction'
  | 'release'
  | 'query'
  | 'manager'
>;

function makeHarness() {
  const manager: Pick<EntityManager, 'queryRunner'> = { queryRunner: undefined };
  const queryRunner: QueryRunnerSurface = {
    connect: jest.fn().mockResolvedValue(undefined),
    startTransaction: jest.fn().mockResolvedValue(undefined),
    commitTransaction: jest.fn().mockResolvedValue(undefined),
    rollbackTransaction: jest.fn().mockResolvedValue(undefined),
    release: jest.fn().mockResolvedValue(undefined),
    query: jest.fn().mockResolvedValue([]),
    manager: manager as EntityManager,
  };
  const dataSource: Pick<DataSource, 'createQueryRunner'> = {
    createQueryRunner: jest.fn().mockReturnValue(queryRunner),
  };
  return { queryRunner, dataSource: dataSource as DataSource };
}

describe('pinRlsTenantScope', () => {
  it('sets the tenant GUC transaction-locally', async () => {
    const query = jest.fn().mockResolvedValue([]);

    await pinRlsTenantScope({ query }, TENANT_ID);

    expect(query).toHaveBeenCalledWith(`SELECT set_config($1, $2, true)`, [
      RLS_TENANT_GUC,
      TENANT_ID,
    ]);
  });

  it('rejects a non-uuid tenant id before touching the connection', async () => {
    const query = jest.fn();

    await expect(pinRlsTenantScope({ query }, 'not-a-uuid')).rejects.toThrow(/invalid tenantId/);
    expect(query).not.toHaveBeenCalled();
  });
});

describe('runInRlsScopedRead', () => {
  it('pins a READ ONLY transaction to the tenant scope, runs the work, commits, releases', async () => {
    const { queryRunner, dataSource } = makeHarness();
    const work = jest.fn().mockResolvedValue(['row']);

    const result = await runInRlsScopedRead(dataSource, TENANT_ID, work);

    expect(result).toEqual(['row']);
    expect(queryRunner.startTransaction).toHaveBeenCalledWith('READ COMMITTED');
    expect(queryRunner.query).toHaveBeenNthCalledWith(1, 'SET TRANSACTION READ ONLY');
    expect(queryRunner.query).toHaveBeenNthCalledWith(2, `SELECT set_config($1, $2, true)`, [
      RLS_TENANT_GUC,
      TENANT_ID,
    ]);
    expect(work).toHaveBeenCalledWith(queryRunner.manager);
    expect(queryRunner.commitTransaction).toHaveBeenCalledTimes(1);
    expect(queryRunner.rollbackTransaction).not.toHaveBeenCalled();
    expect(queryRunner.release).toHaveBeenCalledTimes(1);
  });

  it('rolls back and releases when the work fails', async () => {
    const { queryRunner, dataSource } = makeHarness();
    const failure = new Error('boom');

    await expect(
      runInRlsScopedRead(dataSource, TENANT_ID, () => Promise.reject(failure)),
    ).rejects.toBe(failure);

    expect(queryRunner.commitTransaction).not.toHaveBeenCalled();
    expect(queryRunner.rollbackTransaction).toHaveBeenCalledTimes(1);
    expect(queryRunner.release).toHaveBeenCalledTimes(1);
  });

  it('rejects a non-uuid tenant id before opening a connection', async () => {
    const { queryRunner, dataSource } = makeHarness();

    await expect(
      runInRlsScopedRead(dataSource, 'nope', () => Promise.resolve(null)),
    ).rejects.toThrow(/invalid tenantId/);
    expect(queryRunner.connect).not.toHaveBeenCalled();
  });
});

describe('runInRlsScopedSnapshotRead', () => {
  it('reads tenant and fallback scopes inside one read-only repeatable-read snapshot', async () => {
    const { queryRunner, dataSource } = makeHarness();
    const visited: string[] = [];

    const result = await runInRlsScopedSnapshotRead(
      dataSource,
      TENANT_ID,
      async (_manager, pinScope) => {
        visited.push('tenant');
        await pinScope(SYSTEM_TENANT_ID);
        visited.push('system');
        return 'effective';
      },
    );

    expect(result).toBe('effective');
    expect(visited).toEqual(['tenant', 'system']);
    expect(queryRunner.startTransaction).toHaveBeenCalledWith('REPEATABLE READ');
    expect(queryRunner.query).toHaveBeenNthCalledWith(1, 'SET TRANSACTION READ ONLY');
    expect(queryRunner.query).toHaveBeenNthCalledWith(2, `SELECT set_config($1, $2, true)`, [
      RLS_TENANT_GUC,
      TENANT_ID,
    ]);
    expect(queryRunner.query).toHaveBeenNthCalledWith(3, `SELECT set_config($1, $2, true)`, [
      RLS_TENANT_GUC,
      SYSTEM_TENANT_ID,
    ]);
    expect(queryRunner.commitTransaction).toHaveBeenCalledTimes(1);
    expect(queryRunner.release).toHaveBeenCalledTimes(1);
  });

  it('rejects an invalid later scope and rolls back the shared snapshot', async () => {
    const { queryRunner, dataSource } = makeHarness();

    await expect(
      runInRlsScopedSnapshotRead(dataSource, TENANT_ID, async (_manager, pinScope) => {
        await pinScope('invalid-system-scope');
      }),
    ).rejects.toThrow(/invalid tenantId/);

    expect(queryRunner.commitTransaction).not.toHaveBeenCalled();
    expect(queryRunner.rollbackTransaction).toHaveBeenCalledTimes(1);
    expect(queryRunner.release).toHaveBeenCalledTimes(1);
  });
});
