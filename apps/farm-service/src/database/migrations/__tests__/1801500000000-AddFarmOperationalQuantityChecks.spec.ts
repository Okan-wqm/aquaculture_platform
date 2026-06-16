import { createMockDataSource } from '@aquaculture/testing';
import type { QueryRunner } from 'typeorm';

import { AddFarmOperationalQuantityChecks1801500000000 } from '../1801500000000-AddFarmOperationalQuantityChecks';

/** The mocked QueryRunner.query — TypeORM's overloaded signature, jest-wrapped. */
type MockedQuery = jest.Mocked<QueryRunner>['query'];

/**
 * Unit spec (mocked QueryRunner — no DB). Proves the migration:
 *   - sets the SET LOCAL lock/statement-timeout envelope;
 *   - probes for violating rows per constraint BEFORE ADD CONSTRAINT;
 *   - throws a clear error (no ADD) when violating rows exist;
 *   - emits guarded ADD CONSTRAINT inside a DO/EXCEPTION duplicate_object block;
 *   - includes the key invariants (mortality count > 0, calendar bounds, tank
 *     non-negativity) and EXCLUDES over-capacity + biomassGain;
 *   - postCondition() asserts sentinel constraints exist in current_schema().
 */
describe('AddFarmOperationalQuantityChecks1801500000000', () => {
  function makeRunner(
    handler: (sql: string) => unknown,
  ): { query: MockedQuery; queryRunner: QueryRunner } {
    const { mockQueryRunner } = createMockDataSource();
    mockQueryRunner.query.mockImplementation((sql: string) =>
      Promise.resolve(handler(sql)),
    );
    return { query: mockQueryRunner.query, queryRunner: mockQueryRunner };
  }

  /** Default handler: zero violations everywhere; DO-blocks resolve. */
  const cleanHandler = (sql: string): unknown => {
    if (/SELECT COUNT\(\*\)::text AS violations/i.test(sql)) {
      return [{ violations: '0' }];
    }
    return [];
  };

  it('sets the SET LOCAL lock_timeout + statement_timeout envelope first', async () => {
    const { query, queryRunner } = makeRunner(cleanHandler);
    await new AddFarmOperationalQuantityChecks1801500000000().up(queryRunner);

    expect(query).toHaveBeenCalledWith(`SET LOCAL lock_timeout = '30s'`);
    expect(query).toHaveBeenCalledWith(`SET LOCAL statement_timeout = '600s'`);
  });

  it('probes for violations before every guarded ADD CONSTRAINT', async () => {
    const { query, queryRunner } = makeRunner(cleanHandler);
    await new AddFarmOperationalQuantityChecks1801500000000().up(queryRunner);

    const sqls = query.mock.calls.map(([s]) => String(s));
    const probes = sqls.filter((s) =>
      /SELECT COUNT\(\*\)::text AS violations/i.test(s),
    );
    const adds = sqls.filter((s) => /ADD CONSTRAINT/i.test(s));
    // One probe per ADD, and every ADD is wrapped in a DO/EXCEPTION guard.
    expect(probes.length).toBe(adds.length);
    expect(probes.length).toBeGreaterThan(0);
    expect(
      adds.every((s) => /DO \$\$/i.test(s) && /WHEN duplicate_object THEN NULL/i.test(s)),
    ).toBe(true);
  });

  it('encodes the key invariants and EXCLUDES over-capacity + biomassGain', async () => {
    const { query, queryRunner } = makeRunner(cleanHandler);
    await new AddFarmOperationalQuantityChecks1801500000000().up(queryRunner);

    const allSql = query.mock.calls.map(([s]) => String(s)).join('\n');
    expect(allSql).toContain('CHK_mortality_records_count_positive');
    expect(allSql).toContain('"count" > 0'); // strict > 0 (DTO @Min(1))
    expect(allSql).toContain('"reportMonth" BETWEEN 1 AND 12');
    expect(allSql).toContain('"reportYear" BETWEEN 2000 AND 2100');
    expect(allSql).toContain('CHK_tanks_current_biomass_nonneg');
    expect(allSql).toContain('CHK_stock_movements_quantity_nonneg');
    // Nullable columns guarded with IS NULL OR >= 0.
    expect(allSql).toContain('"currentCount" IS NULL OR "currentCount" >= 0');
    // EXCLUSIONS:
    expect(allSql).not.toContain('biomassGain');
    expect(allSql).not.toMatch(/currentBiomass[^>]*<=?\s*"?maxBiomass/);
  });

  it('throws a clear, actionable error and skips ADD when violating rows exist', async () => {
    const { query, queryRunner } = makeRunner((sql) => {
      if (/SELECT COUNT\(\*\)::text AS violations/i.test(sql)) {
        // First probed table has 3 bad rows.
        return [{ violations: '3' }];
      }
      return [];
    });

    await expect(
      new AddFarmOperationalQuantityChecks1801500000000().up(queryRunner),
    ).rejects.toThrow(/row\(s\) violating CHECK/i);

    const sqls = query.mock.calls.map(([s]) => String(s));
    // Aborts at the first violating probe — no ADD CONSTRAINT issued.
    expect(sqls.some((s) => /ADD CONSTRAINT/i.test(s))).toBe(false);
  });

  it('postCondition returns true when all sentinel constraints are present', async () => {
    const { queryRunner } = makeRunner((sql) => {
      if (/pg_constraint/i.test(sql)) {
        return [{ present: '5' }]; // sentinels length
      }
      return [];
    });

    const result = await new AddFarmOperationalQuantityChecks1801500000000().postCondition(
      queryRunner,
    );
    expect(result).toBe(true);
  });

  it('postCondition returns false (runner rolls back) when a sentinel constraint is missing', async () => {
    const { queryRunner } = makeRunner((sql) => {
      if (/pg_constraint/i.test(sql)) {
        return [{ present: '4' }]; // one missing
      }
      return [];
    });

    const result = await new AddFarmOperationalQuantityChecks1801500000000().postCondition(
      queryRunner,
    );
    expect(result).toBe(false);
  });

  it('postCondition scopes the existence check to current_schema()', async () => {
    const { query, queryRunner } = makeRunner((sql) => {
      if (/pg_constraint/i.test(sql)) return [{ present: '5' }];
      return [];
    });

    await new AddFarmOperationalQuantityChecks1801500000000().postCondition(
      queryRunner,
    );
    const pgConstraintCall = query.mock.calls.find(([s]) =>
      /pg_constraint/i.test(String(s)),
    );
    expect(String(pgConstraintCall?.[0])).toContain('current_schema()');
  });
});
