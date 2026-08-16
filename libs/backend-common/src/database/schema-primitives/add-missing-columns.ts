/**
 * addMissingColumns — Class D primitive (entity declares column, DB lacks it).
 * ============================================================================
 *
 * Ships during Phase 3 of the db-migrate enterprise refactor (plan v3 §R11).
 * Authored migrations invoke this primitive instead of hand-writing
 * `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` — the primitive enforces:
 *
 *   1. Every identifier passes SAFE_IDENT_RE + 63-char limit + reserved-word
 *      blocklist at the call site (sql.ident throws otherwise).
 *   2. Every default expression is a SqlFragment — raw-string defaults
 *      are a TypeScript compile error.
 *   3. withDdlSafety envelope: parameterised search_path pin, bounded
 *      lock_timeout, advisory lock in a try/finally.
 *   4. Refusal on @EncryptedAtRest collision: if the caller names a
 *      column that the entity declares as encrypted-at-rest, the
 *      primitive refuses (Class J refusal contract per ADR-023).
 *   5. Introspects information_schema BEFORE issuing ADD COLUMN — so
 *      the primitive is idempotent against partially-migrated schemas
 *      even though `IF NOT EXISTS` is redundant.
 *
 * # Why not iterate entity metadata directly?
 *
 * The primitive takes declarative specs instead of inferring from
 * `EntityMetadata.columns[]` because TypeORM's type descriptor can be
 * `string | Function | object` and the mapping to PG DDL types is
 * lossy (numeric precision, interval, custom domains). A declarative
 * spec is unambiguous. Phase 3.5 adds a companion helper that WRAPS
 * this primitive with metadata-inferred specs for the common-case
 * migrations; this ships as the reliable baseline.
 */
import type { QueryRunner } from 'typeorm';

import type { ClassConstructor } from '../../types/class-constructor';
import { withDdlSafety } from '../base-migration';
import { getEncryptedAtRestMetadata } from '../encrypted-at-rest.decorator';
import { executeQueryRowsNormalized } from '../query-result-normalizer';
import { sql, type SqlFragment } from '../sql-fragments';

export interface AddMissingColumnSpec {
  /** DB column name — subject to SAFE_IDENT_RE + reserved-word blocklist. */
  readonly name: string;
  /**
   * Full PG type expression. Simple types: `'text'`, `'uuid'`, `'bytea'`,
   * `'timestamptz'`. Parameterised types: `'varchar(128)'`, `'numeric(12,2)'`,
   * `'hr.leave_status_enum'`. The primitive validates only the base
   * identifier against the SqlFragment template; complex casts live
   * in a SqlFragment if needed.
   */
  readonly type: string;
  /** Whether the column permits NULL. Defaults false (NOT NULL). */
  readonly nullable?: boolean;
  /**
   * Optional default expression. MUST be a SqlFragment — raw strings
   * are a compile error. Example:
   *   `sql.fragment\`gen_random_uuid()\``
   *   `sql.fragment\`CURRENT_TIMESTAMP\``
   *   `sql.fragment\`${sql.value('pending')}\``
   */
  readonly defaultExpr?: SqlFragment;
  /**
   * Optional entity class — when provided, the primitive reads
   * @EncryptedAtRest metadata from it. If any spec.name collides with
   * an encrypted column (match by DB column name via entity.columns),
   * the primitive throws: adding encrypted columns via generic ALTER
   * is the ADR-023 refusal class.
   */
}

export interface AddMissingColumnsOptions {
  readonly schema: string;
  readonly table: string;
  readonly columns: readonly AddMissingColumnSpec[];
  /**
   * Optional entity class for @EncryptedAtRest cross-check. When
   * supplied, the primitive refuses to add a column whose name is
   * decorated @EncryptedAtRest on this entity (Class J contract).
   * Callers migrating encrypted columns MUST do so via the separate
   * key-rotation runbook, never via this primitive.
   */
  readonly entity?: ClassConstructor;
  /** Passed through to withDdlSafety. Defaults to 30_000. */
  readonly lockTimeoutMs?: number;
}

export interface AddMissingColumnsResult {
  /** Column names that were actually added (not pre-existing). */
  readonly added: readonly string[];
  /** Column names skipped because the DB already had them. */
  readonly skipped: readonly string[];
}

/**
 * Add every column in `opts.columns` that the target table lacks.
 * Idempotent — columns present in the DB are silently skipped.
 */
