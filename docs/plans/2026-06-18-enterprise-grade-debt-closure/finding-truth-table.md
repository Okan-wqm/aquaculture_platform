# Finding Truth Table

Created: 2026-06-18

Registry tip: `c9f9b213f227609909806b3574aeb1bf9f2f00837086d20cd4892995ec324e7d`

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
| `INFRA-CRITICAL-011`      | IN-PROGRESS    | 1.1          | messaging-expert         | real-open    |
| `INFRA-CRITICAL-012`      | IN-PROGRESS    | 1.1          | messaging-expert         | real-open    |
| `INFRA-CRITICAL-009`      | IN-PROGRESS    | 1.1          | data-expert              | real-open    |
| `INFRA-CRITICAL-015`      | IN-PROGRESS    | 1.1          | infra-expert             | real-open    |
| `INFRA-CRITICAL-017`      | IN-PROGRESS    | 1.1          | infra-expert             | real-open    |
| `INFRA-CRITICAL-018`      | IN-PROGRESS    | 1.1          | infra-expert             | real-open    |
| `INFRA-CRITICAL-019`      | IN-PROGRESS    | 1.1          | data-expert              | real-open    |
| `INFRA-CRITICAL-020`      | IN-PROGRESS    | 1.1          | messaging-expert         | real-open    |
| `INFRA-CRITICAL-021`      | IN-PROGRESS    | 1.1          | data-expert              | real-open    |
| `INFRA-CRITICAL-023`      | IN-PROGRESS    | 1.1          | data-expert              | real-open    |
| `INFRA-CRITICAL-024`      | IN-PROGRESS    | 1.1          | infra-expert             | real-open    |
| `INFRA-CRITICAL-025`      | IN-PROGRESS    | 1.1          | messaging-expert         | real-open    |
| `INFRA-CRITICAL-026`      | IN-PROGRESS    | 1.1          | data-expert              | real-open    |
| `INFRA-CRITICAL-027`      | IN-PROGRESS    | 1.1          | data-expert              | real-open    |
| `INFRA-CRITICAL-028`      | IN-PROGRESS    | 1.1          | data-expert              | real-open    |
| `INFRA-CRITICAL-029`      | OPEN           | 1.1          | data-expert              | real-open    |
| `INFRA-CRITICAL-030`      | IN-PROGRESS    | 1.1          | data-expert              | real-open    |
| `INFRA-CRITICAL-031`      | IN-PROGRESS    | 1.1          | data-expert              | real-open    |
| `INFRA-CRITICAL-032`      | IN-PROGRESS    | 1.1          | data-expert              | real-open    |
| `FARM-CRITICAL-050`       | OPEN           | 4.1          | workflow-state-auditor   | real-open    |
| `FARM-CRITICAL-001`       | IN-PROGRESS    | 4.1          | multi-tenant-saas-expert | real-open    |

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

No active CRITICAL finding remains in `already-fixed-needs-close` after the
2026-06-18 Wave 0 registry reconciliation. Reconciled items moved to
`Resolved Evidence`.

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
- `FE-CRITICAL-050`: registry state is `RESOLVED` with closing commit
  `109563f`. The AquaMobil Vitest run above passed the service-worker artifact
  invariant, proving `messaging-sw.ts` is emitted through `injectManifest` with
  background sync, precache, logout cache purge, and notification-click handlers.
- `MSG-CRITICAL-054`: registry state is `RESOLVED` with closing commit
  `109563f`. The messaging-service Jest run above passed the
  `SendMessageInput` envelope regression, proving offline `sendMessage` accepts
  the mobile command envelope while rejecting unknown fields.
