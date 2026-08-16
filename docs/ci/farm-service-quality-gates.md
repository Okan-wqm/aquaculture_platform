# Farm Service Quality Gates

## Required Targets

- `nx test farm-service`: fast unit suite only.
- `nx run farm-service:test:integration`: integration and Postgres-oriented suites.
- `nx run farm-service:e2e`: application e2e suite.
- `nx run farm-service:coverage`: unit coverage with threshold enforcement.

## Architecture Gates

- `tools/gates/farm-service-enterprise-guardrails.ts --mode=range BASE HEAD`
- `npm run invariants:fast`
- `npm run gates:apollo-csrf`
- `npm run gates:messaging-tenant-routing`

## Blocked In New Farm Code

- `@ts-ignore` and `@ts-nocheck`.
- `eslint-disable` comments.
- `istanbul ignore` comments.
- Architecture suppression markers.
- Direct `eventBus.publish` in write paths.
- Raw `createQueryRunner` in handlers.
- Raw `x-tenant-id` authority reads.
- New raw `@InjectRepository` application wiring.

## Drift Checks

- GraphQL SDL generation/composition from the service-catalog artifact manifest.
- OpenAPI route drift against `docs/api/openapi/farm-service.yaml`.
- Event envelope and catalog drift for farm events.
- Circular dependency and module boundary checks.
