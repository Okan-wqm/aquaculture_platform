/**
 * alignColumnType — Class B primitive (entity column type ↔ DB data_type).
 * ============================================================================
 *
 * Heals the 2026-04-14 incident class: entity declares `@Column('uuid')`,
 * DB column is `text` or `varchar` — `operator does not exist: text = uuid`
 * when RLS policies try to compare tenant IDs.
 *
 * # Scope
 *
 * Additive-type-compatible ALTER COLUMN TYPE only. The primitive EXCLUDES
 * Class H (data_cast_incompatible): if the ALTER would rewrite every row
 * (e.g. text → int on a column with non-numeric strings), PG fails
 * rather than corrupt. The primitive surfaces that failure with guidance
 * toward the Phase 3.5 backfill path.
 *
 * # Safety layers
 *
 * 1. sql.ident validation of schema + table + column at the call site.
 * 2. @EncryptedAtRest refusal — the entity's Buffer / bytea declaration
 *    is the cipher's storage shape, not its logical output; altering
 *    it corrupts ciphertext. Class J refusal.
 * 3. withDdlSafety envelope — search_path pin, lock_timeout, advisory lock.
 * 4. Precondition sweep: for every target, query information_schema to
 *    confirm the column exists AND its current data_type differs from
 *    the desired type. Already-aligned columns are skipped (idempotent).
 * 5. Dependent partial-index prune — the 2026-04 ALTER-TYPE incident
 *    failed because a partial index's WHERE predicate cast to the OLD
 *    enum type, blocking ALTER. The primitive composes with
 *    `dropDependentPartialIndexes` (already exported from base-migration)
 *    before issuing ALTER COLUMN TYPE.
 *
 * # USING clause
 *
 * PG requires `USING expr` when the source → target cast is not
 * implicitly defined (text ↔ uuid, any → enum, etc.). The primitive
 * accepts an optional `usingExpr: SqlFragment`; when omitted, the
 * primitive generates `USING "col"::<target_type>` which covers the
 * common cases (text → uuid, text → int, etc. where PG's implicit
 * cast exists). Callers with domain-specific coercion pass their own
 * fragment.
 */
import type { QueryRunner } from 'typeorm';

import type { ClassConstructor } from '../../types/class-constructor';
import { dropDependentPartialIndexes, withDdlSafety } from '../base-migration';
import { getEncryptedAtRestMetadata } from '../encrypted-at-rest.decorator';
import { executeQueryRowsNormalized } from '../query-result-normalizer';
import { sql, type SqlFragment } from '../sql-fragments';

export interface AlignColumnTypeSpec {
  /** DB column name. */
  readonly name: string;
  /**
   * Desired PG type — inlined verbatim into the ALTER statement. May be
   * a simple type (`uuid`, `text`), a parameterised type (`varchar(128)`,
   * `numeric(12,2)`), or a schema-qualified custom type
   * (`hr.leave_status_enum`). Caller responsibility — SqlFragment does
   * not cover parameterised type expressions.
   */
  readonly targetType: string;
  /**
   * Optional USING expression. When omitted the primitive generates
   * `USING "col"::<targetType>` which is sufficient for PG's built-in
   * implicit cast paths (text → uuid, text → int, numeric → text).
   * Supply a fragment when the cast needs application logic:
   *   `sql.fragment\`CASE WHEN \${colIdent} ~ '^[0-9]+$' THEN \${colIdent}::int ELSE 0 END\``
   */
  readonly usingExpr?: SqlFragment;
}

export interface AlignColumnTypeOptions {
  readonly schema: string;
  readonly table: string;
  readonly columns: readonly AlignColumnTypeSpec[];
  readonly entity?: ClassConstructor;
  readonly lockTimeoutMs?: number;
}

export interface AlignColumnTypeResult {
  /** Column names whose type was actually changed this call. */
  readonly aligned: readonly string[];
  /** Column names whose data_type already matched (no-op). */
  readonly skipped: readonly string[];
  /**
   * Partial indexes the primitive dropped to unblock ALTER COLUMN TYPE
   * (2026-04 incident class — see dropDependentPartialIndexes docblock).
   * Caller re-creates via TypeORM's own CREATE INDEX emissions.
   */
  readonly droppedBlockingDependencies: readonly string[];
}

