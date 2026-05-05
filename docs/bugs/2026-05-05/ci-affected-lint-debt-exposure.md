# 2026-05-05 - CI Affected Lint Debt Exposure

## Affected Area
- `.github/workflows/ci-affected.yml`
- Affected Nx lint targets across backend, frontend, E2E, MCP, and tooling projects

## Observed Issue
CI affected lint is fail-closed and now reports historical lint debt across a broad PR graph. The visible `566 errors` count belongs only to `@aquaculture/e2e-tests:lint`; it is not the total lint failure. The same run also reported large affected-project failures such as `farm-module` with 10,428 errors, `sensor-module` with 4,347 errors, `admin-panel` with 1,826 errors, and `hr-module` with 935 errors.

## Root Cause
The branch affects a wide Nx graph, so `npx nx affected -t lint` executes lint targets for many projects that still carry pre-existing strict ESLint debt. Removing `continue-on-error` correctly made this debt visible, but it means this branch is now blocked by repository-wide historical lint adoption, not by one localized regression.

## Architectural Fix Direction
- Do not hide this with `continue-on-error`, `--quiet`, project excludes, or rule disabling.
- Decide whether this PR is also the lint-modernization PR. If yes, clean each affected project at source until `nx affected -t lint` is green.
- If not, create a governed lint adoption gate equivalent to the existing type-check-spec ratchet: record per-project baselines, fail on any regression above baseline, and drive a dated cleanup plan that monotonically reduces each baseline to zero. That is a governance mechanism, not a hidden pass, because CI still prevents new debt and the existing debt is quantified by project.

## Verification
- `npx nx affected -t lint --base=origin/main --head=HEAD --parallel=2`

## Status
Recorded on 2026-05-05. Not fixed in this patch; the next implementation decision must choose full cleanup or governed ratchet.
