import 'reflect-metadata';

import type { DataSource } from 'typeorm';

import { assertExpandContractDependency } from '../assert-expand-contract-dependency';
import { EXPAND_CONTRACT_META_KEY, ExpandContract } from '../expand-contract.decorator';

interface QueryLog {
  readonly sql: string;
  readonly params?: readonly unknown[];
}

function makeDs(routes: Array<{ match: RegExp; rows: unknown[] }>): {
  ds: DataSource;
  calls: QueryLog[];
} {
  const calls: QueryLog[] = [];
  const ds = {
    query: jest.fn((sql: string, params?: readonly unknown[]): Promise<unknown[]> => {
      calls.push(params !== undefined ? { sql, params } : { sql });
      for (const r of routes) {
        if (r.match.test(sql)) return Promise.resolve(r.rows);
      }
      return Promise.resolve([]);
    }),
  } as unknown as DataSource;
  return { ds, calls };
}

describe('assertExpandContractDependency', () => {
  it('no-op for undecorated migration class', async () => {
    class Bare {
      readonly marker = 'undecorated';
    }
    const { ds, calls } = makeDs([]);
    const result = await assertExpandContractDependency({
      dataSource: ds,
      migrationClass: Bare,
      environment: 'production',
    });
    expect(result).toEqual({ checked: false, skipped: true, reason: 'undecorated' });
    expect(calls).toEqual([]);
  });

  it('no-op for expand-phase migration', async () => {
    @ExpandContract({ phase: 'expand' })
    class ExpandMig {}
    const { ds, calls } = makeDs([]);
    const result = await assertExpandContractDependency({
      dataSource: ds,
      migrationClass: ExpandMig,
      environment: 'staging',
    });
    expect(result.skipped).toBe(true);
    expect(result.reason).toBe('expand-phase');
    expect(calls).toEqual([]);
  });

  it('returns SKIPPED when observability.migration_backfill_progress is missing', async () => {
    @ExpandContract({ phase: 'contract', dependsOn: 'AddFooExpand' })
    class ContractMig {}
    const { ds } = makeDs([{ match: /information_schema\.tables/, rows: [{ exists: false }] }]);
    const result = await assertExpandContractDependency({
      dataSource: ds,
      migrationClass: ContractMig,
      environment: 'production',
    });
    expect(result.checked).toBe(false);
    expect(result.skipped).toBe(true);
    expect(result.dependsOn).toBe('AddFooExpand');
    expect(result.reason).toContain('fail-open at bootstrap');
  });

  it('THROWS when dependsOn row is absent from progress table', async () => {
    @ExpandContract({ phase: 'contract', dependsOn: 'AddFooExpand' })
    class ContractMig {}
    const { ds } = makeDs([
      { match: /information_schema\.tables/, rows: [{ exists: true }] },
      {
        match: /migration_backfill_progress/,
        rows: [{ count: '0' }],
      },
    ]);
    await expect(
      assertExpandContractDependency({
        dataSource: ds,
        migrationClass: ContractMig,
        environment: 'production',
      }),
    ).rejects.toThrow(/dependsOn 'AddFooExpand' has not been applied/);
  });

  it('returns CHECKED when dependsOn row is present for the environment', async () => {
    @ExpandContract({ phase: 'contract', dependsOn: 'AddFooExpand' })
    class ContractMig {}
    const { ds, calls } = makeDs([
      { match: /information_schema\.tables/, rows: [{ exists: true }] },
      {
        match: /migration_backfill_progress/,
        rows: [{ count: '1' }],
      },
    ]);
    const result = await assertExpandContractDependency({
      dataSource: ds,
      migrationClass: ContractMig,
      environment: 'production',
    });
    expect(result.checked).toBe(true);
    expect(result.skipped).toBe(false);
    expect(result.dependsOn).toBe('AddFooExpand');
    // Assert: correct environment parameter was passed. The probe
    // query also mentions migration_backfill_progress via
    // information_schema.tables WHERE table_name=..., so filter
    // down to the actual COUNT query (only that one has params).
    const progressCall = calls.find((c) =>
      /FROM observability\.migration_backfill_progress/.test(c.sql),
    );
    expect(progressCall?.params).toEqual(['AddFooExpand', 'production']);
  });

  it('throws when decorator metadata has phase=contract without dependsOn (belt-and-braces)', async () => {
    // Runtime bypass: hand-inject metadata the decorator would reject.
    class HandCrafted {
      readonly marker = 'hand-crafted';
    }
    Reflect.defineMetadata(
      EXPAND_CONTRACT_META_KEY,
      { phase: 'contract', target: HandCrafted },
      HandCrafted,
    );
    const { ds } = makeDs([]);
    await expect(
      assertExpandContractDependency({
        dataSource: ds,
        migrationClass: HandCrafted,
        environment: 'staging',
      }),
    ).rejects.toThrow(/dependsOn/);
  });

  it('environment scoping — same migration in staging does NOT satisfy production check', async () => {
    @ExpandContract({ phase: 'contract', dependsOn: 'AddFooExpand' })
    class ContractMig {}
    // Router simulates: table exists, but environment parameter is
    // production while only staging has the row → count = 0.
    const { ds } = makeDs([
      { match: /information_schema\.tables/, rows: [{ exists: true }] },
      {
        match: /migration_backfill_progress/,
        rows: [{ count: '0' }],
      },
    ]);
    await expect(
      assertExpandContractDependency({
        dataSource: ds,
        migrationClass: ContractMig,
        environment: 'production',
      }),
    ).rejects.toThrow(/environment 'production'/);
  });
});
