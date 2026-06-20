# Finding Truth Table

Created: 2026-06-18

Registry tip: `f8acbaa670908353114d19242a0179a51860418985f5b01169854bdc6a0364eb`

This is the Wave 0 truth table for active CRITICAL findings. The initial rule is
conservative: every non-RESOLVED CRITICAL registry entry is treated as
`real-open` until code, tests, and registry evidence prove a different bucket.

Allowed truth buckets:

- `real-open`
- `already-fixed-needs-close`
- `superseded`
- `blocked`
- `stale`
- `new-finding-required`

| Finding                   | Registry state | First sprint | Owner                    | Truth bucket |
| ------------------------- | -------------- | ------------ | ------------------------ | ------------ |
| `COMPLIANCE-CRITICAL-001` | OPEN           | 2.2          | compliance-expert        | real-open    |
| `INFRA-CRITICAL-021`      | IN-PROGRESS    | 1.1          | data-expert              | already-fixed-needs-close |
| `INFRA-CRITICAL-023`      | IN-PROGRESS    | 1.1          | data-expert              | real-open    |
| `INFRA-CRITICAL-024`      | IN-PROGRESS    | 1.1          | infra-expert             | real-open    |
| `INFRA-CRITICAL-025`      | IN-PROGRESS    | 1.1          | messaging-expert         | already-fixed-needs-close |
| `INFRA-CRITICAL-026`      | IN-PROGRESS    | 1.1          | data-expert              | real-open    |
| `INFRA-CRITICAL-027`      | IN-PROGRESS    | 1.1          | data-expert              | real-open    |
| `INFRA-CRITICAL-028`      | IN-PROGRESS    | 1.1          | data-expert              | real-open    |
| `INFRA-CRITICAL-029`      | OPEN           | 1.1          | data-expert              | real-open    |
| `INFRA-CRITICAL-030`      | IN-PROGRESS    | 1.1          | data-expert              | real-open    |
| `INFRA-CRITICAL-031`      | IN-PROGRESS    | 1.1          | data-expert              | real-open    |
| `INFRA-CRITICAL-032`      | IN-PROGRESS    | 1.1          | data-expert              | real-open    |
| `FARM-CRITICAL-050`       | OPEN           | 4.1          | workflow-state-auditor   | already-fixed-needs-close |
| `FARM-CRITICAL-001`       | IN-PROGRESS    | 4.1          | multi-tenant-saas-expert | already-fixed-needs-close |

## Mutation Rules

- Change a row out of `real-open` only with a linked code/test/registry proof.
- `already-fixed-needs-close` requires a reproducible command or source proof
  and a planned registry CLI close operation.
- `superseded` requires a successor finding ID or `override_of` chain.
- `blocked` requires owner, external condition, and deadline evidence.
- `stale` requires a registry sweep rule or explicit context-manager review.
- `new-finding-required` is for evidence discovered during implementation that
  is not covered by the existing finding title/rule.

## Already-Fixed Evidence

- `INFRA-CRITICAL-021`: source validation on 2026-06-20 showed the main
  backend-common barrel no longer re-exports entity-bearing audit/GDPR/finding
  modules. The activated invariant
  `tests/invariants/no-shared-entity-decorators-via-main-barrel.spec.ts`
  permits only the token-only `../audit/audit-log.tokens` deep import and
  rejects concrete entity-bearing paths. Pending action: after the closing
  commit is reachable from `main`, run the registry close command with that
  commit.
- `INFRA-CRITICAL-025`: `apps/messaging-service/test/e2e-setup.ts` now
  re-exports canonical
  `@aquaculture/backend-common/context.withTenantContext` instead of defining a
  local AsyncLocalStorage helper. The active invariant
  `tests/invariants/messaging-e2e-tenant-context.spec.ts` rejects local
  `requestContextStorage`, `AsyncLocalStorage`, `getStore()`, and local
  `withTenantContext` definitions in the E2E harness. Pending action: registry
  close after merge/main reachability.
- `FARM-CRITICAL-001`: farm MinIO orphan cleanup already runs per tenant with
  canonical `withTenantContext` and `${tenantId}/` object prefixes; the new
  `tests/invariants/farm-minio-orphan-cleanup-ssot.spec.ts` pins that contract
  and the storage primitive's empty-live-set fail-closed gate. Pending action:
  registry close after merge/main reachability.
