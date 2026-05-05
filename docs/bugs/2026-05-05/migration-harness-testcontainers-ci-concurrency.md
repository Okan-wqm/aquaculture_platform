# 2026-05-05 - Migration Harness Testcontainers CI Concurrency

## Affected Area
- `libs/migration-harness/jest.config.cts`

## Observed Issue
CI `migration-harness:test` timed out in multiple `beforeAll` hooks while booting PostgreSQL Testcontainers. Several suites attempted to initialize real containers concurrently and then reported environment teardown errors from docker-modem after timeout.

## Root Cause
The migration harness integration suite is a real Docker/PostgreSQL test harness. Running many suites in parallel multiplies Docker pulls/container boots and can exceed the per-suite `beforeAll` budget before a usable `DataSource` is returned.

## Architectural Fix
Run migration-harness Jest workers serially with `maxWorkers: 1`. This keeps the full integration coverage but gives each Testcontainers suite exclusive Docker boot capacity, instead of hiding failures by skipping tests or inflating every assertion timeout.

## Verification
- Full validation should run in GitHub Actions because this server is not the primary heavy CI machine.
- Local targeted verification can run `npx nx run migration-harness:test` when server capacity is available.

## Status
Fixed on 2026-05-05; pending GitHub Actions confirmation.
