import { Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';

import { TenantContextError } from '../tenant-context-error';
import {
  assertSourceReadContext,
  assertTenantTransactionContext,
  bindTenantTransactionContext,
  pinTenantTransactionSearchPath,
  runInTenantRead,
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
  const makeQueryRunner = (assertRow?: {
    schema: string | null;
    tenant: string | null;
    bypass: string | null;
  }): { runner: TenantContextQueryExecutor; query: jest.Mock } => {
    const query = jest.fn((sql: string) =>
      sql.includes('current_schema()')
        ? Promise.resolve(assertRow ? [assertRow] : undefined)
        : Promise.resolve(undefined),
    );
    return { runner: { query }, query };
  };

  const makeTransactionHarness = (): {
    dataSource: DataSource;
    queryRunner: ReturnType<DataSource['createQueryRunner']>;
  } => {
    const dataSource = new DataSource({
      type: 'postgres',
      database: 'tenant-transaction-unit-test',
      entities: [],
    });
    const queryRunner = dataSource.createQueryRunner();

    jest.spyOn(queryRunner, 'connect').mockResolvedValue(undefined);
    jest.spyOn(queryRunner, 'startTransaction').mockResolvedValue(undefined);
    jest.spyOn(queryRunner, 'query').mockResolvedValue(undefined);
    jest.spyOn(queryRunner, 'commitTransaction').mockResolvedValue(undefined);
    jest.spyOn(queryRunner, 'rollbackTransaction').mockResolvedValue(undefined);
    jest.spyOn(queryRunner, 'release').mockResolvedValue(undefined);
    jest.spyOn(dataSource, 'createQueryRunner').mockReturnValue(queryRunner);

    return { dataSource, queryRunner };
  };

  it('pins transaction-local search_path to tenant schema before work runs', async () => {
    const { dataSource, queryRunner } = makeTransactionHarness();
    const work = jest.fn().mockResolvedValue('ok');

    await expect(runInTenantTransaction(dataSource, 'messaging', tenantId, work)).resolves.toBe(
      'ok',
    );

    expect(queryRunner.query).toHaveBeenCalledWith(expect.stringContaining('set_config'), [
      '"tenant_aaaaaaaaaaaa4aaa", "messaging", public',
      'app.current_tenant',
      tenantId,
      'app.bypass_rls',
    ]);
    expect(work).toHaveBeenCalledWith(queryRunner);
    expect(queryRunner.commitTransaction).toHaveBeenCalledTimes(1);
    expect(queryRunner.rollbackTransaction).not.toHaveBeenCalled();
    expect(queryRunner.release).toHaveBeenCalledTimes(1);
  });

  // Every statement is a network round trip plus driver/ORM CPU on a hot path
  // shared by all tenant-scoped services. The binding (search_path pin, RLS GUCs
  // and their read-back) must therefore cost exactly one round trip.
  it('spends exactly one round trip binding the tenant before the work runs', async () => {
    const { dataSource, queryRunner } = makeTransactionHarness();
    let statementsBeforeWork = -1;

    await runInTenantTransaction(dataSource, 'messaging', tenantId, () => {
      statementsBeforeWork = (queryRunner.query as jest.Mock).mock.calls.length;
      return Promise.resolve('ok');
    });

    expect(statementsBeforeWork).toBe(1);
  });

  it('runs the read-only boundary with one binding round trip after SET TRANSACTION READ ONLY', async () => {
    const { dataSource, queryRunner } = makeTransactionHarness();
    const issued: string[] = [];
    jest.spyOn(queryRunner, 'query').mockImplementation((sql: string) => {
      issued.push(sql);
      return Promise.resolve(undefined);
    });

    await runInTenantRead(dataSource, 'messaging', tenantId, () => Promise.resolve('ok'));

    expect(issued).toHaveLength(2);
    expect(issued[0]).toBe('SET TRANSACTION READ ONLY');
    expect(issued[1]).toContain('current_schema()');
  });

  it('rolls back and releases when work fails', async () => {
    const { dataSource, queryRunner } = makeTransactionHarness();

    await expect(
      runInTenantTransaction(dataSource, 'messaging', tenantId, () =>
        Promise.reject(new Error('boom')),
      ),
    ).rejects.toThrow('boom');

    expect(queryRunner.commitTransaction).not.toHaveBeenCalled();
    expect(queryRunner.rollbackTransaction).toHaveBeenCalledTimes(1);
    expect(queryRunner.release).toHaveBeenCalledTimes(1);
  });

  it('keeps mismatch traces and admission errors free of tenant and schema identifiers', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const { dataSource, queryRunner } = makeTransactionHarness();
    jest.spyOn(queryRunner, 'query').mockImplementation((sql: string) => {
      if (sql.includes('current_schema()')) {
        return Promise.resolve([{ schema: 'farm', tenant: tenantId, bypass: 'off' }]);
      }
      return Promise.resolve(undefined);
    });

    let errorMessage = '';
    try {
      await runInTenantTransaction(dataSource, 'farm', tenantId, () =>
        Promise.resolve('unreachable'),
      );
    } catch (error) {
      errorMessage = error instanceof Error ? error.message : String(error);
    }

    expect(errorMessage).toContain('SCHEMA_MISMATCH');
    expect(errorMessage).not.toContain(tenantId);
    expect(errorMessage).not.toContain(tenantSchema);
    expect(errorMessage).not.toContain('"farm"');

    const trace = warn.mock.calls
      .map(([message]) => JSON.parse(String(message)) as Record<string, unknown>)
      .find((record) => record['event'] === 'TenantBoundaryTrace');
    expect(trace).toMatchObject({
      event: 'TenantBoundaryTrace',
      operation: 'tenant-transaction',
      resultState: 'SCHEMA_MISMATCH',
    });
    expect(trace).not.toHaveProperty('tenantId');
    expect(trace).not.toHaveProperty('tenantHash');
    expect(trace).not.toHaveProperty('sourceSchema');
    expect(trace).not.toHaveProperty('expectedSchema');
    expect(trace).not.toHaveProperty('resolvedSchema');
    warn.mockRestore();
  });

  it('rejects invalid tenant ids before issuing SQL', async () => {
    const { queryRunner } = makeTransactionHarness();

    await expect(
      pinTenantTransactionSearchPath(queryRunner, 'messaging', 'not-a-uuid'),
    ).rejects.toThrow('invalid tenantId');

    expect(queryRunner.query).not.toHaveBeenCalled();
  });

  describe('bindTenantTransactionContext', () => {
    it('binds search_path, tenant GUC and bypass in one statement and passes when they read back', async () => {
      const { runner, query } = makeQueryRunner({
        schema: tenantSchema,
        tenant: tenantId,
        bypass: 'off',
      });

      await expect(bindTenantTransactionContext(runner, 'farm', tenantId)).resolves.toBeUndefined();

      expect(query).toHaveBeenCalledTimes(1);
      expect(query).toHaveBeenCalledWith(expect.stringContaining('current_schema()'), [
        `"${tenantSchema}", "farm", public`,
        'app.current_tenant',
        tenantId,
        'app.bypass_rls',
      ]);
    });

    it('forces bypass off inside the same statement that binds the tenant', async () => {
      const { runner, query } = makeQueryRunner({
        schema: tenantSchema,
        tenant: tenantId,
        bypass: 'off',
      });

      await bindTenantTransactionContext(runner, 'farm', tenantId);

      expect(query).toHaveBeenCalledWith(
        expect.stringMatching(/set_config\(\$4, 'off', true\)/),
        expect.anything(),
      );
    });

    it('throws SCHEMA_MISMATCH when current_schema fell back to the source schema', async () => {
      const { runner } = makeQueryRunner({ schema: 'farm', tenant: tenantId, bypass: 'off' });

      await expect(bindTenantTransactionContext(runner, 'farm', tenantId)).rejects.toMatchObject({
        state: 'SCHEMA_MISMATCH',
        resolvedSchema: 'farm',
      });
    });

    it('throws RLS_MISMATCH when the tenant GUC reads back empty', async () => {
      const { runner } = makeQueryRunner({ schema: tenantSchema, tenant: '', bypass: 'off' });

      await expect(bindTenantTransactionContext(runner, 'farm', tenantId)).rejects.toMatchObject({
        state: 'RLS_MISMATCH',
      });
    });

    it('throws RLS_MISMATCH when bypass reads back enabled', async () => {
      const { runner } = makeQueryRunner({ schema: tenantSchema, tenant: tenantId, bypass: 'on' });

      await expect(bindTenantTransactionContext(runner, 'farm', tenantId)).rejects.toBeInstanceOf(
        TenantContextError,
      );
    });

    it('skips verification when the read-back returns no row (no live connection)', async () => {
      const { runner } = makeQueryRunner(undefined);

      await expect(bindTenantTransactionContext(runner, 'farm', tenantId)).resolves.toBeUndefined();
    });

    it('rejects an invalid tenant id or source schema before issuing SQL', async () => {
      const { runner, query } = makeQueryRunner();

      await expect(bindTenantTransactionContext(runner, 'farm', 'not-a-uuid')).rejects.toThrow(
        'invalid tenantId',
      );
      await expect(bindTenantTransactionContext(runner, 'Farm; DROP', tenantId)).rejects.toThrow(
        'invalid source schema',
      );
      expect(query).not.toHaveBeenCalled();
    });
  });

  describe('assertTenantTransactionContext', () => {
    it('sets the RLS GUC transaction-locally and passes when schema + tenant match', async () => {
      const { runner, query } = makeQueryRunner({
        schema: tenantSchema,
        tenant: tenantId,
        bypass: 'off',
      });

      await expect(
        assertTenantTransactionContext(runner, 'farm', tenantId),
      ).resolves.toBeUndefined();

      expect(query).toHaveBeenCalledWith(`SELECT set_config($1, $2, true)`, [
        'app.current_tenant',
        tenantId,
      ]);
      expect(query).toHaveBeenCalledWith(`SELECT set_config($1, 'off', true)`, ['app.bypass_rls']);
    });

    it('throws SCHEMA_MISMATCH when current_schema fell back to the source schema', async () => {
      const { runner } = makeQueryRunner({
        schema: 'farm',
        tenant: tenantId,
        bypass: 'off',
      });

      await expect(assertTenantTransactionContext(runner, 'farm', tenantId)).rejects.toMatchObject({
        state: 'SCHEMA_MISMATCH',
        resolvedSchema: 'farm',
      });
    });

    it('throws RLS_MISMATCH (TenantContextError) when the RLS GUC resolves empty', async () => {
      const { runner } = makeQueryRunner({
        schema: tenantSchema,
        tenant: '',
        bypass: 'off',
      });

      await expect(assertTenantTransactionContext(runner, 'farm', tenantId)).rejects.toBeInstanceOf(
        TenantContextError,
      );
    });

    it('throws RLS_MISMATCH when a stale pooled bypass remains enabled', async () => {
      const { runner } = makeQueryRunner({
        schema: tenantSchema,
        tenant: tenantId,
        bypass: 'on',
      });

      await expect(assertTenantTransactionContext(runner, 'farm', tenantId)).rejects.toBeInstanceOf(
        TenantContextError,
      );
    });

    it('skips assertion (no live connection) when readback returns no row', async () => {
      const { runner } = makeQueryRunner(undefined);

      await expect(
        assertTenantTransactionContext(runner, 'farm', tenantId),
      ).resolves.toBeUndefined();
    });
  });
});