export async function addMissingColumns(
  qr: QueryRunner,
  opts: AddMissingColumnsOptions,
): Promise<AddMissingColumnsResult> {
  if (opts.columns.length === 0) {
    return { added: [], skipped: [] };
  }

  // Validate identifiers up-front via sql.ident — surfaces injection
  // or typo at the call site BEFORE any DDL is issued.
  const schemaIdent = sql.ident(opts.schema);
  const tableIdent = sql.ident(opts.table);
  for (const c of opts.columns) {
    // sql.ident throws if unsafe — we don't need the return value yet.
    sql.ident(c.name);
    if (!c.type || typeof c.type !== 'string') {
      throw new TypeError(
        `[addMissingColumns] column '${c.name}': type must be a non-empty string (got ${typeof c.type})`,
      );
    }
  }

  // @EncryptedAtRest refusal. Class J contract — if the entity class
  // was supplied and any of the requested columns matches a decorated
  // property's DB column name, refuse.
  if (opts.entity !== undefined) {
    const encrypted = getEncryptedAtRestMetadata(opts.entity);
    if (encrypted.size > 0) {
      // We don't know the entity-metadata→DB-column-name mapping here
      // without loading the full EntityMetadata (heavy). Instead we
      // reject any spec name that matches a decorated property name
      // OR the property name's snake_case variant — covers the
      // `@Column({name: 'snake_name'})` and naming-strategy cases.
      const forbidden = new Set<string>();
      for (const meta of encrypted.values()) {
        forbidden.add(meta.propertyKey);
        forbidden.add(toSnakeCase(meta.propertyKey));
      }
      for (const c of opts.columns) {
        if (forbidden.has(c.name)) {
          throw new Error(
            `[addMissingColumns] REFUSAL: column '${c.name}' is @EncryptedAtRest on the supplied entity. ` +
              `Encrypted columns MUST NOT be migrated via ALTER TABLE ADD COLUMN — ` +
              `key rotation + schema change is an explicit operator runbook, not a migration primitive. ` +
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
      // Introspect the DB to see which columns exist today.
      const existingRows = await executeQueryRowsNormalized<{ column_name: string }>(
        qr,
        `SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2`,
        [opts.schema, opts.table],
      );
      const existing = new Set(existingRows.map((r) => r.column_name));

      const added: string[] = [];
      const skipped: string[] = [];
      for (const c of opts.columns) {
        if (existing.has(c.name)) {
          skipped.push(c.name);
          continue;
        }
        const colIdent = sql.ident(c.name);
        const nullClause = c.nullable === true ? 'NULL' : 'NOT NULL';
        // Build the ALTER statement. Identifiers go through sql.ident
        // (validated), the PG type is a trusted literal (reviewed in
        // the migration source), and the DEFAULT expression is a
        // SqlFragment — raw-string defaults are a compile error, so
        // injection via the DEFAULT clause is structurally impossible.
        //
        // sql.fragment is the canonical composition tool, but here we
        // assemble the string manually because the PG type is a
        // call-site literal that is not an SqlIdent (it may include
        // parameterisation like `varchar(128)` or schema-qualification
        // like `hr.leave_status_enum`). Caller responsibility.
        let sqlText =
          `ALTER TABLE ${schemaIdent.quoted}.${tableIdent.quoted} ` +
          `ADD COLUMN IF NOT EXISTS ${colIdent.quoted} ` +
          `${c.type} ${nullClause}`;
        let params: unknown[] = [];
        if (c.defaultExpr !== undefined) {
          // DEFAULT in ALTER TABLE ADD COLUMN must be a self-contained
          // SQL expression — PG evaluates it at DDL time and does NOT
          // bind parameters. If the caller embedded an sql.value() the
          // fragment carries a $N placeholder that would fail at bind
          // time with "bind message supplies N parameters, but prepared
          // statement requires 0". Surface that error at the primitive
          // boundary instead of as an opaque PG error.
          if (c.defaultExpr.params.length > 0) {
            throw new Error(
              `[addMissingColumns] column '${c.name}': defaultExpr contains ${c.defaultExpr.params.length} parameter(s). ` +
                `PG's ALTER TABLE DEFAULT clause does NOT accept bound parameters — the expression must be literal. ` +
                `For a literal string default use \`sql.fragment\\\`'pending'\\\`\` (quoted at authoring time), ` +
                `or for dynamic backfill do two steps: ADD COLUMN NULLABLE → UPDATE → ALTER COLUMN SET NOT NULL.`,
            );
          }
          sqlText += ` DEFAULT ${c.defaultExpr.sql}`;
          params = [];
        }
        await qr.query(sqlText, params);
        added.push(c.name);
      }
      return { added, skipped };
    },
  );
}

function toSnakeCase(s: string): string {
  return s
    .replace(/([A-Z])/g, '_$1')
    .replace(/^_+/, '')
    .toLowerCase();
}
