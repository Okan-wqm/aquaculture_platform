/**
 * ADR-053 — on PostgreSQL 16 a constant-default `ADD COLUMN … NOT NULL` changes
 * only the catalog.
 *
 * WHY: docs/runbooks/migration-authoring.md (Blue-green safety) allows
 * `ADD COLUMN … NOT NULL DEFAULT <constant>` on a populated table without a
 * backfill. That rule is a claim about the server, not about our code, so it is
 * proven here on the server production runs: the harness boots
 * DEFAULT_POSTGRES_IMAGE, which tests/invariants/postgres-image-uniformity.spec.ts
 * holds equal to the manifest image the production image is built FROM. A
 * Postgres bump edits setup.ts, which marks this project affected and re-runs
 * this proof on the new image.
 *
 * WHAT:
 *   - The server's major version equals the manifest's `postgres_major`, so an
 *     external server (MIGRATION_HARNESS_PG_URL) of another major fails by name
 *     instead of proving the rule on the wrong engine.
 *   - For each allowlisted default (ADR-053 Decision 1) the table's and every
 *     index's relfilenode survive the ADD, the column is served from
 *     pg_attribute's missing value (`atthasmissing`), every legacy row reads the
 *     default, and a later DROP DEFAULT changes none of that.
 *   - For each rewriting form (Decision 2) the table's relfilenode changes.
 *     These negative controls prove the probe can see a rewrite at all.
 *
 * An inline CHECK, REFERENCES, UNIQUE or PRIMARY KEY scans the table without
 * rewriting it, which a relfilenode probe cannot see; the migration-sql-lint
 * rule R13-add-column-rewriting-default owns those.
 */
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import type { QueryRunner } from 'typeorm';

import { bootPostgresContainer, shutdownHarness, type HarnessContext } from '../index';

import {
  expectHarnessContext,
  queryRequiredRow,
  queryRows,
  withHarnessSchema,
} from './test-helpers';

const REPO_ROOT = resolve(__dirname, '..', '..', '..', '..');
const POSTGRES_IMAGE_MANIFEST = join(REPO_ROOT, '.github', 'manifests', 'postgres-image.json');

const LEGACY_ROWS = 50;
const TENANT_ID = '00000000-0000-4000-8000-000000000053';
const TABLE = 'probe_legacy';
const COLUMN = 'probe_added';

/** An ADR-053 Decision-1 default: a literal (optionally cast) or a stable time function. */
interface CatalogOnlyForm {
  readonly label: string;
  readonly prepare: readonly string[];
  readonly type: string;
  readonly defaultSql: string;
}

/** An ADR-053 Decision-2 column definition: PostgreSQL rewrites the table to add it. */
interface RewritingForm {
  readonly label: string;
  readonly prepare: readonly string[];
  readonly definition: string;
}

const CATALOG_ONLY_FORMS: readonly CatalogOnlyForm[] = [
  {
    label: 'an enum literal cast to its type',
    prepare: [`CREATE TYPE probe_module AS ENUM ('farm', 'sensor')`],
    type: 'probe_module',
    defaultSql: `'farm'::probe_module`,
  },
  { label: 'a text literal', prepare: [], type: 'text', defaultSql: `'farm'` },
  { label: 'an integer literal', prepare: [], type: 'integer', defaultSql: '0' },
  { label: 'a boolean literal', prepare: [], type: 'boolean', defaultSql: 'false' },
  { label: 'a jsonb literal', prepare: [], type: 'jsonb', defaultSql: `'{}'::jsonb` },
  { label: 'now()', prepare: [], type: 'timestamptz', defaultSql: 'now()' },
  { label: 'CURRENT_TIMESTAMP', prepare: [], type: 'timestamptz', defaultSql: 'CURRENT_TIMESTAMP' },
  { label: 'CURRENT_DATE', prepare: [], type: 'date', defaultSql: 'CURRENT_DATE' },
];

