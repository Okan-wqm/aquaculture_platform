/**
 * SQL Fragments — Compile-Time SQL Injection Prevention
 * ===========================================================================
 *
 * Branded types + a minimal tagged-template API that make raw-string SQL
 * interpolation a **TypeScript compile error** rather than a runtime
 * vulnerability.
 *
 * # The problem this solves
 *
 * Today's migration primitives interpolate identifiers directly:
 *
 *   await qr.query(`ALTER TABLE "${schema}"."${table}" ALTER COLUMN "${col}" …`);
 *
 * This is safe ONLY if `schema`, `table`, `col` have already been
 * validated against SAFE_IDENT_RE. In practice authors forget, regexes
 * drift, and upstream sources change (e.g. `information_schema.schemata`
 * as the tenant source — see Phase 6 fan-out).
 *
 * Worse, the `backfillColumn(expr: string)` and `alignEnumLabels({
 * remapTo: Record<string, string> })` primitives planned in v2 accept
 * SQL expressions and enum-label values — these must pass through as
 * SQL, so SAFE_IDENT_RE doesn't apply. A malicious migration author
 * (or compromised dep) can embed `'; GRANT ALL ...` and the primitive
 * cheerfully forwards it.
 *
 * # The fix — branded types
 *
 * Raw `string` cannot satisfy the `SqlIdent` or `SqlFragment` interface:
 *
 *   function alterColumn(schema: SqlIdent, col: SqlIdent): SqlFragment { … }
 *
 *   alterColumn('hr', 'status');              // TS ERROR: string not assignable to SqlIdent
 *   alterColumn(sql.ident('hr'), sql.ident('status')); // OK — validated at construction
 *
 * `sql.ident(name)` validates against SAFE_IDENT_RE and brands the
 * result. `sql.value(v)` parameterizes. `sql.fragment` is a tagged-
 * template builder that only accepts SqlIdent/SqlValue interpolations;
 * a bare string in the interpolation position is a compile error.
 *
 * This is the Tier-1 "make-impossible" guarantee per CLAUDE.md — not
 * "we remember to validate at every callsite" (Tier-3 detect-it), but
 * "the compiler refuses to compile the unsafe code" (Tier-1 make-
 * impossible).
 *
 * # Relation to existing code
 *
 * This util is NEW. Existing migrations / primitives
 * (libs/backend-common/src/database/base-migration.ts) continue to use
 * string interpolation — they're green, tested, and shipping. This
 * file defines the contract; Phase 3 of the enterprise-refactor plan
 * migrates primitives to consume these types.
 *
 * Adoption is incremental:
 *   1. Ship this file (this commit). Zero callers.
 *   2. Phase 3 rewrites primitives to accept SqlIdent/SqlFragment.
 *   3. Phase 3 callers migrate one-by-one; raw-string calls become TS
 *      compile errors surfaced in CI.
 *   4. Legacy string-interpolation code stays as dead paths until
 *      Phase 9 removal.
 *
 * # What this file does NOT replace
 *
 * - Parameterised queries (`qr.query(sql, [params])`) — orthogonal
 *   mechanism for VALUES; this file is for IDENTIFIERS + composable
 *   SQL FRAGMENTS.
 * - ORM query builders — use TypeORM `Repository.createQueryBuilder`
 *   for typical read/write paths. This utility is for DDL + raw SQL.
 *
 * See plan v3 R2 + R1 (set_config for search_path) + ADR-023.
 */

/**
 * Brand marker symbols. These are REAL runtime symbols (not
 * `declare const`-phantom) because we use them as property keys on
 * the constructed objects — the runtime guard functions check
 * `obj[SQL_IDENT_BRAND] === true`.
 *
 * Not exported — the only way to get a value whose symbol-key is
 * `true` is to call sql.ident() / sql.value() / sql.fragment(),
 * both of which validate inputs.
 */
const SQL_IDENT_BRAND: unique symbol = Symbol('SqlIdent');
const SQL_VALUE_BRAND: unique symbol = Symbol('SqlValue');
const SQL_FRAGMENT_BRAND: unique symbol = Symbol('SqlFragment');

