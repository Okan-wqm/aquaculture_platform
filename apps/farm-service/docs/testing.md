# Farm Service Testing

## Targets

- `nx test farm-service`: fast unit tests.
- `nx run farm-service:test:integration`: integration, architecture, and Postgres-oriented specs.
- `nx run farm-service:e2e`: application e2e specs under `apps/farm-service/test`.
- `nx run farm-service:coverage`: unit coverage with thresholds.

## Test Placement

- Unit specs live beside modules under `src/**/__tests__` or as `*.spec.ts`.
- Integration specs use `*.integration.spec.ts` or `*.postgres.spec.ts`.
- Application e2e specs live under `apps/farm-service/test`.

## Required Cases

- Spoofed internal headers do not create user or tenant context.
- Unsigned production GraphQL requests fail.
- Cross-tenant reads and writes fail.
- Domain write, audit row, outbox row, projection, and mobile receipt roll back together.
- Duplicate command and duplicate event replay are idempotent.
- GraphQL list queries have query-count coverage for N+1 regressions.
- Health and metrics endpoints work without auth headers.
