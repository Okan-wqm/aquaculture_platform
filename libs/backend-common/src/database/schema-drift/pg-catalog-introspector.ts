/**
 * pg-catalog-introspector — normalized JSON view of a PostgreSQL schema.
 * ============================================================================
 *
 * Returns a deterministic, ORM-agnostic snapshot of the objects the drift
 * validator + Phase 4 PR-gate both need. Reading pg_catalog directly is
 * faster + more complete than TypeORM's `createSchemaBuilder().log()`
 * (which is known to miss partial-index predicates, EXCLUDE operator
 * classes, and GIN opclass differences — the exact classes that bit us
 * across commits 5df00179 → e83904d2).
 *
 * # Shape coverage (plan v3 R11)
 *
 * This commit introduces 4 shapes (v2-baseline):
 *   1. tables     — every table in the given schema(s)
 *   2. columns    — data_type + is_nullable + character_maximum_length
 *   3. enums      — pg_type + pg_enum joined; label array + sort order
 *   4. check_constraints — CHECK constraints with pg_get_constraintdef
 *
 * Phase 2 Step 3+ adds the remaining 6 shapes:
 *   5. partial_indexes (WHERE predicate via pg_get_expr(indpred))
 *   6. exclude_constraints (operator class via pg_operator)
 *   7. foreign_key_actions (ON DELETE / ON UPDATE / deferrable)
 *   8. generated_columns (attgenerated='s' | 'v')
 *   9. timescale_inheritance (pg_inherits — hypertable chunks)
 *  10. rls_policies (pg_policy per table)
 *
 * # Why 10 shapes, not "everything"
 *
 * The shapes are the EXACT set the 10 drift classes (drift-classes.ts)
 * need. Adding more (triggers, rules, domain types) is over-reach —
 * validator contracts grow when drift bites; never speculatively.
 *
 * # Usage
 *
 * ```ts
 * import { introspectSchema } from '@aquaculture/backend-common/schema-drift';
 *
 * const snapshot = await introspectSchema(queryRunner, 'hr');
 * // snapshot.tables.find(t => t.name === 'payrolls')?.columns
 * // snapshot.enums.find(e => e.name === 'leave_status')?.labels
 * ```
 *
 * The snapshot is stable under repeated calls — identical DB produces
 * byte-identical JSON (labels sorted by pg_enum.enumsortorder,
 * columns by ordinal_position, etc.). Deterministic for hash-equality
 * diffing in Phase 4 PR gate.
 */
import type { QueryRunner } from 'typeorm';

import { executeQueryRowsNormalized } from '../query-result-normalizer';

/** One column within a table. */
export interface IntrospectedColumn {
  readonly name: string;
  /** information_schema.columns.data_type (e.g. 'uuid', 'text'). */
  readonly dataType: string;
  /** 'YES' | 'NO' per information_schema convention. */
  readonly isNullable: 'YES' | 'NO';
  /** NULL for unconstrained text; numeric for varchar(N) etc. */
  readonly characterMaximumLength: number | null;
  readonly ordinalPosition: number;
  /** Default expression as pg_get_expr rendered it. null for no default. */
  readonly columnDefault: string | null;
}

/** One table in the scanned schema. */
export interface IntrospectedTable {
  readonly name: string;
  readonly schema: string;
  readonly columns: readonly IntrospectedColumn[];
}

/** One ENUM type + its labels in declaration order. */
export interface IntrospectedEnum {
  readonly schema: string;
  readonly name: string;
  readonly labels: readonly string[];
}

/** One CHECK constraint. */
export interface IntrospectedCheckConstraint {
  readonly name: string;
  readonly schema: string;
  readonly tableName: string;
  /** pg_get_constraintdef rendering — stable across PG versions. */
  readonly definition: string;
}

/**
 * Partial index — shipped for Class F / post-ALTER-TYPE dependency
 * detection. WHERE predicate is essential: the 2026-04 HR incident
 * was caused by a partial index whose WHERE cast a literal to the
 * OLD enum type, blocking ALTER COLUMN TYPE.
 */
