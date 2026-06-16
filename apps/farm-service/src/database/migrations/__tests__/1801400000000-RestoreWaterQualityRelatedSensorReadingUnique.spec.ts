import { createMockDataSource } from '@aquaculture/testing';
import type { QueryRunner } from 'typeorm';

import { RestoreWaterQualityRelatedSensorReadingUnique1801400000000 } from '../1801400000000-RestoreWaterQualityRelatedSensorReadingUnique';

/** The mocked QueryRunner.query — TypeORM's overloaded signature, jest-wrapped. */
type MockedQuery = jest.Mocked<QueryRunner>['query'];

/**
 * Unit spec (mocked QueryRunner — no DB). Proves the migration:
 *   - self-discovers farm + tenant schemas;
 *   - runs the FAIL-LOUD dedup pre-flight per schema BEFORE creating the index;
 *   - throws (never auto-deletes) when duplicates exist;
 *   - creates a partial UNIQUE index CONCURRENTLY IF NOT EXISTS per schema;
 *   - runs outside a wrapping tx (transaction = false).
 */
describe('RestoreWaterQualityRelatedSensorReadingUnique1801400000000', () => {
  const SCHEMA_ROWS = [
    { schema_name: 'farm' },
    { schema_name: 'tenant_0123456789abcdef' },
  ];

  function makeRunner(
    handler: (sql: string) => unknown,
  ): { query: MockedQuery; queryRunner: QueryRunner } {
    const { mockQueryRunner } = createMockDataSource();
    mockQueryRunner.query.mockImplementation((sql: string) =>
      Promise.resolve(handler(sql)),
    );
    return { query: mockQueryRunner.query, queryRunner: mockQueryRunner };
  }

  it('declares transaction = false (required for CREATE INDEX CONCURRENTLY)', () => {
    const migration =
      new RestoreWaterQualityRelatedSensorReadingUnique1801400000000();
    expect(migration.transaction).toBe(false);
  });

  it('runs the dedup pre-flight before creating the index, per discovered schema', async () => {
    const { query, queryRunner } = makeRunner((sql) => {
      if (sql.includes('information_schema.schemata')) return SCHEMA_ROWS;
      if (sql.includes('HAVING COUNT(*) > 1')) return []; // no duplicates
      return [];
    });

    await new RestoreWaterQualityRelatedSensorReadingUnique1801400000000().up(
      queryRunner,
    );

    const sqls = query.mock.calls.map(([s]) => String(s));
    const dedupIdx = sqls.findIndex((s) => s.includes('HAVING COUNT(*) > 1'));
    const createIdx = sqls.findIndex((s) =>
      /CREATE UNIQUE INDEX CONCURRENTLY/i.test(s),
    );
    expect(dedupIdx).toBeGreaterThanOrEqual(0);
    expect(createIdx).toBeGreaterThan(dedupIdx);
  });

  it('creates a partial UNIQUE index CONCURRENTLY IF NOT EXISTS for each schema', async () => {
    const { query, queryRunner } = makeRunner((sql) => {
      if (sql.includes('information_schema.schemata')) return SCHEMA_ROWS;
      if (sql.includes('HAVING COUNT(*) > 1')) return [];
      return [];
    });

    await new RestoreWaterQualityRelatedSensorReadingUnique1801400000000().up(
      queryRunner,
    );

    const creates = query.mock.calls
      .map(([s]) => String(s))
      .filter((s) => /CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS/i.test(s));
    expect(creates).toHaveLength(SCHEMA_ROWS.length);
    expect(creates.every((s) => /WHERE "relatedSensorReadingId" IS NOT NULL/i.test(s))).toBe(true);
    expect(creates.some((s) => s.includes('"farm"."water_quality_measurements"'))).toBe(true);
    expect(creates.some((s) => s.includes('"tenant_0123456789abcdef"."water_quality_measurements"'))).toBe(true);
  });

  it('FAILS LOUD (throws, no index creation) when duplicates exist — never auto-deletes', async () => {
    const { query, queryRunner } = makeRunner((sql) => {
      if (sql.includes('information_schema.schemata')) return SCHEMA_ROWS;
      if (sql.includes('HAVING COUNT(*) > 1')) {
        return [
          { tenantId: 't1', relatedSensorReadingId: 'r1', count: '2' },
        ];
      }
      return [];
    });

    await expect(
      new RestoreWaterQualityRelatedSensorReadingUnique1801400000000().up(
        queryRunner,
      ),
    ).rejects.toThrow(/duplicate \(tenantId, relatedSensorReadingId\) pairs/i);

    // No DELETE / index creation attempted.
    const sqls = query.mock.calls.map(([s]) => String(s));
    expect(sqls.some((s) => /DELETE/i.test(s))).toBe(false);
    expect(sqls.some((s) => /CREATE UNIQUE INDEX/i.test(s))).toBe(false);
  });

  it('refuses an unsafe schema name surfaced by discovery (SQL-injection guard)', async () => {
    const { queryRunner } = makeRunner((sql) => {
      if (sql.includes('information_schema.schemata')) {
        return [{ schema_name: 'farm; DROP TABLE x' }];
      }
      if (sql.includes('HAVING COUNT(*) > 1')) return [];
      return [];
    });

    await expect(
      new RestoreWaterQualityRelatedSensorReadingUnique1801400000000().up(
        queryRunner,
      ),
    ).rejects.toThrow(/Refusing unsafe schema name/i);
  });
});
