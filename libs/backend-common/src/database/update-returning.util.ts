/**
 * updateReturningRows — typed, runtime-asserted reader for the result of a
 * raw `UPDATE … RETURNING …` executed through TypeORM's `dataSource.query()`.
 *
 * WHAT: TypeORM's PostgresQueryRunner does NOT return the row list directly
 * for UPDATE/DELETE/INSERT statements — it returns a two-element tuple
 * `[rows, affectedCount]`. Reading `result[0]` therefore yields the ROWS
 * ARRAY, not the first row; `result[0].someColumn` is silently `undefined`.
 *
 * WHY this helper exists (ORPHAN-HIGH-318): auth-service's failed-login
 * lockout path typed the raw result as `Array<Row>` by hand and read
 * `result[0]?.failedLoginAttempts`. The hand-written annotation asserted the
 * wrong driver shape, the type system could not catch it, and two real
 * security signals died silently in production: every audit event recorded
 * "attempt 0", and the CRITICAL ACCOUNT_LOCKED event never fired (the
 * lockout predicate compared `0 >= maxFailedAttempts`). A raw-query result
 * must cross a runtime shape assertion before any field access — that is
 * the only structural defence available where the compiler is blind.
 *
 * Scope: PostgreSQL driver only (the platform's sole database). If a caller
 * ever feeds this a SELECT result (plain rows array, no tuple), the
 * assertion fails loudly instead of mis-reading.
 */
export function updateReturningRows<T>(raw: unknown): T[] {
  if (
    !Array.isArray(raw) ||
    raw.length !== 2 ||
    !Array.isArray(raw[0]) ||
    typeof raw[1] !== 'number'
  ) {
    throw new Error(
      'updateReturningRows: expected the TypeORM postgres UPDATE…RETURNING ' +
        'tuple shape [rows[], affectedCount]. Got: ' +
        `${Array.isArray(raw) ? `array(len=${raw.length})` : typeof raw}. ` +
        'If the statement is a SELECT, read the rows directly — this helper ' +
        'is only for UPDATE/DELETE/INSERT … RETURNING through dataSource.query().',
    );
  }
  return raw[0] as T[];
}
