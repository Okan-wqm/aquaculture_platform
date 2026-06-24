/**
 * Test assertion helpers — the SSoT for narrowing nullable values in e2e specs.
 *
 * `@typescript-eslint/no-non-null-assertion` bans bare `!`: a non-null assertion
 * silently trusts that a value is present and, when it is not, surfaces as a
 * cryptic "cannot read properties of undefined" far from the real cause.
 * `assertDefined` instead fails the test LOUDLY at the assertion site (with
 * optional context) and narrows `T | null | undefined` to `T`, so a broken
 * fixture or an unexpected API response is an explicit, debuggable test failure.
 *
 * Usage:
 *   const user = assertDefined(res.data?.createUser, 'createUser returned null');
 *   const first = assertDefined(rows.find((r) => r.isDefault)); // replaces rows.find(...)!
 */

/** Narrow `T | null | undefined` to `T`, throwing a descriptive error if absent. */
export function assertDefined<T>(value: T | null | undefined, message?: string): T {
  if (value === null || value === undefined) {
    throw new Error(message ?? 'assertDefined: expected a value but received null/undefined');
  }
  return value;
}