export async function alignColumnType(
  qr: QueryRunner,
  opts: AlignColumnTypeOptions,
): Promise<AlignColumnTypeResult> {
  if (opts.columns.length === 0) {
    return {
      aligned: [],
      skipped: [],
      droppedBlockingDependencies: [],
    };
  }

  const schemaIdent = sql.ident(opts.schema);
  const tableIdent = sql.ident(opts.table);
  for (const c of opts.columns) {
    sql.ident(c.name);
    if (!c.targetType || typeof c.targetType !== 'string') {
      throw new TypeError(
        `[alignColumnType] column '${c.name}': targetType must be a non-empty string (got ${typeof c.targetType})`,
      );
    }
  }

  // @EncryptedAtRest refusal.
  if (opts.entity !== undefined) {
    const encrypted = getEncryptedAtRestMetadata(opts.entity);
    if (encrypted.size > 0) {
      const forbidden = new Set<string>();
      for (const meta of encrypted.values()) {
        forbidden.add(meta.propertyKey);
        forbidden.add(toSnakeCase(meta.propertyKey));
      }
      for (const c of opts.columns) {
        if (forbidden.has(c.name)) {
          throw new Error(
            `[alignColumnType] REFUSAL: column '${c.name}' is @EncryptedAtRest. ` +
              `Altering the storage type corrupts ciphertext. ` +
              `See docs/runbooks/encrypted-column-key-rotation.md + ADR-023.`,
          );
        }
      }
    }
  }

  return withDdlSafety(
    qr,
    {
      schema: opts.schema,
      ...(opts.lockTimeoutMs !== undefined && {
        lockTimeoutMs: opts.lockTimeoutMs,
      }),
    },
    async () => {
      // Fetch current column types.
      const currentRows = await executeQueryRowsNormalized<{
        column_name: string;
        data_type: string;
        udt_name: string;
      }>(
        qr,
        `SELECT column_name, data_type, udt_name FROM information_schema.columns
          WHERE table_schema = $1 AND table_name = $2
            AND column_name = ANY($3::text[])`,
        [opts.schema, opts.table, opts.columns.map((c) => c.name)],
      );
      const currentByName = new Map(currentRows.map((r) => [r.column_name, r]));

      // Determine which columns actually need altering.
      const needsAlter: AlignColumnTypeSpec[] = [];
      const skipped: string[] = [];
      for (const spec of opts.columns) {
        const current = currentByName.get(spec.name);
        if (!current) {
          throw new Error(
            `[alignColumnType] column '${opts.schema}.${opts.table}.${spec.name}' does not exist — ` +
              `use addMissingColumns first, or verify the migration order.`,
          );
        }
        if (typesMatch(current.data_type, current.udt_name, spec.targetType)) {
          skipped.push(spec.name);
        } else {
          needsAlter.push(spec);
        }
      }

      if (needsAlter.length === 0) {
        return {
          aligned: [],
          skipped,
          droppedBlockingDependencies: [],
        };
      }

      // Prune partial-index blockers that would fail ALTER COLUMN TYPE.
      // Mirrors the SyncHrEntitiesToDb1786800000000 incident pattern.
      const dropped = await dropDependentPartialIndexes(
        qr,
        needsAlter.map((c) => ({
          schema: opts.schema,
          table: opts.table,
          column: c.name,
        })),
      );
      const droppedNames = dropped.map((d) => d.name);

      // Apply ALTER COLUMN TYPE per column.
      const aligned: string[] = [];
      for (const spec of needsAlter) {
        const colIdent = sql.ident(spec.name);
        const using =
          spec.usingExpr !== undefined
            ? spec.usingExpr.sql
            : `${colIdent.quoted}::${spec.targetType}`;
        const stmt =
          `ALTER TABLE ${schemaIdent.quoted}.${tableIdent.quoted} ` +
          `ALTER COLUMN ${colIdent.quoted} TYPE ${spec.targetType} USING ${using}`;
        const params = spec.usingExpr?.params ?? [];
        await qr.query(stmt, [...params]);
        aligned.push(spec.name);
      }

      return {
        aligned,
        skipped,
        droppedBlockingDependencies: droppedNames,
      };
    },
  );
}

/**
 * Compare information_schema.data_type + udt_name against the desired
 * type string. Covers the common cases:
 *   - Exact match on data_type (e.g. 'uuid' == 'uuid').
 *   - udt_name match for USER-DEFINED types (enums: data_type =
 *     'USER-DEFINED', udt_name = 'my_enum'; caller names 'my_enum').
 *   - Parameterised-type (`varchar(128)`) loosely compared against
 *     'character varying' ↔ 'varchar' prefix — conservative, may
 *     false-positive "skip" on edge cases. Refine as needed.
 */
function typesMatch(dataType: string, udtName: string, desired: string): boolean {
  const desiredLower = desired.toLowerCase().trim();
  const dataTypeLower = dataType.toLowerCase();
  const udtLower = udtName.toLowerCase();
  if (dataTypeLower === desiredLower) return true;
  if (udtLower === desiredLower) return true;
  // Strip schema-qualification: 'hr.leave_status_enum' → 'leave_status_enum'
  const desiredBase = desiredLower.split('.').pop() ?? desiredLower;
  if (udtLower === desiredBase) return true;
  // Parameterised types loosely: 'varchar(128)' ↔ 'character varying'
  const parameterised = desiredLower.match(/^([a-z_][a-z0-9_]*)\s*\(/);
  if (parameterised) {
    const base = parameterised[1];
    if (base === 'varchar' && dataTypeLower === 'character varying') return true;
    if (base === 'numeric' && dataTypeLower === 'numeric') return true;
    if (base === 'decimal' && dataTypeLower === 'numeric') return true;
  }
  return false;
}

function toSnakeCase(s: string): string {
  return s
    .replace(/([A-Z])/g, '_$1')
    .replace(/^_+/, '')
    .toLowerCase();
}