export interface IntrospectedPartialIndex {
  readonly schema: string;
  readonly tableName: string;
  readonly indexName: string;
  /** pg_get_expr(indpred) — renders the WHERE clause. */
  readonly predicate: string;
  /** Index column names in order (pg_attribute). */
  readonly columns: readonly string[];
  /** pg_get_indexdef — stable full definition for hash/diff. */
  readonly definition: string;
}

/**
 * EXCLUDE constraint — pg_constraint contype='x'. Uses operator
 * classes (pg_operator) that TypeORM's schema-builder does NOT emit.
 * Drift here is INVISIBLE to log()-based diffing; only pg_catalog
 * introspection catches it.
 */
export interface IntrospectedExcludeConstraint {
  readonly schema: string;
  readonly tableName: string;
  readonly name: string;
  readonly definition: string;
}

/**
 * Foreign-key action policy — ON DELETE / ON UPDATE / deferrable.
 * TypeORM entities sometimes declare ON DELETE CASCADE but the DB
 * was migrated from an older state where ON DELETE NO ACTION is
 * still in force; information_schema.columns doesn't surface this.
 */
export interface IntrospectedForeignKeyAction {
  readonly schema: string;
  readonly tableName: string;
  readonly constraintName: string;
  /** Columns in the referencing (child) table. */
  readonly columns: readonly string[];
  /** Referenced (parent) table. */
  readonly referencedTable: string;
  /** Referenced (parent) columns. */
  readonly referencedColumns: readonly string[];
  /** 'a' NO ACTION | 'r' RESTRICT | 'c' CASCADE | 'n' SET NULL | 'd' SET DEFAULT. */
  readonly onDelete: 'a' | 'r' | 'c' | 'n' | 'd';
  readonly onUpdate: 'a' | 'r' | 'c' | 'n' | 'd';
  readonly deferrable: boolean;
  readonly initiallyDeferred: boolean;
}

/**
 * Generated / identity column. Different from a DEFAULT —
 * attgenerated='s' marks STORED generated; 'a' ALWAYS identity;
 * 'd' BY DEFAULT identity.
 */
export interface IntrospectedGeneratedColumn {
  readonly schema: string;
  readonly tableName: string;
  readonly columnName: string;
  /** 's' = stored generated, 'a' = always identity, 'd' = by-default identity. */
  readonly kind: 's' | 'a' | 'd';
  /** pg_get_expr(adbin) — the generation expression; null for identity cols. */
  readonly expression: string | null;
}

/**
 * TimescaleDB hypertable inheritance — tracks chunks via pg_inherits.
 * A `chunkCount` jump across snapshots is a data-growth signal; a
 * missing hypertable declaration with chunks present is a
 * `create_hypertable()` regression.
 */
export interface IntrospectedHypertable {
  readonly schema: string;
  readonly tableName: string;
  readonly chunkCount: number;
}

/**
 * RLS policy declaration — pg_policy row for a table. Drift here
 * is catastrophic (RLS silently granting all rows to every tenant
 * when a policy regresses). log() DOES NOT emit these.
 */
export interface IntrospectedRlsPolicy {
  readonly schema: string;
  readonly tableName: string;
  readonly policyName: string;
  /** Permissive or restrictive. */
  readonly permissive: boolean;
  /** Command: 'r' SELECT | 'a' INSERT | 'w' UPDATE | 'd' DELETE | '*' ALL. */
  readonly command: string;
  /** qual expression — pg_get_expr(polqual). */
  readonly usingExpr: string | null;
  /** with-check expression — pg_get_expr(polwithcheck). */
  readonly withCheckExpr: string | null;
}

