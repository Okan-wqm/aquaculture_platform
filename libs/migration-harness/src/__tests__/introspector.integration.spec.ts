import { introspectSchema } from '@aquaculture/backend-common/database';

import {
  type HarnessContext,
  bootPostgresContainer,
  shutdownHarness,
} from '../index';

import {
  expectDefined,
  expectHarnessContext,
  withHarnessSchema,
} from './test-helpers';

describe('introspectSchema — integration (real PG)', () => {
  let ctx: HarnessContext | undefined;

  beforeAll(async () => {
    ctx = await bootPostgresContainer();
  }, 90_000);

  afterAll(async () => {
    await shutdownHarness(ctx);
  }, 30_000);

  it('captures tables, columns, enums, and CHECK constraints from a populated schema', async () => {
    const harness = expectHarnessContext(ctx);
    await withHarnessSchema(harness, async (_e, qr) => {
      const schema = 'introspect_test';
      await qr.query(`CREATE SCHEMA IF NOT EXISTS ${schema}`);
      try {
        // Seed: one enum, one table with a CHECK constraint + default.
        await qr.query(
          `CREATE TYPE ${schema}.status_enum AS ENUM ('draft', 'active', 'archived')`,
        );
        await qr.query(
          `CREATE TABLE ${schema}.thing (
             id uuid PRIMARY KEY,
             name text NOT NULL,
             status ${schema}.status_enum NOT NULL DEFAULT 'draft',
             amount numeric(12, 2) CHECK (amount > 0)
           )`,
        );

        const snap = await introspectSchema(qr, schema);

        // Tables + columns
        expect(snap.schema).toBe(schema);
        expect(snap.tables).toHaveLength(1);
        const thing = expectDefined(snap.tables[0], 'introspected table[0]');
        expect(thing.name).toBe('thing');
        expect(thing.columns.map((c) => c.name)).toEqual([
          'id',
          'name',
          'status',
          'amount',
        ]);

        const nameCol = expectDefined(
          thing.columns.find((c) => c.name === 'name'),
          "column 'name'",
        );
        expect(nameCol.dataType).toBe('text');
        expect(nameCol.isNullable).toBe('NO');

        const amountCol = expectDefined(
          thing.columns.find((c) => c.name === 'amount'),
          "column 'amount'",
        );
        expect(amountCol.dataType).toBe('numeric');
        expect(amountCol.isNullable).toBe('YES');

        const statusCol = expectDefined(
          thing.columns.find((c) => c.name === 'status'),
          "column 'status'",
        );
        // PG reports user-defined enum types as 'USER-DEFINED' in
        // information_schema — the drift validator's Class F (enum_labels)
        // uses snap.enums for identity, not this string.
        expect(statusCol.dataType).toBe('USER-DEFINED');
        expect(statusCol.columnDefault).toContain('draft');

        // Enums with sort order
        expect(snap.enums).toHaveLength(1);
        expect(snap.enums[0]?.name).toBe('status_enum');
        expect(snap.enums[0]?.labels).toEqual(['draft', 'active', 'archived']);

        // CHECK constraints (table-level + column-level)
        expect(snap.checkConstraints.length).toBeGreaterThanOrEqual(1);
        const amountCheck = snap.checkConstraints.find((c) =>
          c.definition.includes('amount'),
        );
        expect(amountCheck).toBeDefined();
        expect(amountCheck?.tableName).toBe('thing');
      } finally {
        await qr.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      }
    });
  });

  it('handles empty schema cleanly', async () => {
    const harness = expectHarnessContext(ctx);
    await withHarnessSchema(harness, async (_e, qr) => {
      const schema = 'empty_introspect';
      await qr.query(`CREATE SCHEMA IF NOT EXISTS ${schema}`);
      try {
        const snap = await introspectSchema(qr, schema);
        expect(snap.tables).toEqual([]);
        expect(snap.enums).toEqual([]);
        expect(snap.checkConstraints).toEqual([]);
      } finally {
        await qr.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      }
    });
  });

  it('snapshot is deterministic under repeated calls', async () => {
    const harness = expectHarnessContext(ctx);
    await withHarnessSchema(harness, async (_e, qr) => {
      const schema = 'determinism_test';
      await qr.query(`CREATE SCHEMA IF NOT EXISTS ${schema}`);
      try {
        await qr.query(
          `CREATE TABLE ${schema}.a (id uuid PRIMARY KEY, val text)`,
        );
        await qr.query(`CREATE TABLE ${schema}.b (id uuid PRIMARY KEY)`);
        const s1 = await introspectSchema(qr, schema);
        const s2 = await introspectSchema(qr, schema);
        // Strip capturedAt (timestamp differs per call by design)
        const { capturedAt: _a, ...rest1 } = s1;
        const { capturedAt: _b, ...rest2 } = s2;
        expect(JSON.stringify(rest1)).toBe(JSON.stringify(rest2));
      } finally {
        await qr.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      }
    });
  });
});
