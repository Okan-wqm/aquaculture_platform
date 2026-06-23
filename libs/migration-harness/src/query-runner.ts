import type { QueryRunner } from 'typeorm';

/**
 * Row shape returned by a raw SQL query. WHY `Record<string, unknown>`:
 * `QueryRunner.query()` is typed `Promise<any>`, so every call site that reads
 * `rows[i].col` trips `@typescript-eslint/no-unsafe-*`. Routing every raw query
 * through {@link queryRows} re-establishes a typed boundary — the caller names
 * the concrete row shape `T` and the helper runtime-validates that the driver
 * actually returned an array of objects before handing it back.
 */
export type QueryRow = Record<string, unknown>;

function isQueryRow(value: unknown): value is QueryRow {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Run a raw SQL query and return its rows typed as `T[]`, validating at runtime
 * that the result is an array of objects. WHAT: the single typed boundary for
 * `QueryRunner.query()` in the harness — replaces ad-hoc `await qr.query()`
 * (which is `any`) so call sites stay type-safe without `as` casts.
 */
export async function queryRows<T extends QueryRow>(
  qr: QueryRunner,
  query: string,
  parameters?: readonly unknown[],
): Promise<T[]> {
  const rows: unknown = await qr.query(
    query,
    parameters === undefined ? undefined : [...parameters],
  );
  if (!Array.isArray(rows)) {
    throw new Error('Expected QueryRunner.query() to return a row array');
  }
  return rows.map((row, index) => {
    if (!isQueryRow(row)) {
      throw new Error(`Expected QueryRunner.query() row ${index} to be an object`);
    }
    return row as T;
  });
}

/**
 * Run a raw SQL query that must return at least one row; returns the first row
 * typed as `T`. Throws if zero rows come back — turns a silent `undefined`
 * (then unsafe member access) into an explicit, located failure.
 */
export async function queryRequiredRow<T extends QueryRow>(
  qr: QueryRunner,
  query: string,
  parameters?: readonly unknown[],
): Promise<T> {
  const rows = await queryRows<T>(qr, query, parameters);
  const [row] = rows;
  if (row === undefined) {
    throw new Error('Expected QueryRunner.query() to return at least one row');
  }
  return row;
}

/**
 * Typed accessor for a specific row of a `queryRows` result. WHY: `rows[i]` is
 * `T | undefined` under `noUncheckedIndexedAccess`, so reading `rows[i].col`
 * trips TS2532. This narrows to `T` (or throws with the actual row count) so
 * multi-row assertions stay type-safe without a non-null assertion.
 */
export function rowAt<T>(rows: readonly T[], index: number): T {
  const row = rows[index];
  if (row === undefined) {
    throw new Error(`Expected a row at index ${index}, but only ${rows.length} row(s) returned`);
  }
  return row;
}
