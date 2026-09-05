# gateway-api — CLAUDE.md (domain context)

> Root rules in `/CLAUDE.md` already apply (always loaded). This file adds ONLY the gateway facts that CONTRADICT a correct reading of those rules.

API gateway: auth guard, rate limiting, CSP, OPA, GraphQL supergraph entry, service-identity signing.

## gateway owns NO schema — and the absence is the design

The root rule lists `gateway` among the platform-level services that "always declare `schema:`". Read literally that implies a `gateway` schema. There is none, and there must not be one:

- There is **no `MODULE_SCHEMAS` entry** for gateway. That is not an oversight to repair — adding one would give the gateway a schema it has no business owning.
- The `gateway` schema name is reserved by the init script and deliberately left unused.
- The TypeORM connection is configured with `schema: 'shared'` (`apps/gateway-api/src/app.module.ts`), because the only tables the gateway resolves are `shared.audit_logs` and `shared.access_logs`.

## `migrations: []` + `migrationsRun: false` are structural

Both are set in `app.module.ts` so the gateway is _incapable_ of migrating a schema it does not own. Do not "fix" the empty array by wiring a migration runner.

For the same reason `entities:` is an explicit two-item list rather than `autoLoadEntities`. Adding an entity here widens the gateway's DB surface — put it in the owning service instead.

## `PLAN_FEATURES` is declared here exactly once

`tests/invariants/plan-features-ssot.spec.ts` freezes gateway-api as the sole declaration site. Per-plan LIMITS are a different SSoT and live in `libs/event-contracts/src/billing/plan-catalog.ts` — do not merge the two.

## Enforcement

CI: `tests/invariants/tenant-context-ssot.spec.ts`, `graphql-operation-limit-ssot.spec.ts`, `plan-features-ssot.spec.ts`, `public-service-edge-hardening.spec.ts`, `token-revocation-writer-reader-ssot.spec.ts`, `service-identity-canonical-coverage.spec.ts`; `e2e/tests/tenant-swap-attack.e2e.spec.ts`.