export interface SchemaSnapshot {
  readonly schema: string;
  readonly tables: readonly IntrospectedTable[];
  readonly enums: readonly IntrospectedEnum[];
  readonly checkConstraints: readonly IntrospectedCheckConstraint[];
  readonly partialIndexes: readonly IntrospectedPartialIndex[];
  readonly excludeConstraints: readonly IntrospectedExcludeConstraint[];
  readonly foreignKeyActions: readonly IntrospectedForeignKeyAction[];
  readonly generatedColumns: readonly IntrospectedGeneratedColumn[];
  readonly hypertables: readonly IntrospectedHypertable[];
  readonly rlsPolicies: readonly IntrospectedRlsPolicy[];
  /** ISO 8601 timestamp the snapshot was captured (debug only). */
  readonly capturedAt: string;
}

/**
 * Produce a deterministic snapshot of every supported object class in
 * the given schema. Safe to call from within a transaction or on an
 * autonomous connection — all queries are read-only.
 *
 * @param qr       Active TypeORM QueryRunner against the DB under test.
 * @param schema   Exact schema name (e.g. 'hr'). No wildcards.
 */
export async function introspectSchema(qr: QueryRunner, schema: string): Promise<SchemaSnapshot> {
  const [
    tables,
    enums,
    checkConstraints,
    partialIndexes,
    excludeConstraints,
    foreignKeyActions,
    generatedColumns,
    hypertables,
    rlsPolicies,
  ] = await Promise.all([
    introspectTables(qr, schema),
    introspectEnums(qr, schema),
    introspectCheckConstraints(qr, schema),
    introspectPartialIndexes(qr, schema),
    introspectExcludeConstraints(qr, schema),
    introspectForeignKeyActions(qr, schema),
    introspectGeneratedColumns(qr, schema),
    introspectHypertables(qr, schema),
    introspectRlsPolicies(qr, schema),
  ]);
  return {
    schema,
    tables,
    enums,
    checkConstraints,
    partialIndexes,
    excludeConstraints,
    foreignKeyActions,
    generatedColumns,
    hypertables,
    rlsPolicies,
    capturedAt: new Date().toISOString(),
  };
}

async function introspectTables(
  qr: QueryRunner,
  schema: string,
): Promise<readonly IntrospectedTable[]> {
  const tableRows = await executeQueryRowsNormalized<{ table_name: string }>(
    qr,
    `SELECT table_name
       FROM information_schema.tables
      WHERE table_schema = $1 AND table_type = 'BASE TABLE'
      ORDER BY table_name`,
    [schema],
  );

  if (tableRows.length === 0) return [];

  const colRows = await executeQueryRowsNormalized<{
    table_name: string;
    column_name: string;
    data_type: string;
    is_nullable: 'YES' | 'NO';
    character_maximum_length: number | null;
    ordinal_position: number;
    column_default: string | null;
  }>(
    qr,
    `SELECT table_name, column_name, data_type, is_nullable,
            character_maximum_length, ordinal_position, column_default
       FROM information_schema.columns
      WHERE table_schema = $1
      ORDER BY table_name, ordinal_position`,
    [schema],
  );

  const columnsByTable = new Map<string, IntrospectedColumn[]>();
  for (const c of colRows) {
    const col: IntrospectedColumn = {
      name: c.column_name,
      dataType: c.data_type,
      isNullable: c.is_nullable,
      characterMaximumLength: c.character_maximum_length,
      ordinalPosition: c.ordinal_position,
      columnDefault: c.column_default,
    };
    const bucket = columnsByTable.get(c.table_name);
    if (bucket) bucket.push(col);
    else columnsByTable.set(c.table_name, [col]);
  }

  return tableRows.map((t) => ({
    name: t.table_name,
    schema,
    columns: Object.freeze(columnsByTable.get(t.table_name) ?? []),
  }));
}

