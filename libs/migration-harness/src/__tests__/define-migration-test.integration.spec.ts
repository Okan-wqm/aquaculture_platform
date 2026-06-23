/**
 * Integration test for defineMigrationTest. Uses a minimal fixture migration
 * (AddTimestampsFixture) that ADDs two columns; the wrapper drives the full
 * describe/beforeAll/afterAll/it lifecycle end-to-end against a real container.
 *
 * If this spec passes, defineMigrationTest works for any migration class the
 * repo ships — Phase 5's HR-drift regression will consume it next.
 */
import type { MigrationInterface, QueryRunner } from 'typeorm';

import { defineMigrationTest } from '../define-migration-test';

import { queryRows } from './test-helpers';

/**
 * Fixture migration — minimal real-world shape:
 *   - class (not lambda) so `new` works
 *   - up() runs DDL against current search_path
 *   - down() no-op for this fixture
 */
class AddTimestampsFixture1234567890000 implements MigrationInterface {
  public async up(qr: QueryRunner): Promise<void> {
    await qr.query(
      `ALTER TABLE thing ADD COLUMN IF NOT EXISTS created_at timestamptz DEFAULT now()`,
    );
    await qr.query(
      `ALTER TABLE thing ADD COLUMN IF NOT EXISTS updated_at timestamptz DEFAULT now()`,
    );
  }
  public async down(_qr: QueryRunner): Promise<void> {
    // no-op
  }
}

defineMigrationTest({
  migration: AddTimestampsFixture1234567890000,
  schema: 'fixture_schema',
  priorState: `CREATE TABLE thing (id uuid PRIMARY KEY, name text NOT NULL)`,
  assertions: async ({ qr, schema }) => {
    const cols = await queryRows<{ column_name: string; data_type: string }>(
      qr,
      `SELECT column_name, data_type
           FROM information_schema.columns
          WHERE table_schema = $1 AND table_name = $2
          ORDER BY ordinal_position`,
      [schema, 'thing'],
    );
    const names = cols.map((c) => c.column_name);
    expect(names).toEqual(['id', 'name', 'created_at', 'updated_at']);
    expect(cols).toHaveLength(4);
    expect(cols[2]?.data_type).toBe('timestamp with time zone');
    expect(cols[3]?.data_type).toBe('timestamp with time zone');
  },
});