/**
 * A quoted PostgreSQL identifier (schema, table, column, sequence, etc.).
 *
 * Always rendered as `"<name>"` in the final SQL — the double-quote
 * wrapping is part of the brand's invariant, NOT something the caller
 * must remember. `sql.ident('hr')` → renders as `"hr"`.
 */
export interface SqlIdent {
  readonly [SQL_IDENT_BRAND]: true;
  readonly quoted: string; // `"hr"` (includes quotes)
  readonly raw: string; // `hr` (no quotes) — for comparison only
}

/**
 * A parameterised SQL value. Carries the value + a placeholder index
 * that the consuming query runner resolves to `$1`, `$2`, etc.
 */
export interface SqlValue {
  readonly [SQL_VALUE_BRAND]: true;
  readonly value: unknown;
}

/**
 * A composable SQL fragment: one or more identifier-or-value references
 * interleaved with literal SQL text. Fragments compose into larger
 * fragments via `sql.fragment` — interpolation slots ONLY accept
 * SqlIdent | SqlValue | SqlFragment. A raw `string` interpolation is
 * a TypeScript compile error.
 *
 * `qr.query(fragment.sql, fragment.params)` is the final execution
 * step at the QueryRunner boundary.
 */
export interface SqlFragment {
  readonly [SQL_FRAGMENT_BRAND]: true;
  readonly sql: string; // with $1, $2, ... placeholders
  readonly params: readonly unknown[];
}

/**
 * SAFE_IDENT_RE — kept in sync with the same regex used by:
 *   - libs/backend-common/src/database/migration-runner/migration-runner.service.ts
 *   - libs/backend-common/src/database/base-migration.ts
 *   - apps/db-migrate/src/migration-orchestrator.ts
 *
 * Matches `[a-zA-Z_][a-zA-Z0-9_]*` — PostgreSQL accepts more but we
 * deliberately narrow to reduce the attack surface. Quoted identifiers
 * with spaces/unicode are rejected; if one is genuinely needed a
 * separate validated factory can be added later.
 */
const SAFE_IDENT_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

/**
 * Reserved-word blocklist — PostgreSQL accepts these as unquoted
 * identifiers but doing so invites confusion. Reject at construction.
 * Short list — add as needed.
 */
const RESERVED_IDENTS = new Set([
  'select',
  'insert',
  'update',
  'delete',
  'drop',
  'create',
  'alter',
  'table',
  'schema',
  'database',
  'user',
  'role',
  'grant',
  'revoke',
  'from',
  'where',
  'and',
  'or',
  'not',
  'null',
  'true',
  'false',
]);

function brandedIdent(raw: string): SqlIdent {
  return {
    [SQL_IDENT_BRAND]: true,
    quoted: `"${raw}"`,
    raw,
  };
}

function brandedValue(v: unknown): SqlValue {
  return {
    [SQL_VALUE_BRAND]: true,
    value: v,
  };
}

function brandedFragment(sql: string, params: readonly unknown[]): SqlFragment {
  return {
    [SQL_FRAGMENT_BRAND]: true,
    sql,
    params,
  };
}

function isIdent(x: unknown): x is SqlIdent {
  return (
    typeof x === 'object' && x !== null && (x as Record<symbol, unknown>)[SQL_IDENT_BRAND] === true
  );
}

function isValue(x: unknown): x is SqlValue {
  return (
    typeof x === 'object' && x !== null && (x as Record<symbol, unknown>)[SQL_VALUE_BRAND] === true
  );
}

function isFragment(x: unknown): x is SqlFragment {
  return (
    typeof x === 'object' &&
    x !== null &&
    (x as Record<symbol, unknown>)[SQL_FRAGMENT_BRAND] === true
  );
}

/**
 * Namespace holding every factory. The pattern `sql.ident(...)` /
 * `sql.value(...)` / `` sql.fragment`...` `` is the ONLY API — no
 * "helper" shortcuts that bypass the branded types.
 */