const REWRITING_FORMS: readonly RewritingForm[] = [
  {
    label: 'a volatile gen_random_uuid() default',
    prepare: [],
    definition: 'uuid NOT NULL DEFAULT gen_random_uuid()',
  },
  {
    label: 'a volatile clock_timestamp() default',
    prepare: [],
    definition: 'timestamptz NOT NULL DEFAULT clock_timestamp()',
  },
  {
    label: 'a volatile random() default',
    prepare: [],
    definition: 'double precision NOT NULL DEFAULT random()',
  },
  {
    label: 'a nextval() default',
    prepare: ['CREATE SEQUENCE probe_counter'],
    definition: `bigint NOT NULL DEFAULT nextval('probe_counter')`,
  },
  { label: 'a bigserial column', prepare: [], definition: 'bigserial' },
  {
    label: 'an identity column',
    prepare: [],
    definition: 'bigint GENERATED ALWAYS AS IDENTITY',
  },
  {
    label: 'a GENERATED ALWAYS AS (…) STORED column',
    prepare: [],
    definition: 'integer GENERATED ALWAYS AS (qty * 2) STORED',
  },
  {
    label: 'a constrained domain with a constant default',
    prepare: ['CREATE DOMAIN probe_positive AS integer CHECK (VALUE > 0)'],
    definition: 'probe_positive NOT NULL DEFAULT 1',
  },
];

interface RelationFilenodes {
  readonly table: string;
  readonly indexes: readonly { readonly name: string; readonly filenode: string }[];
}

