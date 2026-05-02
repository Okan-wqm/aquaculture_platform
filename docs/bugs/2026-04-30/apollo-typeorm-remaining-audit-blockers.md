# Apollo and TypeORM Remaining Audit Blockers

- Date: 2026-04-30
- Status: Partially mitigated; dependency findings remain until package-owner migrations are possible.
- Area: GraphQL gateway/subgraphs, Apollo Federation, TypeORM UUID dependency.

## Problem

After root dependency modernization, the remaining production audit findings are limited to Apollo Federation/Apollo Server and TypeORM's transitive `uuid` usage. These cannot be solved safely with `npm audit fix --force` or broad transitive overrides.

## Current Audit State

`npm audit --omit=dev --audit-level=moderate --json` reports:

- `critical: 0`
- `high: 0`
- `low: 0`
- `moderate: 12`

The 12 moderate findings are:

- `@apollo/server`
- `@apollo/gateway`
- `@apollo/subgraph`
- `@apollo/composition`
- `@apollo/federation-internals`
- `@apollo/query-graphs`
- `@apollo/query-planner`
- `@apollo/server-plugin-landing-page-graphql-playground`
- `@nestjs/apollo`
- `@nestjs/graphql`
- `typeorm`
- `uuid`

## Root Causes

- Apollo Server 4 remains in use because the latest `@nestjs/apollo@13.4.0` peers `@apollo/server ^5`, but still depends on `@apollo/server-plugin-landing-page-graphql-playground@4.0.1`, which peers Apollo Server 4. Strict peer resolution rejects the graph.
- Apollo Federation packages directly use `uuid` internally:
  - `@apollo/federation-internals` imports `uuid.v1`.
  - `@apollo/query-graphs` imports `uuid.v4`.
  - `@apollo/server` imports `uuid.v4`.
- TypeORM latest stable `0.3.28` still depends on `uuid ^11.1.0`; there is no `typeorm@next` dist-tag in the registry.
- `uuid@14` is ESM and changes package export behavior. Forcing it into Apollo or TypeORM via root overrides would be a runtime compatibility gamble, not an enterprise-grade fix.

## Mitigation Applied

- Removed all direct application usage of the `uuid` package and direct `@types/uuid` dependencies from the root and farm module.
- Replaced remaining direct repo `uuid.v4()` imports with native `crypto.randomUUID()`.
- Added explicit `csrfPrevention: true` to every Apollo gateway/subgraph GraphQL configuration:
  - `ai-service`
  - `alert-engine`
  - `auth-service`
  - `billing-service`
  - `config-service`
  - `farm-service`
  - `gateway-api`
  - `hr-service`
  - `hydroponics-service`
  - `messaging-service`
  - `notification-service`
  - `sensor-service`

This does not remove the Apollo advisory from `npm audit`, but it makes the current Apollo Server 4 runtime posture explicit and fail-closed while Apollo Server 5 migration is blocked.

## Rejected Options

- Did not override Apollo/TypeORM transitive `uuid` to `14.x`.
- Did not downgrade Apollo Federation packages to audit-suggested older versions.
- Did not install `@nestjs/apollo@13.4.0` with peer bypass flags.
- Did not use `--force`, `--legacy-peer-deps`, or `--no-strict-peer-deps`.

## Required Enterprise Follow-Up

Apollo follow-up:

- Track or replace the Nest/Apollo integration path that currently pulls the Apollo Server 4 Playground plugin.
- Re-evaluate Apollo Router migration as a clean architectural option for gateway routing once deployment topology and observability are planned.
- Keep GraphQL Playground disabled and CSRF prevention explicit until the Apollo Server 5 path is peer-clean.

TypeORM follow-up:

- Wait for or validate a TypeORM release that supports `uuid >=14` without forced overrides.
- If TypeORM lags, evaluate a controlled ORM fork/patch only as a governed package-owner decision with CI typecheck, migration tests, and runtime DB tests.

## Verification

- `npm audit --omit=dev --audit-level=high --json` exits `0`.
- `npm audit --omit=dev --audit-level=moderate --json` still exits non-zero only for the documented Apollo/TypeORM blocker set.
- Direct repo search found no remaining `uuid` package imports or direct `uuid` package declarations after the app code moved to `crypto.randomUUID()`.

## CI Requirement

No broad local build/test was run on the Docker server. Final verification must run in GitHub Actions with deterministic `npm ci`, typecheck, build, targeted tests, E2E discovery, and fail-closed audit artifact generation.
