/**
 * Unit test for introspectSchema — mocked QueryRunner, no real PG boot.
 *
 * The introspector itself is pure-SQL-over-a-QueryRunner; integration
 * coverage comes from libs/migration-harness which runs it against
 * testcontainers in Phase 2 Step 3+.
 */
import { createMockDataSource } from '@aquaculture/testing';
import type { QueryRunner } from 'typeorm';

import { introspectSchema } from '../pg-catalog-introspector';

/** Minimal QueryRunner mock that dispatches by query-text pattern. */
function makeQr(routes: Array<{ match: RegExp; rows: unknown[] }>): {
  qr: QueryRunner;
  calls: string[];
} {
  // Default routes for the 10-shape introspector — tests only need to
  // override the shapes they assert on; the rest return empty arrays.
  // This keeps specs focused on behaviour-under-test without leaking
  // full catalog mocks into every spec.
  const defaultRoutes: Array<{ match: RegExp; rows: unknown[] }> = [
    { match: /FROM information_schema\.tables/, rows: [] },
    { match: /FROM information_schema\.columns/, rows: [] },
    { match: /FROM pg_enum/, rows: [] },
    { match: /AND c\.contype = 'c'/, rows: [] },
    { match: /AND i\.indpred IS NOT NULL/, rows: [] },
    { match: /AND c\.contype = 'x'/, rows: [] },
    { match: /AND c\.contype = 'f'/, rows: [] },
    {
      match: /\(a\.attgenerated <> '' OR a\.attidentity <> ''\)/,
      rows: [],
    },
    { match: /_timescaledb_internal/, rows: [] },
    { match: /FROM pg_policy/, rows: [] },
  ];
  const allRoutes = [...routes, ...defaultRoutes];
  const calls: string[] = [];
  const { mockQueryRunner } = createMockDataSource();
  mockQueryRunner.query.mockImplementation(
    (sql: string, _params?: unknown[]): Promise<unknown[]> => {
      calls.push(sql);
      for (const r of allRoutes) {
        if (r.match.test(sql)) return Promise.resolve(r.rows);
      }
      throw new Error(`Unexpected query in mock: ${sql}`);
    },
  );
  return { qr: mockQueryRunner, calls };
}

describe('introspectSchema', () => {
  it('captures tables + columns with all fields', async () => {
    const { qr } = makeQr([
      {
        match: /FROM information_schema\.tables/,
        rows: [{ table_name: 'payrolls' }, { table_name: 'employees' }],
      },
      {
        match: /FROM information_schema\.columns/,
        rows: [
          {
            table_name: 'payrolls',
            column_name: 'id',
            data_type: 'uuid',
            is_nullable: 'NO',
            character_maximum_length: null,
            ordinal_position: 1,
            column_default: null,
          },
          {
            table_name: 'payrolls',
            column_name: 'amount',
            data_type: 'numeric',
            is_nullable: 'YES',
            character_maximum_length: null,
            ordinal_position: 2,
            column_default: null,
          },
          {
            table_name: 'employees',
            column_name: 'id',
            data_type: 'uuid',
            is_nullable: 'NO',
            character_maximum_length: null,
            ordinal_position: 1,
            column_default: null,
          },
        ],
      },
      { match: /FROM pg_type t/, rows: [] },
      { match: /FROM pg_constraint c/, rows: [] },
    ]);

    const snap = await introspectSchema(qr, 'hr');
    expect(snap.schema).toBe('hr');
    expect(snap.tables).toHaveLength(2);
    expect(snap.tables[0]?.name).toBe('payrolls');
    expect(snap.tables[0]?.columns).toHaveLength(2);
    expect(snap.tables[0]?.columns[0]?.name).toBe('id');
    expect(snap.tables[0]?.columns[0]?.dataType).toBe('uuid');
    expect(snap.tables[0]?.columns[1]?.isNullable).toBe('YES');
    expect(snap.tables[1]?.name).toBe('employees');
    expect(snap.tables[1]?.columns).toHaveLength(1);
  });

  it('captures enums in pg_enum.enumsortorder sequence', async () => {
    const { qr } = makeQr([
      { match: /FROM information_schema\.tables/, rows: [] },
      { match: /FROM information_schema\.columns/, rows: [] },
      {
        match: /FROM pg_type t/,
        rows: [
          { type_name: 'leave_status', label: 'draft', sort_order: 1 },
          { type_name: 'leave_status', label: 'pending', sort_order: 2 },
          { type_name: 'leave_status', label: 'approved', sort_order: 3 },
          { type_name: 'cert_status', label: 'active', sort_order: 1 },
          { type_name: 'cert_status', label: 'expired', sort_order: 2 },
        ],
      },
      { match: /FROM pg_constraint c/, rows: [] },
    ]);

    const snap = await introspectSchema(qr, 'hr');
    expect(snap.enums).toHaveLength(2);
    const leave = snap.enums.find((e) => e.name === 'leave_status');
    expect(leave?.labels).toEqual(['draft', 'pending', 'approved']);
    const cert = snap.enums.find((e) => e.name === 'cert_status');
    expect(cert?.labels).toEqual(['active', 'expired']);
  });

  it('captures CHECK constraints with pg_get_constraintdef definition', async () => {
    const { qr } = makeQr([
      { match: /FROM information_schema\.tables/, rows: [] },
      { match: /FROM information_schema\.columns/, rows: [] },
      { match: /FROM pg_type t/, rows: [] },
      {
        match: /FROM pg_constraint c/,
        rows: [
          {
            conname: 'chk_salary_positive',
            table_name: 'payrolls',
            definition: 'CHECK ((amount > (0)::numeric))',
          },
        ],
      },
    ]);

    const snap = await introspectSchema(qr, 'hr');
    expect(snap.checkConstraints).toHaveLength(1);
    expect(snap.checkConstraints[0]?.name).toBe('chk_salary_positive');
    expect(snap.checkConstraints[0]?.tableName).toBe('payrolls');
    expect(snap.checkConstraints[0]?.definition).toContain('amount');
  });

  it('handles empty schema (no tables / enums / checks)', async () => {
    const { qr } = makeQr([
      { match: /FROM information_schema\.tables/, rows: [] },
      { match: /FROM pg_type t/, rows: [] },
      { match: /FROM pg_constraint c/, rows: [] },
    ]);

    const snap = await introspectSchema(qr, 'empty_schema');
    expect(snap.tables).toEqual([]);
    expect(snap.enums).toEqual([]);
    expect(snap.checkConstraints).toEqual([]);
  });

  it('capturedAt is ISO 8601', async () => {
    const { qr } = makeQr([
      { match: /FROM information_schema\.tables/, rows: [] },
      { match: /FROM pg_type t/, rows: [] },
      { match: /FROM pg_constraint c/, rows: [] },
    ]);
    const snap = await introspectSchema(qr, 'x');
    expect(snap.capturedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(new Date(snap.capturedAt).toISOString()).toBe(snap.capturedAt);
  });

  it('tables array is sorted alphabetically (deterministic output)', async () => {
    const { qr } = makeQr([
      {
        match: /FROM information_schema\.tables/,
        // Return sorted (mimics ORDER BY in the real query)
        rows: [{ table_name: 'a_first' }, { table_name: 'b_middle' }, { table_name: 'z_last' }],
      },
      { match: /FROM information_schema\.columns/, rows: [] },
      { match: /FROM pg_type t/, rows: [] },
      { match: /FROM pg_constraint c/, rows: [] },
    ]);
    const snap = await introspectSchema(qr, 'det');
    expect(snap.tables.map((t) => t.name)).toEqual(['a_first', 'b_middle', 'z_last']);
  });
});
