/**
 * How `@aquaculture/shared-ui` is aliased, per Vite mode (FE-HIGH-064, FE-HIGH-343).
 *
 * Every mode but `test`: no alias. The package is a federation shared
 * singleton (federationSharedConfig.ts), and `@module-federation/vite` routes
 * an import through its `loadShare` proxy only when the import reaches it as
 * the shared specifier. Vite's alias plugin runs before every user plugin, so
 * an alias hands the federation plugin a file path instead and the import is
 * bundled privately: the shell and each remote then hold their own shared-ui
 * and their own React contexts. The dashboard remote's useTenantContext read a
 * TenantContext no provider had mounted and /dashboard failed with
 * "useTenantContext must be used within a TenantProvider". Unaliased, the
 * specifier resolves through the workspace package's `exports` to
 * `web/shared-ui/dist/index.mjs`, the same built barrel the alias used to name.
 *
 * `test`: alias to source. No federation runtime exists under vitest
 * (`@module-federation/vite` returns no plugins in a test process), and
 * `dist/` exists only after shared-ui has been built, so a CI job that runs a
 * module's vitest without building shared-ui first would fail at import
 * resolution before a single assertion runs.
 *
 * This is the ONE place that decision is made. Configs spread the result into
 * `resolve.alias` and never spell the key or a target themselves:
 * `tests/invariants/shared-ui-test-alias.spec.ts` and
 * `tests/invariants/web-shared-ui-singleton-imports.spec.ts` fail the build if
 * one starts to.
 */
import { resolve } from 'path';

/** The package specifier the federation share scope knows shared-ui by. */
export const SHARED_UI_PACKAGE = '@aquaculture/shared-ui';

/** Vite mode under which specs run and the package resolves from source. */
export const SHARED_UI_TEST_MODE = 'test';

/**
 * @param sharedUiRoot absolute path of `web/shared-ui`
 * @param mode the Vite mode (`test` while vitest runs)
 * @returns alias entries to spread into `resolve.alias`
 */
export function sharedUiAlias(
  sharedUiRoot: string,
  mode: string,
): Readonly<Record<string, string>> {
  return mode === SHARED_UI_TEST_MODE ? { [SHARED_UI_PACKAGE]: resolve(sharedUiRoot, 'src') } : {};
}