async function introspectEnums(
  qr: QueryRunner,
  schema: string,
): Promise<readonly IntrospectedEnum[]> {
  const rows = await executeQueryRowsNormalized<{
    type_name: string;
    label: string;
    sort_order: number;
  }>(
    qr,
    `SELECT t.typname AS type_name,
            e.enumlabel AS label,
            e.enumsortorder AS sort_order
       FROM pg_type t
       JOIN pg_namespace n ON n.oid = t.typnamespace
       JOIN pg_enum e ON e.enumtypid = t.oid
      WHERE n.nspname = $1
      ORDER BY t.typname, e.enumsortorder`,
    [schema],
  );

  const byType = new Map<string, string[]>();
  for (const r of rows) {
    const bucket = byType.get(r.type_name);
    if (bucket) bucket.push(r.label);
    else byType.set(r.type_name, [r.label]);
  }
  return Array.from(byType.entries()).map(([name, labels]) => ({
    schema,
    name,
    labels: Object.freeze([...labels]),
  }));
}

async function introspectCheckConstraints(
  qr: QueryRunner,
  schema: string,
): Promise<readonly IntrospectedCheckConstraint[]> {
  const rows = await executeQueryRowsNormalized<{
    conname: string;
    table_name: string;
    definition: string;
  }>(
    qr,
    `SELECT c.conname,
            cls.relname AS table_name,
            pg_get_constraintdef(c.oid) AS definition
       FROM pg_constraint c
       JOIN pg_class cls ON cls.oid = c.conrelid
       JOIN pg_namespace n ON n.oid = cls.relnamespace
      WHERE n.nspname = $1
        AND c.contype = 'c'
      ORDER BY cls.relname, c.conname`,
    [schema],
  );
  return rows.map((r) => ({
    name: r.conname,
    schema,
    tableName: r.table_name,
    definition: r.definition,
  }));
}

/**
 * Partial indexes — pg_index.indpred IS NOT NULL rows. Ships the
 * WHERE predicate via pg_get_expr so diff can detect cast-to-OLD-enum
 * patterns before they block ALTER COLUMN TYPE.
 */
async function introspectPartialIndexes(
  qr: QueryRunner,
  schema: string,
): Promise<readonly IntrospectedPartialIndex[]> {
  const rows = await executeQueryRowsNormalized<{
    table_name: string;
    index_name: string;
    predicate: string;
    columns: string[] | null;
    definition: string;
  }>(
    qr,
    `SELECT cls.relname AS table_name,
            idx_cls.relname AS index_name,
            pg_get_expr(i.indpred, i.indrelid) AS predicate,
            (SELECT array_agg(a.attname ORDER BY pos)
               FROM unnest(i.indkey) WITH ORDINALITY AS k(attnum, pos)
               LEFT JOIN pg_attribute a
                 ON a.attrelid = i.indrelid AND a.attnum = k.attnum)
              AS columns,
            pg_get_indexdef(i.indexrelid) AS definition
       FROM pg_index i
       JOIN pg_class cls ON cls.oid = i.indrelid
       JOIN pg_class idx_cls ON idx_cls.oid = i.indexrelid
       JOIN pg_namespace n ON n.oid = cls.relnamespace
      WHERE n.nspname = $1
        AND i.indpred IS NOT NULL
      ORDER BY cls.relname, idx_cls.relname`,
    [schema],
  );
  return rows.map((r) => ({
    schema,
    tableName: r.table_name,
    indexName: r.index_name,
    predicate: r.predicate,
    columns: Object.freeze(r.columns ?? []),
    definition: r.definition,
  }));
}

/**
 * EXCLUDE constraints — pg_constraint contype='x'. pg_get_constraintdef
 * renders operator-class-aware definition (e.g. EXCLUDE USING gist).
 */
async function introspectExcludeConstraints(
  qr: QueryRunner,
  schema: string,
): Promise<readonly IntrospectedExcludeConstraint[]> {
  const rows = await executeQueryRowsNormalized<{
    conname: string;
    table_name: string;
    definition: string;
  }>(
    qr,
    `SELECT c.conname,
            cls.relname AS table_name,
            pg_get_constraintdef(c.oid) AS definition
       FROM pg_constraint c
       JOIN pg_class cls ON cls.oid = c.conrelid
       JOIN pg_namespace n ON n.oid = cls.relnamespace
      WHERE n.nspname = $1
        AND c.contype = 'x'
      ORDER BY cls.relname, c.conname`,
    [schema],
  );
  return rows.map((r) => ({
    schema,
    tableName: r.table_name,
    name: r.conname,
    definition: r.definition,
  }));
}

