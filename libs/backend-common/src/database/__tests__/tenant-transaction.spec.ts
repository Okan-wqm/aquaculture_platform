import { DataSource } from 'typeorm';

import { TenantContextError } from '../tenant-context-error';
import {
  assertTenantTransactionContext,
  pinTenantTransactionSearchPath,
  runInTenantTransaction,
  TenantContextQueryExecutor,
} from '../tenant-transaction';

describe('tenant transaction helpers', () => {
  const tenantId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const tenantSchema = 'tenant_aaaaaaaaaaaa4aaa';

  /**
   * Build a minimal `Pick<QueryRunner, 'query'>` whose `current_schema()`
   * readback returns `assertRow` (and `undefined` for every other statement).
   * When `assertRow` is undefined the assertion treats it as "no live
   * connection" and skips. Returns both the narrowed runner and the raw mock
   * so tests can assert on the issued SQL without a cast.
   */
  const makeQueryRunner = (
    assertRow?: { schema: string | null; tenant: string | null },
  ): { runner: TenantContextQueryExecutor; query: jest.Mock } => {
    const query = jest.fn((sql: string) =>
      sql.includes('current_schema()')
        ? Promise.resolve(assertRow ? [assertRow] : undefined)
        : Promise.resolve(undefined),
    );
    return { runner: { query }, query };
  };

  it('pins transaction-local search_path to tenant schema before work runs', async () => {
    const queryRunner = {
      connect: jest.fn().mockResolvedValue(undefined),
      startTransaction: jest.fn().mockResolvedValue(undefined),
      query: jest.fn().mockResolvedValue(undefined),
      commitTransaction: jest.fn().mockResolvedValue(undefined),
      rollbackTransaction: jest.fn().mockResolvedValue(undefined),
      release: jest.fn().mockResolvedValue(undefined),
    };
    const dataSource = {
      createQueryRunner: jest.fn().mockReturnValue(queryRunner),
    } as unknown as DataSource;
    const work = jest.fn().mockResolvedValue('ok');

    await expect(
      runInTenantTransaction(dataSource, 'messaging', tenantId, work),
    ).resolves.toBe('ok');

    expect(queryRunner.query).toHaveBeenCalledWith(
      `SELECT pg_catalog.set_config('search_path', $1, true)`,
      ['"tenant_aaaaaaaaaaaa4aaa", "messaging", public'],
    );
    expect(work).toHaveBeenCalledWith(queryRunner);
    expect(queryRunner.commitTransaction).toHaveBeenCalledTimes(1);
    expect(queryRunner.rollbackTransaction).not.toHaveBeenCalled();
    expect(queryRunner.release).toHaveBeenCalledTimes(1);
  });

  it('rolls back and releases when work fails', async () => {
    const queryRunner = {
      connect: jest.fn().mockResolvedValue(undefined),
      startTransaction: jest.fn().mockResolvedValue(undefined),
      query: jest.fn().mockResolvedValue(undefined),
      commitTransaction: jest.fn().mockResolvedValue(undefined),
      rollbackTransaction: jest.fn().mockResolvedValue(undefined),
      release: jest.fn().mockResolvedValue(undefined),
    };
    const dataSource = {
      createQueryRunner: jest.fn().mockReturnValue(queryRunner),
    } as unknown as DataSource;

    await expect(
      runInTenantTransaction(dataSource, 'messaging', tenantId, async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');

    expect(queryRunner.commitTransaction).not.toHaveBeenCalled();
    expect(queryRunner.rollbackTransaction).toHaveBeenCalledTimes(1);
    expect(queryRunner.release).toHaveBeenCalledTimes(1);
  });

  it('rejects invalid tenant ids before issuing SQL', async () => {
    const queryRunner = {
      query: jest.fn().mockResolvedValue(undefined),
    };

    await expect(
      pinTenantTransactionSearchPath(
        queryRunner as unknown as Parameters<typeof pinTenantTransactionSearchPath>[0],
        'messaging',
        'not-a-uuid',
      ),
    ).rejects.toThrow('invalid tenantId');

    expect(queryRunner.query).not.toHaveBeenCalled();
  });

  describe('assertTenantTransactionContext', () => {
    it('sets the RLS GUC transaction-locally and passes when schema + tenant match', async () => {
      const { runner, query } = makeQueryRunner({ schema: tenantSchema, tenant: tenantId });

      await expect(
        assertTenantTransactionContext(runner, 'farm', tenantId),
      ).resolves.toBeUndefined();

      expect(query).toHaveBeenCalledWith(`SELECT set_config($1, $2, true)`, [
        'app.current_tenant',
        tenantId,
      ]);
    });

    it('throws SCHEMA_MISMATCH when current_schema fell back to the source schema', async () => {
      const { runner } = makeQueryRunner({ schema: 'farm', tenant: tenantId });

      await expect(
        assertTenantTransactionContext(runner, 'farm', tenantId),
      ).rejects.toMatchObject({ state: 'SCHEMA_MISMATCH', resolvedSchema: 'farm' });
    });

    it('throws RLS_MISMATCH (TenantContextError) when the RLS GUC resolves empty', async () => {
      const { runner } = makeQueryRunner({ schema: tenantSchema, tenant: '' });

      await expect(
        assertTenantTransactionContext(runner, 'farm', tenantId),
      ).rejects.toBeInstanceOf(TenantContextError);
    });

    it('skips assertion (no live connection) when readback returns no row', async () => {
      const { runner } = makeQueryRunner(undefined);

      await expect(
        assertTenantTransactionContext(runner, 'farm', tenantId),
      ).resolves.toBeUndefined();
    });
  });
});
