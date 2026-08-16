/**
 * sanitize-pg-error — Strip row data from PostgreSQL error messages
 * ===========================================================================
 *
 * PG's default error messages for integrity failures include the offending
 * row's values:
 *
 *   duplicate key value violates unique constraint "idx_ssn_unique"
 *     Key (ssn)=(123-45-6789) already exists.
 *
 *   new row for relation "payrolls" violates check constraint "chk_salary"
 *     Failing row contains (42, john.doe@example.com, 150000.00, ...).
 *
 * When these errors surface in NATS events (`MigrationTenantFailed.error`),
 * structured logs, or CI artifacts, the PII leak is multi-service:
 * every subscriber on `platform.migration.>` gets the row values.
 *
 * This util extracts the safe parts — SQLSTATE code + the error template
 * with row data redacted — and discards the rest.
 *
 * # What's redacted
 *
 * - `Key (col1, col2)=(value1, value2)` → `Key (<N cols>)=<redacted>`
 * - `Failing row contains (v1, v2, ..., vN)` → `Failing row contains <redacted>`
 * - Column values in CHECK violations: `new row ... = {1: 'secret'}` → generic
 * - Additional `maskPii()` pass covers any other literals (email/phone/SSN/CC/IP)
 *
 * # What's preserved
 *
 * - SQLSTATE (`23505` = unique_violation, `23514` = check_violation, …)
 * - Constraint name (safe — operator/author chose it; never PII)
 * - Relation name (safe — schema object name)
 * - Column names (reveals schema, not values — same as schema introspection
 *   that's already operator-visible via schema snapshots)
 *
 * # Why not just run the raw message through maskPii?
 *
 * `maskPii()` pattern-matches email/phone/SSN/CC/IP but has no notion of
 * `Key (...)=(...)` structure. A unique-constraint violation on a uuid
 * column (no PII pattern matches) would bypass `maskPii` entirely and
 * leak the uuid verbatim. Structured-first redaction is the primary
 * defense; `maskPii` is the secondary backstop.
 *
 * # Usage
 *
 * ```ts
 * import { sanitizePgError } from '@aquaculture/backend-common/sanitize-pg-error.util.ts';
 *
 * try {
 *   await qr.query(someMigration);
 * } catch (e) {
 *   const safe = sanitizePgError(e);
 *   eventBus.emit('MigrationTenantFailed', {
 *     ...baseFields,
 *     sqlState: safe.sqlState,
 *     errorTemplate: safe.template,
 *     constraintName: safe.constraintName,
 *   });
 * }
 * ```
 *
 * See plan v3 R25 + ADR-024 (compliance retention matrix — PII scrub gate
 * on finding registry + migration_events table).
 */
import { maskPii } from './pii-mask.util';

/** Subset of pg's DatabaseError shape (we don't depend on the `pg` types). */
interface PgLikeError {
  readonly message?: string;
  readonly code?: string;
  readonly constraint?: string;
  readonly table?: string;
  readonly schema?: string;
  readonly column?: string;
  readonly detail?: string;
  readonly hint?: string;
}

export interface SanitizedPgError {
  /** PostgreSQL SQLSTATE code, e.g. `23505`. `null` if not discoverable. */
  sqlState: string | null;
  /** Redacted short template of the error message, suitable for logs + events. */
  template: string;
  /** Constraint name if the error was triggered by one (unique, check, FK). */
  constraintName: string | null;
  /** Schema-qualified relation name (if available). Never contains values. */
  relation: string | null;
  /** Column names referenced in the error (if any). Never values. */
  columns: string[];
}

/**
 * JSON Schema-ready guard regex. Any migration-event payload whose
 * `error` field matches this pattern is rejected at the consumer — a
 * validator-level safety net for the case where some upstream path
 * forgets to call this util before emitting.
 *
 * Keep in sync with the schema validator in
 * `libs/event-contracts/src/schemas/migration-events.schema.json`.
 */
