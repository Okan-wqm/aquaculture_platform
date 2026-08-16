/**
 * dropOrphanedColumns — Class E primitive (DB column not declared on entity).
 * ============================================================================
 *
 * Data-loss operation gated by an explicit allowlist. The primitive
 * DOES NOT enumerate DB-only columns and drop them en masse — that
 * pattern invites the very regression the drift validator was built
 * to catch (silently dropping a column mid-migration). Instead the
 * caller passes an explicit list of column names to drop, the
 * primitive verifies each is actually an orphan (exists in DB, NOT
 * declared on the entity — cross-checked via EntityMetadata), and
 * only then issues ALTER TABLE DROP COLUMN.
 *
 * # Why not introspect entity.columns directly?
 *
 * The primitive takes a DataSource-loaded EntityMetadata rather than
 * just the class because TypeORM needs a connection to resolve column
 * metadata (column.databaseName is only reliable after DataSource
 * initialization). Callers invoke this from a migration where the
 * QueryRunner's connection already owns the metadata.
 *
 * # Refusal contract
 *
 *   - @EncryptedAtRest — never DROP via a primitive. Explicit refusal.
 *   - Column that IS declared on the entity — refuse (not an orphan).
 *   - Column that does not exist in DB — skip (idempotent).
 *   - Column NOT in the caller's allowlist — refuse (the primitive
 *     only drops columns the caller explicitly enumerated).
 */
import type { EntityMetadata, QueryRunner } from 'typeorm';

import { ClassConstructor, isClassConstructor } from '../../types/class-constructor';
import { withDdlSafety } from '../base-migration';
import { getEncryptedAtRestMetadata } from '../encrypted-at-rest.decorator';
import { executeQueryRowsNormalized } from '../query-result-normalizer';
import { sql } from '../sql-fragments';

export interface DropOrphanedColumnsOptions {
  readonly schema: string;
  readonly table: string;
  /**
   * Explicit allowlist of DB column names to drop. Every name must:
   *   1. Pass SAFE_IDENT_RE.
   *   2. Exist in the DB.
   *   3. NOT be declared on the entity (otherwise the caller made a
   *      mistake — the column is NOT an orphan).
   *   4. NOT be @EncryptedAtRest (refusal class).
   */
  readonly allowlist: readonly string[];
  /**
   * EntityMetadata for the table whose orphan columns we're dropping.
   * Used to verify allowlisted names are NOT declared by the entity.
   * The primitive refuses to drop entity-declared columns — that
   * would be a Class D mistake (removing a column the app uses).
   */
  readonly entityMetadata: EntityMetadata;
  /**
   * Optional entity class for @EncryptedAtRest cross-check. Typically
   * === entityMetadata.target but callers passing anonymized metadata
   * may supply it explicitly.
   */
  readonly entity?: ClassConstructor;
  readonly lockTimeoutMs?: number;
}

export interface DropOrphanedColumnsResult {
  /** Column names actually dropped this call. */
  readonly dropped: readonly string[];
  /** Column names that did not exist in the DB (skipped, idempotent). */
  readonly alreadyAbsent: readonly string[];
}

export async function dropOrphanedColumns(
  qr: QueryRunner,
  opts: DropOrphanedColumnsOptions,
): Promise<DropOrphanedColumnsResult> {
  if (opts.allowlist.length === 0) {
    return { dropped: [], alreadyAbsent: [] };
  }

  const schemaIdent = sql.ident(opts.schema);
  const tableIdent = sql.ident(opts.table);
  for (const c of opts.allowlist) {
    sql.ident(c);
  }

  // Refuse if any allowlisted name is actually declared by the entity
  // (would be a Class D drop-by-mistake).
  const entityDbNames = new Set(opts.entityMetadata.columns.map((c) => c.databaseName));
  const notOrphans = opts.allowlist.filter((n) => entityDbNames.has(n));
  if (notOrphans.length > 0) {
    throw new Error(
      `[dropOrphanedColumns] REFUSAL: allowlist contains column(s) that ARE declared on the entity — not orphans: [${notOrphans.join(', ')}]. ` +
        `Dropping a column the application uses would break production. ` +
        `Verify the allowlist against the entity definition.`,
    );
  }

  // @EncryptedAtRest refusal.
  const entityCtor =
    opts.entity ??
    (isClassConstructor(opts.entityMetadata.target) ? opts.entityMetadata.target : undefined);
  if (entityCtor !== undefined) {
    const encrypted = getEncryptedAtRestMetadata(entityCtor);
    if (encrypted.size > 0) {
      const forbidden = new Set<string>();
      for (const meta of encrypted.values()) {
        forbidden.add(meta.propertyKey);
        forbidden.add(toSnakeCase(meta.propertyKey));
      }
      for (const c of opts.allowlist) {
        if (forbidden.has(c)) {
          throw new Error(
            `[dropOrphanedColumns] REFUSAL: column '${c}' is @EncryptedAtRest on the entity. ` +
              `Encrypted columns must not be altered via a schema primitive — ` +
              `key rotation is a separate operator runbook. See ADR-023.`,
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
      // Verify each allowlisted name exists in the DB before DROP.
      const existingRows = await executeQueryRowsNormalized<{ column_name: string }>(
        qr,
        `SELECT column_name FROM information_schema.columns
          WHERE table_schema = $1 AND table_name = $2
            AND column_name = ANY($3::text[])`,
        [opts.schema, opts.table, opts.allowlist],
      );
      const existing = new Set(existingRows.map((r) => r.column_name));

      const dropped: string[] = [];
      const alreadyAbsent: string[] = [];

      for (const col of opts.allowlist) {
        if (!existing.has(col)) {
          alreadyAbsent.push(col);
          continue;
        }
        const colIdent = sql.ident(col);
        // IF EXISTS is belt-and-braces — we just verified presence,
        // but a concurrent DDL could drop it between the check and
        // the ALTER. The IF EXISTS keeps the primitive safe against
        // that race.
        await qr.query(
          `ALTER TABLE ${schemaIdent.quoted}.${tableIdent.quoted} DROP COLUMN IF EXISTS ${colIdent.quoted}`,
        );
        dropped.push(col);
      }

      return { dropped, alreadyAbsent };
    },
  );
}

function toSnakeCase(s: string): string {
  return s
    .replace(/([A-Z])/g, '_$1')
    .replace(/^_+/, '')
    .toLowerCase();
}
