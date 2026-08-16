/**
 * alignEnumLabels — Class F primitive (entity enum labels ↔ pg_enum).
 * ============================================================================
 *
 * Additive-only healer for enum drift. Two drift directions:
 *
 *   1. Entity declares labels the DB lacks → ALTER TYPE ADD VALUE
 *      (this primitive handles it).
 *   2. DB has labels the entity lacks → REMOVAL requires explicit
 *      remap. PG cannot drop enum values that are still referenced.
 *      The primitive REFUSES — caller must write an explicit migration
 *      that UPDATEs rows to the new value first.
 *
 * # Why additive-only?
 *
 * `ALTER TYPE foo_enum ADD VALUE 'bar'` is a Tier-1 safe operation
 * (append to the type definition, no row rewrites, no index
 * invalidation). It runs quickly even on hot tables.
 *
 * `DROP VALUE` does NOT exist in PG. Removing a label requires:
 *   a. UPDATE every row using the label to another value (application
 *      semantic — the primitive can't guess).
 *   b. CREATE TYPE new_enum AS ENUM (... without the label).
 *   c. ALTER COLUMN TYPE new_enum USING col::text::new_enum.
 *   d. DROP TYPE old_enum.
 *
 * That sequence is not a "primitive" — it's a multi-step migration
 * with application cooperation. The primitive refuses rather than
 * silently downgrading to a dangerous no-op.
 *
 * # Transaction semantics
 *
 * PG 12+ allows ALTER TYPE ADD VALUE inside a transaction, but the
 * new value is not usable until the transaction commits. The primitive
 * composes with withDdlSafety, which preserves whatever transaction
 * context the QueryRunner carries. Production migrations run inside
 * a tx by default.
 */
import type { QueryRunner } from 'typeorm';

import { withDdlSafety } from '../base-migration';
import { executeQueryRowsNormalized } from '../query-result-normalizer';
import { sql } from '../sql-fragments';

export interface AlignEnumLabelsTarget {
  /** Enum type name (just the type, without schema prefix). */
  readonly typeName: string;
  /** Every label the entity currently declares, in canonical order. */
  readonly entityLabels: readonly string[];
}

export interface AlignEnumLabelsOptions {
  readonly schema: string;
  readonly targets: readonly AlignEnumLabelsTarget[];
  readonly lockTimeoutMs?: number;
}

export interface AlignEnumLabelsResult {
  /** Labels actually added per type (keyed by typeName). */
  readonly added: Readonly<Record<string, readonly string[]>>;
  /** Types already in-sync — zero labels added. */
  readonly inSync: readonly string[];
}

/**
 * Add entity-only labels to every pg_enum in `opts.targets`. Refuses
 * when the DB has labels the entity lacks (Class F removal path is
 * explicit-remap only).
 */
export async function alignEnumLabels(
  qr: QueryRunner,
  opts: AlignEnumLabelsOptions,
): Promise<AlignEnumLabelsResult> {
  if (opts.targets.length === 0) {
    return { added: {}, inSync: [] };
  }

  const schemaIdent = sql.ident(opts.schema);
  for (const t of opts.targets) {
    sql.ident(t.typeName);
    if (t.entityLabels.length === 0) {
      throw new Error(
        `[alignEnumLabels] target '${t.typeName}': entityLabels must be non-empty (got []).`,
      );
    }
    for (const l of t.entityLabels) {
      if (typeof l !== 'string' || l.length === 0) {
        throw new TypeError(
          `[alignEnumLabels] target '${t.typeName}': every label must be a non-empty string.`,
        );
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
      const typeNames = opts.targets.map((t) => t.typeName);

      // Batch-fetch every target enum's current labels in one query.
      const rows = await executeQueryRowsNormalized<{
        type_name: string;
        label: string;
      }>(
        qr,
        `SELECT t.typname AS type_name, e.enumlabel AS label
           FROM pg_type t
           JOIN pg_namespace n ON n.oid = t.typnamespace
           JOIN pg_enum e ON e.enumtypid = t.oid
          WHERE n.nspname = $1
            AND t.typname = ANY($2::text[])
          ORDER BY t.typname, e.enumsortorder`,
        [opts.schema, typeNames],
      );

      const dbLabelsByType = new Map<string, string[]>();
      for (const r of rows) {
        const list = dbLabelsByType.get(r.type_name) ?? [];
        list.push(r.label);
        dbLabelsByType.set(r.type_name, list);
      }

      const added: Record<string, string[]> = {};
      const inSync: string[] = [];

      for (const target of opts.targets) {
        const dbLabels = dbLabelsByType.get(target.typeName);
        if (!dbLabels) {
          throw new Error(
            `[alignEnumLabels] target '${opts.schema}.${target.typeName}': no such pg_enum exists. ` +
              `CREATE TYPE is not a primitive responsibility — author the CREATE TYPE in the migration up() before invoking alignEnumLabels.`,
          );
        }

        const dbSet = new Set(dbLabels);
        const entitySet = new Set(target.entityLabels);
        const missingInDb = target.entityLabels.filter((l) => !dbSet.has(l));
        const missingInEntity = dbLabels.filter((l) => !entitySet.has(l));

        if (missingInEntity.length > 0) {
          // Removal path — refuse.
          throw new Error(
            `[alignEnumLabels] target '${opts.schema}.${target.typeName}': DB has ${missingInEntity.length} label(s) the entity does not declare: [${missingInEntity.join(', ')}]. ` +
              `PG does NOT support DROP VALUE; removal requires an explicit multi-step migration ` +
              `(UPDATE rows using the value → CREATE TYPE without it → ALTER COLUMN TYPE → DROP TYPE). ` +
              `This primitive is additive-only. See docs/runbooks/enum-label-removal.md.`,
          );
        }

        if (missingInDb.length === 0) {
          inSync.push(target.typeName);
          continue;
        }

        // ALTER TYPE ADD VALUE. PG 12+ allows this inside a transaction
        // but the new label is not usable until commit. Labels are
        // inlined as SQL literals using the value-quoting helper below
        // (SqlFragment cannot represent an enum label — ALTER TYPE
        // ADD VALUE syntax expects a literal, not a bound parameter).
        const typeIdent = sql.ident(target.typeName);
        const typeAdded: string[] = [];
        for (const label of missingInDb) {
          const literal = quoteSqlLiteral(label);
          await qr.query(
            `ALTER TYPE ${schemaIdent.quoted}.${typeIdent.quoted} ADD VALUE IF NOT EXISTS ${literal}`,
          );
          typeAdded.push(label);
        }
        added[target.typeName] = typeAdded;
      }

      return { added, inSync };
    },
  );
}

/**
 * PostgreSQL single-quoted literal — doubles embedded single quotes.
 * SqlFragment's `sql.value()` would generate a bound parameter ($N)
 * which PG rejects in ALTER TYPE ADD VALUE (DDL, not DML). We inline
 * the literal with PG's canonical quote-doubling escape.
 */
function quoteSqlLiteral(value: string): string {
  if (typeof value !== 'string') {
    throw new TypeError(`quoteSqlLiteral: expected string, got ${typeof value}`);
  }
  // Reject NULs — PG text cannot contain them regardless.
  if (value.includes('\0')) {
    throw new RangeError(`quoteSqlLiteral: NUL character is not permitted in SQL text literals.`);
  }
  return `'${value.replace(/'/g, "''")}'`;
}