/**
 * Foreign-key action policies — pg_constraint contype='f'. Emits
 * confdeltype + confupdtype + deferrability for every FK in the
 * schema. Referenced parent may live in ANY schema; we include the
 * parent relation fully for diff stability.
 */
async function introspectForeignKeyActions(
  qr: QueryRunner,
  schema: string,
): Promise<readonly IntrospectedForeignKeyAction[]> {
  const rows = await executeQueryRowsNormalized<{
    conname: string;
    table_name: string;
    columns: string[] | null;
    ref_table: string;
    ref_columns: string[] | null;
    on_delete: string;
    on_update: string;
    deferrable: boolean;
    initially_deferred: boolean;
  }>(
    qr,
    `SELECT c.conname,
            cls.relname AS table_name,
            (SELECT array_agg(a.attname ORDER BY pos)
               FROM unnest(c.conkey) WITH ORDINALITY AS k(attnum, pos)
               LEFT JOIN pg_attribute a
                 ON a.attrelid = c.conrelid AND a.attnum = k.attnum)
              AS columns,
            ref_cls.relname AS ref_table,
            (SELECT array_agg(a.attname ORDER BY pos)
               FROM unnest(c.confkey) WITH ORDINALITY AS k(attnum, pos)
               LEFT JOIN pg_attribute a
                 ON a.attrelid = c.confrelid AND a.attnum = k.attnum)
              AS ref_columns,
            c.confdeltype::text AS on_delete,
            c.confupdtype::text AS on_update,
            c.condeferrable AS deferrable,
            c.condeferred  AS initially_deferred
       FROM pg_constraint c
       JOIN pg_class cls ON cls.oid = c.conrelid
       JOIN pg_class ref_cls ON ref_cls.oid = c.confrelid
       JOIN pg_namespace n ON n.oid = cls.relnamespace
      WHERE n.nspname = $1
        AND c.contype = 'f'
      ORDER BY cls.relname, c.conname`,
    [schema],
  );
  return rows.map((r) => ({
    schema,
    tableName: r.table_name,
    constraintName: r.conname,
    columns: Object.freeze(r.columns ?? []),
    referencedTable: r.ref_table,
    referencedColumns: Object.freeze(r.ref_columns ?? []),
    onDelete: r.on_delete as 'a' | 'r' | 'c' | 'n' | 'd',
    onUpdate: r.on_update as 'a' | 'r' | 'c' | 'n' | 'd',
    deferrable: r.deferrable,
    initiallyDeferred: r.initially_deferred,
  }));
}

/**
 * Generated + identity columns — pg_attribute.attgenerated is 's'
 * for STORED generated; pg_attribute.attidentity is 'a' ALWAYS /
 * 'd' BY DEFAULT for identity columns. A column may be ONE of the
 * two (never both); we emit one row per non-default attribute.
 */