- `FARM-CRITICAL-050`: all mortality/cull stock mutation entry points now route
  through `MortalityCullPolicyService`, including the legacy
  `BatchService.recordOperation` path and cleaner-fish mortality handler. The
  new `tests/invariants/farm-stock-mutation-ssot.spec.ts` pins policy wiring
  before stock counter mutation. Pending action: registry close after
  merge/main reachability.

2026-06-20 local evidence for the four rows above:

```bash
./node_modules/.bin/jest --config tests/invariants/jest.config.ts --runTestsByPath tests/invariants/no-shared-entity-decorators-via-main-barrel.spec.ts tests/invariants/messaging-e2e-tenant-context.spec.ts tests/invariants/farm-minio-orphan-cleanup-ssot.spec.ts tests/invariants/farm-stock-mutation-ssot.spec.ts --runInBand
./node_modules/.bin/jest --config tests/invariants/jest.config.ts --runTestsByPath tests/invariants/invariant-reachability.spec.ts --runInBand
./node_modules/.bin/jest --config apps/farm-service/jest.config.ts apps/farm-service/src/batch/__tests__/services/batch.service.spec.ts apps/farm-service/src/batch/__tests__/handlers/record-cleaner-mortality.handler.spec.ts --runInBand
npm run findings:verify
./node_modules/.bin/eslint apps/messaging-service/test/e2e-setup.ts apps/farm-service/src/batch/services/batch.service.ts apps/farm-service/src/batch/handlers/record-cleaner-mortality.handler.ts apps/farm-service/src/batch/__tests__/services/batch.service.spec.ts apps/farm-service/src/batch/__tests__/handlers/record-cleaner-mortality.handler.spec.ts tests/invariants/messaging-e2e-tenant-context.spec.ts tests/invariants/no-shared-entity-decorators-via-main-barrel.spec.ts tests/invariants/farm-minio-orphan-cleanup-ssot.spec.ts tests/invariants/farm-stock-mutation-ssot.spec.ts
```

## Resolved Evidence

- `CLAUDE-CRITICAL-004`: registry state is `RESOLVED` with closing commit
  `7414faac`. `npx jest --config tests/invariants/jest.config.ts
tests/invariants/agent-ownership-uniqueness.spec.ts
tests/invariants/orchestrator-routing-coverage.spec.ts --runInBand` passed on
  2026-06-18, proving routing-table duplicate-primary and ownership conflicts
  stay mechanically guarded.
- `CLAUDE-CRITICAL-005`: registry state is `RESOLVED` with closing commit
  `7414faac`. The same routing coverage run passed 75/75 tests, including the
  reverse roster reachability checks that keep Lane-B agents dispatchable.
- `CLAUDE-CRITICAL-006`: registry state is `RESOLVED` with closing commit
  `00995511`. `npx jest --config tests/invariants/jest.config.ts
tests/invariants/agent-frontmatter-schema.spec.ts --runInBand` passed 421/421,
  proving every discovered active agent carries `tools:` frontmatter from the
  allowed token set.
- `EDGE-CRITICAL-001`: registry state is `RESOLVED` with closing commit
  `d792f74ac`. Repository-local CI coverage exists in
  `.github/workflows/ci-affected.yml`; the required-check SSOT is
  `.github/manifests/main-required-status-checks.json`; static enforcement
  passes through `npm run gates:required-status-checks`. On 2026-06-18, GitHub
  branch protection for `main` was updated from absent to strict required status
  checks with administrator enforcement, and
  `npm run gates:required-status-checks:live` passed, proving
  `sens-enterprise-summary` and `merge-gate` are required.
- `ORPHAN-CRITICAL-094`: registry state is `RESOLVED` with closing commit
  `1a51b1d4`. `npx jest --config libs/backend-common/jest.config.ts
libs/backend-common/src/utils/__tests__/service-identity.util.spec.ts
--runInBand` passed 24/24 on 2026-06-18, including the #388 policy-less keyring
  regression test that accepts catalog callers and rejects unknown callers.
- `MT-CRITICAL-050`: registry state is `RESOLVED` with closing commit
  `93b7d3df`. `npx vitest run --config vitest.config.ts
src/hooks/__tests__/useAuth-logout-wipe.spec.tsx
src/components/__tests__/IdentityBoundary.spec.tsx
src/pwa/__tests__/offline-queue.spec.ts` passed 68/68 on 2026-06-18, proving
  logout awaits persistent wipe, clears tenant React Query cache, and remounts
  authenticated UI on identity switch.
- `MT-CRITICAL-051`: registry state is `RESOLVED` with closing commit
  `93b7d3df`. The same AquaMobil Vitest run passed the user-scoped offline-cache
  regressions, proving user-private schedule/cache data is keyed by tenant and
  user rather than tenant only.
