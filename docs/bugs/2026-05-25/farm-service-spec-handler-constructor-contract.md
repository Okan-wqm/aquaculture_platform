# Farm Service Spec Handler Constructor Contract

## Date

2026-05-25

## Failure

Main release verification failed in `npm run gates:type-check-spec` after the
farm stock snapshot GraphQL fix reached `main`. The deploy pipeline did not get
to the production deploy jobs. The failing project was:

- `apps/farm-service`: 18 spec type-check regressions

The errors were direct `new Handler(...)` calls in farm-service tests that still
used older constructor arities after stock projection refresh and mobile command
receipt dependencies were added to production command handlers.

## Architectural Decision

Production NestJS dependency injection remains fail-closed. The handler
dependencies are not marked `@Optional()`, and no provider registration is
suppressed. If the real farm stock projection, mobile command receipt, or outbox
providers are missing in production, NestJS still fails startup.

For direct constructor tests, the handlers now provide typed default
dependencies backed by explicit null-object implementations in:

- `apps/farm-service/src/common/services/direct-handler-dependency-defaults.ts`

This keeps legacy direct unit/e2e construction type-safe without changing the
runtime production DI contract.

## Verification

- `npx tsc -p apps/farm-service/tsconfig.spec.json --noEmit`
- `npx eslint` on the changed farm-service production handler files and the new
  direct-construction dependency defaults module

## Release Impact

No tenant edge release or tag is created by this fix. It only unblocks main CI
release verification for the SaaS farm-service gate path.
