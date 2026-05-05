# 2026-05-05 - E2E Typed Lint Project Boundary

## Affected Area
- `.eslintrc.json`
- `e2e/tsconfig.json`
- `@aquaculture/e2e-tests:lint`

## Observed Issue
Affected CI lint reported hundreds of E2E errors, including unresolved `describe`, `beforeEach`, `expect`, and helper member access. The visible `566 errors` count was emitted by `@aquaculture/e2e-tests:lint`.

## Root Cause
The root ESLint typed parser did not include `e2e/tsconfig.json` in `parserOptions.project`, so E2E files were linted without the TypeScript program that declares the Jest and Node test runtime. The E2E tsconfig also only included `jest.config.ts` and `tests/**/*.ts`, leaving helpers, fixtures, setup, teardown, Playwright config, and ambient declarations outside the typed lint project.

## Architectural Fix
Make the E2E TypeScript program the single typed lint boundary for the E2E project. Root ESLint now includes `e2e/tsconfig.json`, and the E2E tsconfig includes all local TypeScript files so lint, Jest, Playwright helpers, fixtures, setup, and teardown are checked against the same runtime contract.

This does not suppress any lint rule and does not exclude E2E files from CI. It removes the harness misconfiguration so remaining lint failures represent real code issues rather than missing type-program context.

## Verification
- GitHub Actions `@aquaculture/e2e-tests:lint` in affected CI.

## Status
Fixed on 2026-05-05; pending GitHub Actions confirmation.
