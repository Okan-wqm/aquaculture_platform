# 2026-05-06 - Migration Harness Affected Test Container Contention

## Affected Area
- `.github/workflows/ci-affected.yml`
- `libs/migration-harness`
- GitHub Actions `CI - Affected / test`

## Observed Issue
The current affected test run failed `migration-harness:test` in `expect-no-drift.integration.spec.ts` with repeated `Exceeded timeout of 90000 ms for a hook` errors while booting the PostgreSQL Testcontainer. The suite is already serial inside Jest, but the CI affected test job still ran it as part of a broader Nx `--parallel=2` test graph.

After the first isolation change, GitHub Actions still failed in the isolated `migration-harness:test` step. That disproved the hypothesis that Nx target contention was the only cause. The new log showed the same `bootPostgresContainer()` hook timeout on a fresh runner, followed by async imports continuing after Jest teardown.

## Root Cause
`migration-harness` uses real PostgreSQL Testcontainers. Jest `maxWorkers: 1` prevents multiple harness suites from booting containers concurrently inside that project, but it does not isolate the project from other affected Nx test targets running at the same time. The result is CI-level Docker/resource contention during `beforeAll`, before the suite can return a usable DataSource.

The remaining failure is a separate readiness-boundary issue: the first CI suite can spend the Jest hook budget acquiring the pinned TimescaleDB image before PostgreSQL readiness and TypeORM initialization complete. That is dependency preparation leaking into the behavioral test window.

## Architectural Fix
Run `migration-harness:test` as an explicit isolated affected gate before the general affected test graph. The general test graph then excludes `migration-harness`, keeping normal parallelism for non-Testcontainers targets while giving the DB harness a deterministic Docker boot boundary.

Also prewarm the exact harness-owned PostgreSQL image before Jest starts. CI reads `DEFAULT_POSTGRES_IMAGE` from `libs/migration-harness/src/setup.ts` through `scripts/ci/print-migration-harness-postgres-image.mjs` and runs `docker pull` once in the isolated gate. The image digest remains single-sourced in the harness; YAML does not duplicate the pin.

This is not a retry, timeout inflation, or `continue-on-error`; the Docker dependency contract is modeled directly in CI before the test process begins.

## Verification
- GitHub Actions `CI - Affected / test`.

## Status
Updated on 2026-05-06 after CI disproved isolation-only remediation; pending GitHub Actions confirmation of the prewarm boundary.
