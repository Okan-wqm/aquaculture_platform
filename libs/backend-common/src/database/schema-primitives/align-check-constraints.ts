/**
 * alignCheckConstraints — Class G primitive (entity @Check ↔ pg_constraint).
 * ============================================================================
 *
 * Two-direction heal:
 *
 *   1. Desired-but-absent: caller names a constraint + expression, the
 *      primitive ALTER TABLE ADD CONSTRAINT when pg_constraint lacks it.
 *   2. Present-but-unwanted: caller supplies an allowlistToDrop; the
 *      primitive ALTER TABLE DROP CONSTRAINT only for names on that
 *      list. The primitive NEVER enumerates pg_constraint and drops
 *      anything "extra" — that would be a silent-data-relaxation risk.
 *
 * # Why named constraints only?
 *
 * PG accepts unnamed CHECK constraints (`CHECK (expr)` without `CONSTRAINT
 * name`) and auto-assigns names like `<table>_col_check`. The primitive
 * refuses those because (a) names are load-bearing for this diff, and
 * (b) operators cannot allowlist-drop an auto-named constraint without
 * binding their migration to PG's naming policy.
 *
 * # Predicate normalization
 *
 * The drift detector uses COUNT-based comparison because
 * pg_get_constraintdef() canonicalizes text ('x' IN ('a','b') → `x =
 * ANY(ARRAY['a'::text, 'b'::text])`). This primitive uses NAME as the
 * identity key — matching is exact on constraint name, not expression
 * text. The caller chose the name; the drift detector's count-only
 * signal surfaces divergence; this primitive reconciles.
 */
import type { QueryRunner } from 'typeorm';

import { withDdlSafety } from '../base-migration';
import { executeQueryRowsNormalized } from '../query-result-normalizer';
import { sql, type SqlFragment } from '../sql-fragments';

export interface CheckConstraintSpec {
  /**
   * Constraint name — subject to SAFE_IDENT_RE + 63-char limit.
   * Operators should prefix with the table or domain for uniqueness
   * (PG requires constraint names unique per schema).
   */
  readonly name: string;
  /**
   * Predicate expression — MUST be a SqlFragment. Raw-string predicates
   * are a compile error. The fragment may contain sql.ident() for
   * column references; sql.value() is rarely useful in CHECK (CHECK
   * is DDL, so values typically inline as literals).
   */
  readonly expression: SqlFragment;
}

export interface AlignCheckConstraintsOptions {
  readonly schema: string;
  readonly table: string;
  /**
   * Full desired set of CHECK constraints. Any name absent from DB is
   * ADDed. Expression drift on an existing name IS NOT auto-healed
   * (PG has no CHANGE CONSTRAINT — the caller must DROP + ADD).
   */
  readonly desired: readonly CheckConstraintSpec[];
  /**
   * Constraint names to DROP. Must actually exist in pg_constraint at
   * call time (silently-absent → skipped, idempotent). Must NOT appear
   * in `desired` (ambiguous intent — the caller both wants it and
   * doesn't).
   */
  readonly allowlistToDrop?: readonly string[];
  readonly lockTimeoutMs?: number;
}

export interface AlignCheckConstraintsResult {
  /** Constraints actually ADDed this call. */
  readonly added: readonly string[];
  /** Constraints ADDed previously (no-op). */
  readonly alreadyPresent: readonly string[];
  /** Constraints DROPped via the allowlist. */
  readonly dropped: readonly string[];
  /** Names on the drop-allowlist that were not present (idempotent). */
  readonly dropAlreadyAbsent: readonly string[];
}

export async function alignCheckConstraints(
  qr: QueryRunner,
  opts: AlignCheckConstraintsOptions,
): Promise<AlignCheckConstraintsResult> {
  if (opts.desired.length === 0 && (opts.allowlistToDrop ?? []).length === 0) {
    return {
      added: [],
      alreadyPresent: [],
      dropped: [],
      dropAlreadyAbsent: [],
    };
  }

  const schemaIdent = sql.ident(opts.schema);
  const tableIdent = sql.ident(opts.table);
  for (const c of opts.desired) {
    sql.ident(c.name);
  }
  const dropList = opts.allowlistToDrop ?? [];
  for (const n of dropList) {
    sql.ident(n);
  }

  // Reject ambiguous intent: same name in BOTH desired AND allowlistToDrop.
  const desiredNames = new Set(opts.desired.map((c) => c.name));
  const ambiguous = dropList.filter((n) => desiredNames.has(n));
  if (ambiguous.length > 0) {
    throw new Error(
      `[alignCheckConstraints] name(s) appear in BOTH desired + allowlistToDrop: [${ambiguous.join(', ')}]. ` +
        `Choose one intent per constraint per call.`,
    );
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
      // Fetch existing CHECK constraints on the table.
      const existingRows = await executeQueryRowsNormalized<{ conname: string }>(
        qr,
        `SELECT c.conname
           FROM pg_constraint c
           JOIN pg_class t ON t.oid = c.conrelid
           JOIN pg_namespace n ON n.oid = t.relnamespace
          WHERE n.nspname = $1
            AND t.relname = $2
            AND c.contype = 'c'`,
        [opts.schema, opts.table],
      );
      const existing = new Set(existingRows.map((r) => r.conname));

      const added: string[] = [];
      const alreadyPresent: string[] = [];
      const dropped: string[] = [];
      const dropAlreadyAbsent: string[] = [];

      // ADD missing desired constraints.
      for (const c of opts.desired) {
        if (existing.has(c.name)) {
          alreadyPresent.push(c.name);
          continue;
        }
        const nameIdent = sql.ident(c.name);
        // CHECK predicates are DDL — bound params have limited support.
        // We allow the SqlFragment to carry params (rare but legal in
        // PG, e.g. CHECK (x > $1) evaluated at parse time).
        const stmt =
          `ALTER TABLE ${schemaIdent.quoted}.${tableIdent.quoted} ` +
          `ADD CONSTRAINT ${nameIdent.quoted} CHECK (${c.expression.sql})`;
        await qr.query(stmt, [...c.expression.params]);
        added.push(c.name);
      }

      // DROP allowlisted constraints.
      for (const name of dropList) {
        if (!existing.has(name)) {
          dropAlreadyAbsent.push(name);
          continue;
        }
        const nameIdent = sql.ident(name);
        await qr.query(
          `ALTER TABLE ${schemaIdent.quoted}.${tableIdent.quoted} ` +
            `DROP CONSTRAINT IF EXISTS ${nameIdent.quoted}`,
        );
        dropped.push(name);
      }

      return { added, alreadyPresent, dropped, dropAlreadyAbsent };
    },
  );
}