describe('assertSourceReadContext', () => {
  it('passes when current_schema resolves to the source schema', async () => {
    const executor: TenantContextQueryExecutor = {
      query: jest.fn().mockResolvedValue([{ schema: 'farm' }]),
    };
    await expect(assertSourceReadContext(executor, 'farm')).resolves.toBeUndefined();
  });

  it('throws SCHEMA_MISMATCH when current_schema resolves to a tenant schema', async () => {
    const executor: TenantContextQueryExecutor = {
      query: jest.fn().mockResolvedValue([{ schema: 'tenant_abc' }]),
    };
    await expect(assertSourceReadContext(executor, 'farm')).rejects.toBeInstanceOf(
      TenantContextError,
    );
  });

  it('skips the assertion when the connection returns no row (unit-test mock)', async () => {
    const executor: TenantContextQueryExecutor = {
      query: jest.fn().mockResolvedValue([]),
    };
    await expect(assertSourceReadContext(executor, 'farm')).resolves.toBeUndefined();
  });

  it('rejects an invalid source schema name before querying', async () => {
    const query = jest.fn();
    const executor: TenantContextQueryExecutor = { query };
    await expect(assertSourceReadContext(executor, 'Farm; DROP')).rejects.toThrow();
    expect(query).not.toHaveBeenCalled();
  });
});