export const sql = {
  /**
   * Build a validated, quoted identifier.
   *
   * @throws RangeError on any of: empty input, non-string, regex
   *   rejection, reserved word, length > 63 (PG identifier limit).
   */
  ident(name: string): SqlIdent {
    if (typeof name !== 'string') {
      throw new TypeError(`[sql.ident] expected string, got ${typeof name}`);
    }
    if (name.length === 0) {
      throw new RangeError('[sql.ident] empty identifier');
    }
    if (name.length > 63) {
      throw new RangeError(`[sql.ident] identifier "${name}" exceeds 63-char PostgreSQL limit`);
    }
    if (!SAFE_IDENT_RE.test(name)) {
      throw new RangeError(
        `[sql.ident] "${name}" does not match SAFE_IDENT_RE (${SAFE_IDENT_RE.source}). ` +
          `Identifiers must start with letter/underscore and contain only [A-Za-z0-9_]. ` +
          `This is a security boundary — SQL injection class. Fix the caller.`,
      );
    }
    if (RESERVED_IDENTS.has(name.toLowerCase())) {
      throw new RangeError(
        `[sql.ident] "${name}" is a reserved SQL keyword. ` +
          `Even quoted, these invite bugs; rename the object.`,
      );
    }
    return brandedIdent(name);
  },

  /**
   * Wrap an arbitrary value for parameterised interpolation. No
   * validation — it's a value, not an identifier. The consuming
   * query runner binds it as `$N` at execution.
   */
  value(v: unknown): SqlValue {
    return brandedValue(v);
  },

  /**
   * Tagged-template builder. Composes literal SQL text with
   * interpolated SqlIdent (inlined as `"name"`), SqlValue (inlined
   * as `$N`), or SqlFragment (sub-fragment, its params merged).
   *
   * A raw `string` interpolation is a TypeScript compile error —
   * that's the entire point.
   */
  fragment(
    strings: TemplateStringsArray,
    ...values: readonly (SqlIdent | SqlValue | SqlFragment)[]
  ): SqlFragment {
    let out = '';
    const params: unknown[] = [];
    let placeholderIndex = 1;

    for (let i = 0; i < strings.length; i++) {
      out += strings[i];
      if (i < values.length) {
        const v = values[i];
        if (isIdent(v)) {
          out += v.quoted;
        } else if (isValue(v)) {
          out += `$${placeholderIndex++}`;
          params.push(v.value);
        } else if (isFragment(v)) {
          // Rewrite child fragment's placeholders to continue our
          // sequence, then append. Child's $1 becomes our $N, etc.
          const rewritten = v.sql.replace(
            /\$(\d+)/g,
            (_, n: string) => `$${Number(n) + placeholderIndex - 1}`,
          );
          out += rewritten;
          for (const p of v.params) params.push(p);
          placeholderIndex += v.params.length;
        } else {
          // Belt-and-braces runtime check; TypeScript's type system
          // already rejected this at compile time.
          throw new TypeError(
            `[sql.fragment] interpolation slot #${i} is not an SqlIdent, SqlValue, or SqlFragment. ` +
              `Got: ${typeof v === 'object' ? JSON.stringify(v) : String(v)}. ` +
              `If you're porting from raw-string interpolation, wrap identifiers via sql.ident() and values via sql.value().`,
          );
        }
      }
    }

    return brandedFragment(out, params);
  },
};

/**
 * Type guard predicates for external consumers (e.g. a QueryRunner
 * wrapper that only accepts SqlFragment).
 */
export const sqlGuards = {
  isIdent,
  isValue,
  isFragment,
} as const;

/**
 * Execute a SqlFragment against a TypeORM QueryRunner-like object.
 *
 * This is the canonical boundary between "branded-typed fragment" and
 * "raw QueryRunner.query". Downstream callers should prefer this over
 * `qr.query(fragment.sql, fragment.params)` because it makes the
 * branded boundary explicit in the call site.
 */
export async function executeSqlFragment<T = unknown>(
  qr: { query: (sql: string, params?: readonly unknown[]) => Promise<T> },
  fragment: SqlFragment,
): Promise<T> {
  return qr.query(fragment.sql, fragment.params);
}