function isJsonObject(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function manifestPostgresMajor(): number {
  const parsed: unknown = JSON.parse(readFileSync(POSTGRES_IMAGE_MANIFEST, 'utf8'));
  if (!isJsonObject(parsed)) {
    throw new Error(`${POSTGRES_IMAGE_MANIFEST} is not a JSON object`);
  }
  const major = parsed['postgres_major'];
  if (typeof major !== 'number') {
    throw new Error(`${POSTGRES_IMAGE_MANIFEST} has no numeric postgres_major`);
  }
  return major;
}

/**
 * A populated tenant-shaped table: a primary key, a secondary index, ENABLE +
 * FORCE row-level security with the canonical tenant predicate, and legacy rows
 * written under the tenant GUC so a non-superuser owner can see them too.
 */
async function createLegacyTable(qr: QueryRunner): Promise<void> {
  await qr.query(`SELECT set_config('app.current_tenant', $1, false)`, [TENANT_ID]);
  await qr.query(
    `CREATE TABLE ${TABLE} (
       id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
       tenant_id uuid NOT NULL,
       qty integer NOT NULL,
       label text NOT NULL
     )`,
  );
  await qr.query(`CREATE INDEX ${TABLE}_tenant_label_idx ON ${TABLE} (tenant_id, label)`);
  await qr.query(`ALTER TABLE ${TABLE} ENABLE ROW LEVEL SECURITY`);
  await qr.query(`ALTER TABLE ${TABLE} FORCE ROW LEVEL SECURITY`);
  await qr.query(
    `CREATE POLICY tenant_isolation_policy ON ${TABLE} USING (
       current_setting('app.bypass_rls', true) = 'on'
       OR tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid
     )`,
  );
  await qr.query(
    `INSERT INTO ${TABLE} (tenant_id, qty, label)
       SELECT $1::uuid, g, 'row-' || g FROM generate_series(1, ${LEGACY_ROWS}) AS g`,
    [TENANT_ID],
  );
}

async function filenodes(qr: QueryRunner): Promise<RelationFilenodes> {
  const table = await queryRequiredRow<{ filenode: string }>(
    qr,
    `SELECT pg_relation_filenode($1::regclass)::text AS filenode`,
    [TABLE],
  );
  const indexes = await queryRows<{ name: string; filenode: string }>(
    qr,
    `SELECT c.relname::text AS name, pg_relation_filenode(i.indexrelid)::text AS filenode
       FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
      WHERE i.indrelid = $1::regclass
      ORDER BY c.relname`,
    [TABLE],
  );
  return { table: table.filenode, indexes };
}

async function hasMissingValue(qr: QueryRunner): Promise<boolean> {
  const row = await queryRequiredRow<{ atthasmissing: boolean }>(
    qr,
    `SELECT atthasmissing FROM pg_attribute
      WHERE attrelid = $1::regclass AND attname = $2 AND NOT attisdropped`,
    [TABLE, COLUMN],
  );
  return row.atthasmissing;
}

/** Legacy rows, and how many of them read `expected` in the added column. */
function legacyRowsReading(
  qr: QueryRunner,
  type: string,
  expected: string,
): Promise<{ total: number; matching: number }> {
  return queryRequiredRow<{ total: number; matching: number }>(
    qr,
    `SELECT count(*)::int AS total,
            count(*) FILTER (WHERE ${COLUMN} IS NOT DISTINCT FROM $1::${type})::int AS matching
       FROM ${TABLE}`,
    [expected],
  );
}

/**
 * The ADR-053 envelope: one table, `SET LOCAL lock_timeout` of 2 s, one
 * transaction — the shape the migration-sql-lint rule
 * R14-add-column-exemption-shape requires of a migration.
 */
async function inAdr053Transaction<T>(qr: QueryRunner, body: () => Promise<T>): Promise<T> {
  await qr.startTransaction();
  try {
    await qr.query(`SET LOCAL lock_timeout = '2s'`);
    const result = await body();
    await qr.commitTransaction();
    return result;
  } catch (error) {
    await qr.rollbackTransaction();
    throw error;
  }
}

/**
 * Add the column with a Decision-1 default. Returns the default's value as the
 * migration's own transaction evaluates it, which is the value PostgreSQL
 * stores for every legacy row.
 */
function addCatalogOnlyColumn(qr: QueryRunner, form: CatalogOnlyForm): Promise<string> {
  return inAdr053Transaction(qr, async () => {
    const evaluated = await queryRequiredRow<{ value: string }>(
      qr,
      `SELECT (${form.defaultSql})::text AS value`,
    );
    await qr.query(
      `ALTER TABLE ${TABLE} ADD COLUMN IF NOT EXISTS ${COLUMN} ${form.type} NOT NULL DEFAULT ${form.defaultSql}`,
    );
    return evaluated.value;
  });
}

function addRewritingColumn(qr: QueryRunner, form: RewritingForm): Promise<void> {
  return inAdr053Transaction(qr, async () => {
    await qr.query(`ALTER TABLE ${TABLE} ADD COLUMN IF NOT EXISTS ${COLUMN} ${form.definition}`);
  });
}

describe('ADR-053 — PG16 constant-default ADD COLUMN is catalog-only', () => {
  let ctx: HarnessContext | undefined;

  beforeAll(async () => {
    ctx = await bootPostgresContainer();
  }, 90_000);

  afterAll(async () => {
    await shutdownHarness(ctx);
  }, 30_000);

  it('runs on the PostgreSQL major the image manifest pins', async () => {
    const harness = expectHarnessContext(ctx);
    const qr = harness.dataSource.createQueryRunner();
    try {
      const row = await queryRequiredRow<{ major: number }>(
        qr,
        `SELECT (current_setting('server_version_num')::int / 10000) AS major`,
      );
      expect(row.major).toBe(manifestPostgresMajor());
    } finally {
      await qr.release();
    }
  });

  it.each(CATALOG_ONLY_FORMS)(
    'adds NOT NULL DEFAULT with $label without rewriting the table or its indexes',
    async (form) => {
      await withHarnessSchema(ctx, async (_schema, qr) => {
        for (const statement of form.prepare) await qr.query(statement);
        await createLegacyTable(qr);
        const before = await filenodes(qr);
        expect(before.indexes.length).toBe(2);

        const expected = await addCatalogOnlyColumn(qr, form);

        expect(await filenodes(qr)).toEqual(before);
        expect(await hasMissingValue(qr)).toBe(true);
        expect(await legacyRowsReading(qr, form.type, expected)).toEqual({
          total: LEGACY_ROWS,
          matching: LEGACY_ROWS,
        });

        // The contract release drops the default (ADR-053 Decision 4). Only
        // pg_attrdef changes: legacy rows keep the stored missing value.
        await qr.query(`ALTER TABLE ${TABLE} ALTER COLUMN ${COLUMN} DROP DEFAULT`);
        expect(await filenodes(qr)).toEqual(before);
        expect(await hasMissingValue(qr)).toBe(true);
        expect(await legacyRowsReading(qr, form.type, expected)).toEqual({
          total: LEGACY_ROWS,
          matching: LEGACY_ROWS,
        });
      });
    },
  );

  it.each(REWRITING_FORMS)('rewrites the table for $label (negative control)', async (form) => {
    await withHarnessSchema(ctx, async (_schema, qr) => {
      for (const statement of form.prepare) await qr.query(statement);
      await createLegacyTable(qr);
      const before = await filenodes(qr);

      await addRewritingColumn(qr, form);

      const after = await filenodes(qr);
      expect(after.table).not.toBe(before.table);
    });
  });
});
