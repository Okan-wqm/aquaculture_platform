/**
 * Where `@aquaculture/shared-ui` resolves from, per Vite mode (FE-HIGH-064).
 *
 * Federation needs the built barrel: the shell and every remote alias the
 * package to `web/shared-ui/dist` so dev and build load the same runtime
 * entry the `shared:` singleton contract is pinned against.
 *
 * A test run must not inherit that. `dist/` exists only after shared-ui has
 * been built, so a CI job that runs a module's vitest without building
 * shared-ui first fails at import RESOLUTION — "Failed to resolve import
 * @aquaculture/shared-ui" on every spec that reaches the package, before a
 * single assertion runs. The suite then reports a build-ordering accident as
 * a test failure. Under `mode === 'test'` the alias therefore points at
 * source, which is always present in a checkout.
 *
 * This is the ONE place that decision is made. Config files pass their own
 * shared-ui root and the mode Vite handed them; none of them re-spell the
 * `src` / `dist` choice. `tests/invariants/shared-ui-test-alias.spec.ts`
 * fails the build if one starts to.
 */
import { resolve } from 'path';

/** Vite mode under which specs run and the package resolves from source. */
export const SHARED_UI_TEST_MODE = 'test';

/**
 * @param sharedUiRoot absolute path of `web/shared-ui`
 * @param mode the Vite mode (`test` while vitest runs)
 */
export function resolveSharedUiAlias(sharedUiRoot: string, mode: string): string {
  return resolve(sharedUiRoot, mode === SHARED_UI_TEST_MODE ? 'src' : 'dist');
}