- `MSG-CRITICAL-050`: registry state is `RESOLVED` with closing commit
  `2bd191ed`. `npx jest --config apps/messaging-service/jest.config.ts
apps/messaging-service/src/event-handlers/messaging-nats.handler.broadcast.spec.ts
apps/messaging-service/src/message/resolvers/message-attachment.resolver.spec.ts
apps/messaging-service/src/message/dto/__tests__/send-message.input.spec.ts
--runInBand` passed 13/13 on 2026-06-18, proving the messaging service returns
  hydrated broadcast payloads instead of the old flat socket shape.
- `MSG-CRITICAL-051`: registry state is `RESOLVED` with closing commit
  `2bd191ed`. `npx vitest run --config vitest.config.ts
src/hooks/__tests__/useMarkRead.spec.ts
src/pwa/__tests__/sw-build-artifact.invariant.spec.ts
src/pwa/__tests__/firebase-messaging-sw.source.spec.ts
src/hooks/__tests__/useFirebaseMessaging-sw-scope.spec.tsx` passed 28/28 on
  2026-06-18, proving the mobile read path calls the `markMessagesRead` mutation
  and invalidates the SSoT unread surfaces.
- `MSG-CRITICAL-052`: registry state is `RESOLVED` with closing commit
  `2bd191ed`. The messaging-service Jest run above passed the
  `MessageAttachmentResolver` regression, proving attachment `downloadUrl` and
  `thumbnailUrl` are resolved through tenant-scoped presigned URLs.
- `MSG-CRITICAL-053`: registry state is `RESOLVED` with closing commit
  `9423fee0`. PR #531 passed the AquaMobil media-viewer regression, proving the
  viewer reads `MessageFields.attachments` from the channel-scoped message SSoT,
  pages older messages until the requested attachment is found, and fail-closes
  legacy attachment-only routes.
- `INFRA-CRITICAL-014`: registry state is `RESOLVED` with closing commit
  `07440547`. PR #533 added
  `tests/invariants/graphql-enum-valuesmap-metadata.spec.ts`, proving NestJS
  `registerEnumType` `valuesMap` entries stay metadata-only and unsupported
  `value` overrides cannot re-enter the codebase. PR #534 back-annotated the
  review anchor and removed the legacy three-store missing-anchor exception, so
  registry, review evidence, and invariant enforcement now share the same SSoT.
- `INFRA-CRITICAL-001`: registry state is `RESOLVED` with closing commit
  `9f58bef0fc5763a67f714ea2387e555fab58638a`. PR #536 passed GitHub Actions on
  2026-06-18, including build, changed-file type-check, security-audit, merge
  gate, and tenant-admin affected gates. Local evidence passed
  `npm run test --workspace @aquaculture/tenant-admin`, `npx nx lint tenant-admin`,
  `npx nx build tenant-admin`, the changed-file type-check command, and
  `npm audit --audit-level=high --omit=dev --json`, proving the tenant-admin
  build/audit blocker is closed without suppressions or allowlists.
- `INFRA-CRITICAL-006`: registry state is `RESOLVED` with closing commit
  `b34eff513c5b40a2627f76822f19b60c3b06da61`. PR #538 passed GitHub Actions on
  2026-06-18, including build, test, lint, type-check, invariants-fast,
  sens-api-gateway-rust, and merge-gate. Local evidence passed the new
  `tests/invariants/timescale-rls-columnstore-contract.spec.ts`, proving live
  migrations cannot configure TimescaleDB columnstore/compression on an
  RLS-protected relation; observability now treats the old
  `tenant_cost_rollup` migration as archive-only runtime-forensic evidence.
- `INFRA-CRITICAL-007`: registry state is `RESOLVED` with closing commit
  `b34eff513c5b40a2627f76822f19b60c3b06da61`. The same PR #538 evidence proves
  the RLS-over-columnstore architectural decision is mechanically enforced:
  tenant isolation remains the DB-level guard, and any future cold-storage
  compression must be modelled through a separate aggregate with its own
  tenant-scope contract instead of reintroducing columnstore on the RLS table.
