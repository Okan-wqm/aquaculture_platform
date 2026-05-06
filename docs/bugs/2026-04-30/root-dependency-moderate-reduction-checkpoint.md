# Root Dependency Moderate Reduction Checkpoint

- Date: 2026-04-30
- Status: Fixed all currently solvable non-Apollo/non-TypeORM production audit findings.
- Area: root workspace dependency graph, farm module satellite integration, native UUID generation.

## Problem

After the root production audit reached `critical: 0` and `high: 0`, the remaining moderate/low findings still included stale frontend satellite dependencies, Hono server packages, AJV, YAML, QS, diff, and UUID findings. These cannot be left as anonymous audit noise because they weaken CI signal quality.

## Root Causes

- `@modelcontextprotocol/sdk` was behind the latest patch line and kept vulnerable `hono` / `@hono/node-server` versions in the lockfile.
- `web/modules/farm-module` still depended on `@sentinel-hub/sentinelhub-js`, even though the current implementation routes Sentinel Hub calls through the backend proxy and does not import the browser SDK.
- `@sentinel-hub/sentinelhub-js` declares a `fast-xml-parser ^4.4.1` peer, which forced a vulnerable `fast-xml-parser 4.x` into the farm module lock graph.
- Root and farm module code still used the `uuid` package directly even though the platform already standardizes most UUID generation on native `crypto.randomUUID()`.
- `ajv`, `brace-expansion`, `yaml`, `qs`, `follow-redirects`, and `diff` needed normal lockfile modernization within compatible ranges.

## Enterprise Fix

- Updated `@modelcontextprotocol/sdk` to the latest compatible package line through normal npm resolution.
- Resolved Hono packages to safe versions:
  - `hono 4.12.16`
  - `@hono/node-server 1.19.14`
- Removed unused `@sentinel-hub/sentinelhub-js` from `web/modules/farm-module`.
- Removed the obsolete Vite alias that only existed to support the unused Sentinel Hub browser SDK peer dependency.
- Removed direct root and farm module `uuid` / `@types/uuid` dependencies.
- Replaced remaining production and test `uuid.v4()` imports with native `crypto.randomUUID()` while preserving the local `uuidv4()` alias at call sites to minimize behavior churn.
- Updated safe transitive package lines through strict lockfile resolution:
  - `ajv 8.20.0`
  - `brace-expansion 1.1.14` / `5.0.5`
  - `yaml 2.8.3`
  - `qs 6.14.2` / `6.15.1`
  - `diff 4.0.4`

## Rejected Options

- Did not force `fast-xml-parser 5.x` into `@sentinel-hub/sentinelhub-js`; that would violate the SDK peer contract.
- Did not keep the unused Sentinel Hub browser SDK just to avoid touching the dependency graph.
- Did not override `uuid` to `14.x` inside Apollo or TypeORM. Those packages own their UUID import/runtime contracts, and forcing a semver-major transitive package could create runtime breakage that CI typecheck may not catch.
- Did not use `--force`, `--legacy-peer-deps`, `--no-strict-peer-deps`, or `npm audit fix --force`.

## Verification

- `npm install --package-lock-only --ignore-scripts --no-audit --no-fund` completed under strict peer policy.
- Import/dependency search found no remaining direct repo usage of `uuid` or `@types/uuid`.
- `npm audit --omit=dev --audit-level=moderate --json` now reports:
  - `critical: 0`
  - `high: 0`
  - `moderate: 12`
  - `low: 0`
  - `total: 12`

## Remaining Recorded Work

The remaining 12 findings are the Apollo federation/server stack plus TypeORM's transitive UUID chain:

- Apollo Server 5 is still blocked by the previously documented `@nestjs/apollo@13.4.0` peer conflict through the Apollo Server 4 Playground plugin dependency.
- Apollo federation packages still depend on vulnerable `uuid <14`.
- TypeORM `0.3.28` still depends on `uuid 11.1.0`; audit suggests a semver-major/downgrade path that is not acceptable without a focused ORM compatibility pass.

These are not ignored. They require a separate architecture decision: either a clean Apollo Router / Apollo Server 5 migration path once Nest peer conflicts are resolved, and a TypeORM UUID compatibility strategy that does not force transitive majors blindly.

## CI Requirement

No broad local build/test was run on the Docker server. Final validation must run in GitHub Actions with deterministic `npm ci`, typecheck, build, targeted tests, E2E discovery, and fail-closed audit artifact generation.
