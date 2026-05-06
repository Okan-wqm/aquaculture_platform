# 2026-05-06 - Migration Harness Affected Test Container Contention

## Affected Area
- `.github/workflows/ci-affected.yml`
- `libs/migration-harness`
- GitHub Actions `CI - Affected / test`

## Observed Issue
The current affected test run failed `migration-harness:test` in `expect-no-drift.integration.spec.ts` with repeated `Exceeded timeout of 90000 ms for a hook` errors while booting the PostgreSQL Testcontainer. The suite is already serial inside Jest, but the CI affected test job still ran it as part of a broader Nx `--parallel=2` test graph.

## Root Cause
`migration-harness` uses real PostgreSQL Testcontainers. Jest `maxWorkers: 1` prevents multiple harness suites from booting containers concurrently inside that project, but it does not isolate the project from other affected Nx test targets running at the same time. The result is CI-level Docker/resource contention during `beforeAll`, before the suite can return a usable DataSource.

## Architectural Fix
Run `migration-harness:test` as an explicit isolated affected gate before the general affected test graph. The general test graph then excludes `migration-harness`, keeping normal parallelism for non-Testcontainers targets while giving the DB harness a deterministic Docker boot boundary.

This is not a retry, timeout inflation, or `continue-on-error`; the resource contract is modeled directly in CI.

## Verification
- GitHub Actions `CI - Affected / test`.

## Status
Fixed on 2026-05-06; pending GitHub Actions confirmation.
