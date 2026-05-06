# 2026-05-05 - E2E Typed Lint Project Boundary

## Affected Area
- `.eslintrc.json`
- `e2e/tsconfig.json`
- `@aquaculture/e2e-tests:lint`

## Observed Issue
Affected CI lint reported hundreds of E2E errors, including unresolved `describe`, `beforeEach`, `expect`, and helper member access. The visible `566 errors` count was emitted by `@aquaculture/e2e-tests:lint`.

## Root Cause
The root ESLint typed parser did not include `e2e/tsconfig.json` in `parserOptions.project`, and the E2E tsconfig only included `jest.config.ts` plus `tests/**/*.ts`. That meant helpers, fixtures, setup, teardown, Playwright config, and ambient declarations were not modeled as one explicit E2E lint boundary.

GitHub Actions later proved this was not the only cause of the `@aquaculture/e2e-tests:lint` failure: the latest affected run still reports 568 problems / 566 errors. Remaining E2E failures are real lint debt and unresolved type-import contracts, including import ordering, non-null assertions, unused fixtures, direct relative imports across Nx boundaries, unsafe YAML/Playwright call sites, and structured logging violations.

## Architectural Fix
Make the E2E TypeScript program the single typed lint boundary for the E2E project. Root ESLint now includes `e2e/tsconfig.json`, and the E2E tsconfig includes all local TypeScript files so lint, Jest, Playwright helpers, fixtures, setup, and teardown are checked against the same runtime contract.

This does not suppress any lint rule and does not exclude E2E files from CI. It makes the E2E lint boundary explicit so remaining lint failures can be remediated as code issues instead of hidden by configuration.

## Verification
- GitHub Actions `@aquaculture/e2e-tests:lint` in affected CI still fails with 568 problems / 566 errors.

## Status
Boundary corrected on 2026-05-05. E2E lint debt remains open and must be fixed at source.
