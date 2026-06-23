import type { QueryRunner } from 'typeorm';

import { type HarnessContext, withEphemeralSchema } from '../index';

// Re-export the typed raw-query boundary so spec files import every query
// primitive from one place. Plain re-export (not an async wrapper) avoids a
// pointless `require-await` shell around the already-async source functions.
export { queryRequiredRow, queryRows, rowAt, type QueryRow } from '../query-runner';

/**
 * Assert the suite's HarnessContext was initialized in `beforeAll` and narrow
 * away `undefined`. Replaces the `ctx!` non-null assertions that pepper the
 * specs (banned by `@typescript-eslint/no-non-null-assertion`): a failed boot
 * now produces a located assertion instead of a downstream TypeError.
 */
export function expectHarnessContext(
  ctx: HarnessContext | undefined,
): HarnessContext {
  expect(ctx).toBeDefined();
  if (ctx === undefined) {
    throw new Error('Migration harness context was not initialized');
  }
  return ctx;
}

/**
 * Assert a value is neither null nor undefined and narrow it. Replaces the
 * `value!` assertions used to capture a schema name escaping a closure.
 */
export function expectDefined<T>(
  value: T | null | undefined,
  label: string,
): NonNullable<T> {
  expect(value).toBeDefined();
  expect(value).not.toBeNull();
  if (value === undefined || value === null) {
    throw new Error(`${label} was not defined`);
  }
  return value;
}

/**
 * Run `fn` against a freshly created ephemeral schema, asserting the harness
 * context is initialized first. Drop-in for `withEphemeralSchema(ctx!, fn)`
 * that removes the non-null assertion at every call site. Not `async`: it
 * forwards the inner promise directly.
 */
export function withHarnessSchema<T>(
  ctx: HarnessContext | undefined,
  fn: (schema: string, qr: QueryRunner) => Promise<T>,
): Promise<T> {
  return withEphemeralSchema(expectHarnessContext(ctx), fn);
}
