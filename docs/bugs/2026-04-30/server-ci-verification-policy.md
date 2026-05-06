# Server and CI Verification Policy

- Date: 2026-04-30
- Affected area: local verification workflow
- Status: Active policy

## Observed Issue

Heavy local Nx build commands were started on the Docker-running server and stayed silent for several minutes. This server is not the right primary build machine because it also hosts running Docker services and has limited CPU headroom.

## Root Cause

The verification strategy did not distinguish between:

- CI-suitable heavy gates such as broad Nx builds and full test suites.
- Server-suitable lightweight gates such as typecheck, targeted Jest, dependency audit, Docker health, and Testcontainers-specific checks.

Running broad builds locally can interfere with the server's runtime workload and produce slow feedback without better confidence than GitHub Actions.

## Policy

If a build/test/verification gate can run in GitHub Actions, prefer GitHub Actions over the local Docker server.

Local/server verification should be reserved for:

- Targeted typechecks.
- Targeted Jest suites.
- Docker/Testcontainers checks that require this server runtime.
- `npm audit` / dependency graph validation.
- Fast debugging before pushing to CI.

Avoid broad local Nx builds unless explicitly requested or CI is unavailable.

## Verification

- Accidental parallel local Nx builds were stopped.
- `gateway-api`, `farm-service`, `hydroponics-service`, and `auth-service` app typechecks were used as local verification instead.