- `INFRA-CRITICAL-008`: registry state is `RESOLVED` with closing commit
  `19d47218d24b95bfc5a1195a4f37fde7bbbc75b5`. PR #540 passed GitHub Actions on
  2026-06-18, including build, test, lint, type-check, invariants-fast,
  sens-enterprise-validation, and merge-gate. Local evidence passed
  `tests/invariants/required-signals-vs-emitters.spec.ts`,
  `npm run invariants:fast`, `npm run findings:verify`, and
  `npm run gates:required-status-checks`, proving deploy boot-signal authority
  is pinned to `db_migrate_complete` from `apps/db-migrate` and the legacy
  per-service `migration_runner_applied` signal cannot re-enter the required
  signal contract.
- `INFRA-CRITICAL-009`: registry state is `RESOLVED` with closing commit
  `802ed10fbe6f6309cb1919bfc8648a8dc069b6a0`. PR #549 merged to `main` as
  `c6329de7b5dec4058b8e614ac955abcdfe4848bb` after GitHub Actions passed on
  2026-06-19, including E2E messaging, build, test, lint, type-check,
  invariants-fast, bootstrap-from-scratch, tenant-clone-parity,
  sens-enterprise-validation, and merge-gate. The runtime
  `dataSource.synchronize()` authority was retired in favor of the migration
  ledger and toolchain SSoT. Enforcement now lives in
  `tests/invariants/no-runtime-synchronize.spec.ts`,
  `tests/invariants/toolchain-config-ssot.spec.ts`,
  `tools/lint-gates/eslint-toolchain-deprecation.spec.ts`,
  `tools/toolchain/run.mjs`, and `tools/toolchain/toolchain-runtime.mjs`, with
  backend-common lint contracts normalized so repository checks flow through
  the same toolchain path.
- `INFRA-CRITICAL-010`: registry state is `RESOLVED` with closing commit
  `5fc235a9a6fb68618f14ebb009efdba65929e46d`. PR #542 passed GitHub Actions on
  2026-06-18, including build, test, lint, type-check, invariants-fast,
  schema-validation, security-audit, sens-api-gateway-rust,
  sens-enterprise-validation, and merge-gate. Local evidence passed the active
  `tests/invariants/postgres-image-uniformity.spec.ts`,
  `tests/invariants/invariant-reachability.spec.ts`,
  `npm run invariants:fast`, `npm run gates:required-status-checks`, and
  affected lint/test. The Postgres image authority is now the
  `.github/manifests/postgres-image.json` SSoT, and every workflow/compose
  Postgres image reference must match the pgvector-capable digest-pinned
  TimescaleDB HA image.
- `INFRA-CRITICAL-017`: registry state is `RESOLVED` with closing commit
  `3913455c14fc50c177d858c693d0369fa019def8`. The Postgres SSL entrypoint now
  resolves the manifest runtime user at container start via `id -u/id -g` and
  all executable `chown` operations use `${PG_UID}:${PG_GID}`. Enforcement lives
  in `tests/invariants/postgres-runtime-contract.spec.ts`, which pins runtime
  ownership to `.github/manifests/postgres-image.json` so hardcoded numeric
  ownership cannot re-enter the wrapper.
- `INFRA-CRITICAL-018`: registry state is `RESOLVED` with closing commit
  `84f9004c64b6233a3bf978ec533c5fd6a145602b`. Concrete Postgres compose
  consumers use manifest `pgdata`, expose the same value through
  `services.postgres.environment.PGDATA`, and mount the `postgres_data` volume at
  that path. Enforcement lives in
  `tests/invariants/postgres-runtime-contract.spec.ts`, which compares every
  concrete compose consumer listed in `.github/manifests/postgres-image.json`
  against the runtime SSoT.
- `INFRA-CRITICAL-015`: registry state is `RESOLVED` with closing commit
  `b532d9a8e2a828535b8e7305f60b5556c330cea2`. PR #553 passed GitHub Actions on
  2026-06-19, including build, test, lint, type-check, E2E, invariants-fast,
  validate-closes, security-audit, schema-validation, sensor-service gates,
  sens-enterprise-validation, Rust gateway, and merge-gate. Local evidence
  passed `git diff --check`, `npx nx test service-catalog --runInBand`, and
  `npx tsc -p platform/libs/service-catalog/tsconfig.lib.json --noEmit`.
  Migration boot readiness ownership now lives in
  `platform/libs/service-catalog/src/index.ts` as
  `MIGRATION_BOOT_SIGNAL_CONTRACT`; `validateServiceCatalog()` rejects the
  retired `migration_runner_applied` signal and any duplicate
  `db_migrate_complete` ownership outside `db-migrate`, with regression
  coverage in `platform/libs/service-catalog/src/service-catalog.spec.ts`.