export const PG_ERROR_ROW_LEAK_PATTERN = /Key \([^)]+\)=\([^)]+\)|Failing row contains \(/i;

/**
 * Compile-time-discoverable list of PG SQLSTATE codes we actively log —
 * keep small, add here when a new one becomes operationally useful.
 * Anything not in this list is reported as "other" to prevent attackers
 * from using SQLSTATE as an oracle (rare but nonzero risk).
 */
const WHITELISTED_SQLSTATE_PREFIXES = [
  '22', // data exception
  '23', // integrity constraint violation
  '40', // transaction rollback
  '42', // syntax error or access rule violation
  '53', // insufficient resources
  '55', // object not in prerequisite state
  '57', // operator intervention
];

/**
 * Sanitize any error thrown by a PostgreSQL driver into a structured,
 * PII-safe summary suitable for NATS events + structured logs.
 *
 * Handles three shapes:
 *   1. `pg.DatabaseError` (structured — best case, we have SQLSTATE etc.)
 *   2. TypeORM `QueryFailedError` wrapping the above
 *   3. Plain `Error` or string — template-only, SQLSTATE null
 *
 * @param err  The caught value (unknown — we don't trust the shape)
 * @returns    A sanitized summary
 */
export function sanitizePgError(err: unknown): SanitizedPgError {
  const pgErr = coercePgLikeError(err);
  const rawMessage = extractMessage(err);

  const sqlState = classifySqlState(pgErr?.code ?? null);
  const constraintName = pgErr?.constraint ?? null;
  const relation = buildRelation(pgErr?.schema, pgErr?.table);
  const columns = splitColumnList(pgErr?.column ?? null);

  // Strip known row-leak patterns, THEN run maskPii for pattern-value leftovers.
  let template = rawMessage
    .replace(/Key \(([^)]+)\)=\([^)]+\)/gi, (_, cols: string) => {
      const colCount = cols.split(',').length;
      return `Key (<${colCount} col${colCount === 1 ? '' : 's'}>)=<redacted>`;
    })
    .replace(/Failing row contains \([^)]*\)/gi, 'Failing row contains <redacted>')
    .replace(/DETAIL:\s*[^\n]*/gi, 'DETAIL: <redacted>');

  template = maskPii(template);

  // Trim runaway stack traces — templates should be short for event payloads.
  if (template.length > 500) {
    template = `${template.slice(0, 497)}...`;
  }

  return {
    sqlState,
    template,
    constraintName,
    relation,
    columns,
  };
}

/**
 * Narrow any thrown value into a PG-like error shape, or null.
 * TypeORM's `QueryFailedError` embeds the original pg error under
 * `.driverError`; we unwrap one level before giving up.
 */
function coercePgLikeError(err: unknown): PgLikeError | null {
  if (!err || typeof err !== 'object') return null;
  const e = err as Record<string, unknown>;
  // TypeORM wrapping
  if (e['driverError'] && typeof e['driverError'] === 'object') {
    return e['driverError'];
  }
  return e;
}

function extractMessage(err: unknown): string {
  if (typeof err === 'string') return err;
  if (!err || typeof err !== 'object') return String(err);
  const msg = (err as { message?: unknown }).message;
  return typeof msg === 'string' ? msg : 'Database operation failed';
}

function classifySqlState(code: string | null): string | null {
  if (!code) return null;
  if (!/^[0-9A-Z]{5}$/.test(code)) return null;
  const prefix = code.slice(0, 2);
  return WHITELISTED_SQLSTATE_PREFIXES.includes(prefix) ? code : `${prefix}xxx`;
}

function buildRelation(schema?: string, table?: string): string | null {
  if (!table) return null;
  return schema ? `${schema}.${table}` : table;
}

function splitColumnList(col: string | null): string[] {
  if (!col) return [];
  return col
    .split(',')
    .map((c) => c.trim())
    .filter(Boolean);
}

/**
 * Assertion for use at the event-emit boundary: throw if the provided
 * string still contains row-leak patterns. Consumers of this assertion
 * already called `sanitizePgError` but want a belt-and-braces guarantee
 * before writing to a durable audit log or cross-trust-boundary event.
 */
export function assertNoPgRowLeak(s: string): void {
  if (PG_ERROR_ROW_LEAK_PATTERN.test(s)) {
    throw new Error(
      `[sanitize-pg-error] assertNoPgRowLeak: input still contains row-leak pattern. ` +
        `Caller must sanitizePgError() before this assertion. ` +
        `Pattern: ${PG_ERROR_ROW_LEAK_PATTERN.source}`,
    );
  }
}