async function introspectGeneratedColumns(
  qr: QueryRunner,
  schema: string,
): Promise<readonly IntrospectedGeneratedColumn[]> {
  const rows = await executeQueryRowsNormalized<{
    table_name: string;
    column_name: string;
    attgenerated: string;
    attidentity: string;
    expression: string | null;
  }>(
    qr,
    `SELECT cls.relname AS table_name,
            a.attname AS column_name,
            a.attgenerated::text AS attgenerated,
            a.attidentity::text AS attidentity,
            pg_get_expr(ad.adbin, a.attrelid) AS expression
       FROM pg_attribute a
       JOIN pg_class cls ON cls.oid = a.attrelid
       JOIN pg_namespace n ON n.oid = cls.relnamespace
       LEFT JOIN pg_attrdef ad
         ON ad.adrelid = a.attrelid AND ad.adnum = a.attnum
      WHERE n.nspname = $1
        AND a.attnum > 0
        AND NOT a.attisdropped
        AND cls.relkind = 'r'
        AND (a.attgenerated <> '' OR a.attidentity <> '')
      ORDER BY cls.relname, a.attnum`,
    [schema],
  );
  return rows.map((r) => {
    // attgenerated takes precedence — a stored-generated column
    // cannot also be identity. When attgenerated is empty, fall
    // back to attidentity ('a' | 'd').
    const kind: 's' | 'a' | 'd' = r.attgenerated === 's' ? 's' : r.attidentity === 'a' ? 'a' : 'd';
    return {
      schema,
      tableName: r.table_name,
      columnName: r.column_name,
      kind,
      expression: r.expression,
    };
  });
}

/**
 * TimescaleDB hypertable chunks — surfaced via pg_inherits. If the
 * timescaledb extension isn't installed or the schema has no
 * hypertables, returns empty. Uses a catalog-only query (no
 * timescaledb.hypertables view dependency) so it works on baseline PG.
 */
async function introspectHypertables(
  qr: QueryRunner,
  schema: string,
): Promise<readonly IntrospectedHypertable[]> {
  // timescaledb chunks are inheritance children in the `_timescaledb_internal`
  // namespace whose parent relation lives in the user's schema. Count
  // distinct parents.
  try {
    const rows = await executeQueryRowsNormalized<{
      table_name: string;
      chunk_count: string;
    }>(
      qr,
      `SELECT parent_cls.relname AS table_name,
                COUNT(*)::text AS chunk_count
           FROM pg_inherits i
           JOIN pg_class parent_cls ON parent_cls.oid = i.inhparent
           JOIN pg_namespace parent_ns
             ON parent_ns.oid = parent_cls.relnamespace
           JOIN pg_class child_cls ON child_cls.oid = i.inhrelid
           JOIN pg_namespace child_ns
             ON child_ns.oid = child_cls.relnamespace
          WHERE parent_ns.nspname = $1
            AND child_ns.nspname = '_timescaledb_internal'
          GROUP BY parent_cls.relname
          ORDER BY parent_cls.relname`,
      [schema],
    );
    return rows.map((r) => ({
      schema,
      tableName: r.table_name,
      chunkCount: Number.parseInt(r.chunk_count, 10),
    }));
  } catch {
    // timescaledb extension absent or `_timescaledb_internal` namespace
    // missing — not a hypertable-using schema. Return empty, not throw.
    return [];
  }
}

/**
 * RLS policies — pg_policy rows per table in the schema.
 */
async function introspectRlsPolicies(
  qr: QueryRunner,
  schema: string,
): Promise<readonly IntrospectedRlsPolicy[]> {
  const rows = await executeQueryRowsNormalized<{
    table_name: string;
    policy_name: string;
    permissive: string;
    command: string;
    using_expr: string | null;
    with_check_expr: string | null;
  }>(
    qr,
    `SELECT cls.relname AS table_name,
            p.polname AS policy_name,
            p.polpermissive::text AS permissive,
            p.polcmd::text AS command,
            pg_get_expr(p.polqual, p.polrelid) AS using_expr,
            pg_get_expr(p.polwithcheck, p.polrelid) AS with_check_expr
       FROM pg_policy p
       JOIN pg_class cls ON cls.oid = p.polrelid
       JOIN pg_namespace n ON n.oid = cls.relnamespace
      WHERE n.nspname = $1
      ORDER BY cls.relname, p.polname`,
    [schema],
  );
  return rows.map((r) => ({
    schema,
    tableName: r.table_name,
    policyName: r.policy_name,
    permissive: r.permissive === 't' || r.permissive === 'true' || r.permissive === '1',
    command: r.command,
    usingExpr: r.using_expr,
    withCheckExpr: r.with_check_expr,
  }));
}
