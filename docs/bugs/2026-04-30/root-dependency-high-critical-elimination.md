# Root Dependency High/Critical Elimination

- Date: 2026-04-30
- Status: Fixed for `high` and `critical` findings in the root production audit.
- Area: root workspace dependency graph, CI dependency policy, farm/sensor/frontend build tooling.

## Problem

The root `npm audit --omit=dev --audit-level=high --json` gate still reported production `critical` and `high` findings after the first modernization pass. Leaving these as audit noise would make CI security gates non-actionable and would hide real runtime or build-chain exposure behind a large vulnerability count.

## Root Causes

- Runtime transitive packages were stale in several independent package families: AWS XML parser chain, OpenTelemetry/protobuf chain, build tooling, Socket.IO parser, cache/fetch/tar tooling, and mail transport.
- `monaco-editor@0.55.1` pulled vulnerable `dompurify@3.2.7`; sensor module had Monaco as a dev dependency even though `@monaco-editor/react` needs it as a runtime peer.
- ESLint tooling pinned `@typescript-eslint` v6, which kept vulnerable `minimatch` ranges active.
- Farm map editing used `@geoman-io/leaflet-geoman-free@2.19.0`, which pulled vulnerable lodash.
- GraphQL Codegen v6 pulled `@graphql-codegen/plugin-helpers@6`, which depended on `lodash ~4.17.0`.
- Some upstream packages still constrain vulnerable transitive ranges even after direct modernization. For these, the root workspace now has explicit, narrow npm `overrides` for security governance.

## Enterprise Fix

- Upgraded runtime/build dependency families through normal package resolution, not `npm audit fix --force`.
- Kept `strict-peer-deps=true`; peer conflicts were treated as real failures.
- Converted sensor Monaco ownership to runtime dependency and added a root workspace peer pin:
  - `web/modules/sensor-module` owns `monaco-editor@^0.53.0` as a runtime dependency.
  - root owns `monaco-editor@^0.53.0` as the workspace peer pin so npm does not auto-install `0.55.x`.
  - `dompurify@3.4.2` is retained as a workspace override because Monaco and sanitizer drift are security-sensitive.
- Moved ESLint tooling to the v8 family:
  - root and tenant-admin `@typescript-eslint/*` now use `^8.59.1`.
  - root and tenant-admin `eslint` now use `^8.57.1`.
  - `tools/eslint-rules` now depends on `@typescript-eslint/utils@^8.59.1` and advertises the matching ESLint peer range.
- Moved farm Geoman to `^2.19.3`, which resolves its lodash dependency to the safe `4.18.1` line.
- Moved GraphQL Codegen direct packages to `@graphql-codegen/cli@^7.0.0` and `@graphql-codegen/typescript@^6.0.0`, removing the plugin-helper lodash dependency chain.
- Updated `flatted` to `3.4.2`.
- Added narrow root overrides where upstream packages still hold unsafe ranges:
  - `lodash: 4.18.1`
  - selected `minimatch` owners to `3.1.5` or `9.0.9`
  - `dompurify: 3.4.2`

## Rejected Options

- Did not run `npm audit fix --force`.
- Did not use `--legacy-peer-deps`, `--force`, or `--no-strict-peer-deps`.
- Tried `vite-plugin-dts@5.0.0` as a possible upstream lodash-chain removal, but rejected it because strict peer resolution failed on its `unplugin-dts` graph. The change was reverted instead of bypassing the resolver.
- Did not migrate Apollo Server to v5 in this pass because `@nestjs/apollo@13.4.0` still has an upstream Apollo Server 4 peer conflict through the Playground plugin dependency.

## Verification

- `npm install --package-lock-only --ignore-scripts --no-audit --no-fund` completed under strict peer policy after each accepted dependency family change.
- Lock inspection confirmed:
  - `monaco-editor 0.53.0`
  - `dompurify 3.4.2`
  - `@typescript-eslint/utils 8.59.1`
  - `@typescript-eslint/typescript-estree 8.59.1`
  - `@geoman-io/leaflet-geoman-free 2.19.3`
  - `@graphql-codegen/cli 7.0.0`
  - `@graphql-codegen/plugin-helpers 7.0.0`
  - `flatted 3.4.2`
  - `lodash 4.18.1`
- `npm audit --omit=dev --audit-level=high --json` now exits `0` with:
  - `critical: 0`
  - `high: 0`
  - `moderate: 20`
  - `low: 2`

## Remaining Recorded Work

The remaining moderate/low findings are not ignored. They need separate scoped modernization because each has real compatibility implications:

- Apollo/Nest federation stack: blocked by upstream Apollo Server 5 peer conflict already documented in `apollo-playground-runtime-disable-and-server5-blocker.md`.
- `@sentinel-hub/sentinelhub-js` / `fast-xml-parser`: needs farm map/imagery compatibility assessment before replacing or downgrading the SDK.
- Hono / `@hono/node-server`: identify the owning package chain and upgrade the Hono family as a focused pass.
- AJV / brace-expansion / yaml / follow-redirects / qs / diff: update package-family owners and preserve strict-peer CI gates.
- `uuid` / `typeorm`: requires ORM compatibility analysis because audit suggests a semver-major/downgrade path that is not enterprise-safe without code and migration verification.

## CI Requirement

No broad local build/test was run on the Docker server. Final verification must run in GitHub Actions with deterministic `npm ci`, typecheck, build, targeted tests, E2E discovery, and the fail-closed audit artifact workflow.
