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
 * import { introspectSchema } from '@aquaculture/backend-common';
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

export interface SchemaSnapshot {
  readonly schema: string;
  readonly tables: readonly IntrospectedTable[];
  readonly enums: readonly IntrospectedEnum[];
  readonly checkConstraints: readonly IntrospectedCheckConstraint[];
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
export async function introspectSchema(
  qr: QueryRunner,
  schema: string,
): Promise<SchemaSnapshot> {
  const [tables, enums, checkConstraints] = await Promise.all([
    introspectTables(qr, schema),
    introspectEnums(qr, schema),
    introspectCheckConstraints(qr, schema),
  ]);
  return {
    schema,
    tables,
    enums,
    checkConstraints,
    capturedAt: new Date().toISOString(),
  };
}

async function introspectTables(
  qr: QueryRunner,
  schema: string,
): Promise<readonly IntrospectedTable[]> {
  const tableRows: Array<{ table_name: string }> = await qr.query(
    `SELECT table_name
       FROM information_schema.tables
      WHERE table_schema = $1 AND table_type = 'BASE TABLE'
      ORDER BY table_name`,
    [schema],
  );

  if (tableRows.length === 0) return [];

  const colRows: Array<{
    table_name: string;
    column_name: string;
    data_type: string;
    is_nullable: 'YES' | 'NO';
    character_maximum_length: number | null;
    ordinal_position: number;
    column_default: string | null;
  }> = await qr.query(
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
  const rows: Array<{
    type_name: string;
    label: string;
    sort_order: number;
  }> = await qr.query(
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
  const rows: Array<{
    conname: string;
    table_name: string;
    definition: string;
  }> = await qr.query(
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