- `INFRA-CRITICAL-019`: registry state is `RESOLVED` with closing commit
  `fca70139788ec47ab6b5116b686cdbef58915ed6`. The original deploy blocker was
  removed from `MODULE_SCHEMAS` when `supplier_sites` and `site_contacts` were
  genuine orphan fan-out entries. The later farm-service wiring commit
  `11b9f54e65f9d1b460d09c23942dea290ad414f8` reintroduced both tables only with
  matching migration DDL, entity ownership, module registration, and
  `MODULE_SCHEMAS[farm].tables` alignment. Current validation passed
  `npx jest --config tests/invariants/jest.config.ts
  tests/invariants/tenant-fanout-entity-parity.spec.ts --runInBand`, proving
  every tenant-scoped entity has exactly one fan-out declaration and every
  `MODULE_SCHEMAS.tables` entry has a backing entity.
- `INFRA-CRITICAL-020`: registry state is `RESOLVED` with closing commit
  `9df598ed5d93b0dad38333eb6f50d1ccad4e8594`. PR #556 wired
  `tests/invariants/all-services-env-aware-migrations.spec.ts` into the
  invariant Jest registry shard and removed the stale auth-service
  `migrationsRun: true` allowance, making `migrationsRunFromEnv` the
  single fleet-wide migration timing contract. GitHub Actions passed
  `invariants-fast`, `validate-closes`, `banned-phrase-gate`, and
  `merge-gate` on 2026-06-19. Local validation passed
  `npx jest --config tests/invariants/jest.config.ts
  tests/invariants/all-services-env-aware-migrations.spec.ts --runInBand`,
  the paired messaging migration runner invariant, and `git diff --check`.
- `INFRA-CRITICAL-011`: registry state is `RESOLVED` with closing commit
  `1264a3060042861dd2e29fd145223a1211651323`. PR #544 passed GitHub Actions on
  2026-06-19, including E2E messaging, build, test, lint, type-check,
  invariants-fast, bootstrap-from-scratch, tenant-clone-parity,
  entity-diff-witness, migration-deletion-witness, sens-api-gateway-rust,
  sens-enterprise-validation, and merge-gate. Local evidence passed the active
  `tests/invariants/messaging-schema-ssot.spec.ts`,
  `tests/invariants/github-actions-tpm-deps-ssot.spec.ts`,
  `npm run gates:sens-enterprise-validation`, `npm run invariants:fast`,
  `npm run findings:verify`, `npm run gates:required-status-checks`, affected
  lint/test/build, YAML parsing for the touched Actions files, and
  `git diff --check`. The messaging schema DDL SSoT is now the TypeORM migration
  ledger plus platform bootstrap primitives; the stale service-local
  `init-messaging-schema.sql` authority was deleted. The CI TPM dependency SSoT
  is `.github/actions/install-tpm-build-dependencies/action.yml`, and the Sens
  enterprise gate now reads that local action instead of a duplicated raw apt
  literal.
- `INFRA-CRITICAL-012`: registry state is `RESOLVED` with closing commit
  `053f996a318801c351e86405385465cc14e2c75b`. PR #546 passed GitHub Actions on
  2026-06-19, including E2E messaging, build, test, lint, type-check,
  schema-validation, invariants-fast, sens-api-gateway-rust,
  sens-enterprise-validation, and merge-gate. Local evidence passed
  `tests/invariants/single-partition-creator.spec.ts`,
  `tests/invariants/messaging-partition-ddl-authority.spec.ts`,
  `tests/invariants/invariant-reachability.spec.ts`,
  `npm run invariants:fast`, `npm run findings:verify`,
  `npm run gates:required-status-checks`, affected lint/test/build, and
  `git diff --check`. Runtime partition child creation now has one SSoT:
  `PartitionManagerService` delegates to
  `platform.create_messaging_partition`. The unused raw partition creation
  query builders were removed, and the formerly dormant
  `single-partition-creator` invariant is active in the registry shard.
- `FE-CRITICAL-050`: registry state is `RESOLVED` with closing commit
  `109563f`. The AquaMobil Vitest run above passed the service-worker artifact
  invariant, proving `messaging-sw.ts` is emitted through `injectManifest` with
  background sync, precache, logout cache purge, and notification-click handlers.
- `MSG-CRITICAL-054`: registry state is `RESOLVED` with closing commit
  `109563f`. The messaging-service Jest run above passed the
  `SendMessageInput` envelope regression, proving offline `sendMessage` accepts
  the mobile command envelope while rejecting unknown fields.
