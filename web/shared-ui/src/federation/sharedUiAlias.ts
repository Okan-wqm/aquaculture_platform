/**
 * Where a remote resolves `@aquaculture/shared-ui` from, by Vite mode.
 *
 * Builds and dev servers consume the built package (`dist/`): that is what
 * Module Federation shares at runtime and what the shell loads. Tests must
 * not: a spec that imports a component through `dist/` fails with
 * "Failed to resolve import" on any checkout that has not run
 * `shared-ui:build` first, and passes on one that has — the same suite is
 * red or green depending on a build artefact the test never declared. Under
 * `nx test` the `dependsOn: shared-ui:build` edge hid this; under raw
 * `vitest` it surfaced as admin-panel's only real instability (TEST-019,
 * ADR-0017). In test mode the alias points at `src/`, so the suite depends
 * on source, not on an artefact.
 *
 * Node-only: this file imports `node:path` and is consumed by
 * `vite.config.ts` files. It is deliberately NOT exported from
 * `federationSharedConfig.ts`, which browser code also imports.
 */
import { resolve } from 'node:path';

const SHARED_UI_ROOT = resolve(__dirname, '..', '..');

export function resolveSharedUiAlias(mode: string): string {
  return mode === 'test' ? resolve(SHARED_UI_ROOT, 'src') : resolve(SHARED_UI_ROOT, 'dist');
}
