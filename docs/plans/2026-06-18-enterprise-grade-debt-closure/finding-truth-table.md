# Finding Truth Table

Created: 2026-06-18

Registry tip: `b216cd2408aa80e31fc851db2b285e076010f659c911f7cbaa91ade54bbf07b9`

This is the Wave 0 truth table for active CRITICAL findings. The initial rule is
conservative: every non-RESOLVED CRITICAL registry entry is treated as
`real-open` until code, tests, and registry evidence prove a different bucket.

Updated 2026-07-02: the 2026-06-18 snapshot listed 13 active CRITICALs. The
2026-07-02 registry-closeout reconciliation (216 stale-registry state flips
re-applied onto main's then-current 587-entry chain — see the registry's own
`closing_commits` per finding for the merged fix evidence) resolved 11 of the
13: `COMPLIANCE-CRITICAL-001`, `INFRA-CRITICAL-023/024/026/027/028/030/031/032`,
`DEPLOY-CRITICAL-008`, `MT-CRITICAL-052`, `FARM-CRITICAL-060`. Only the three rows
below remain active; `INFRA-CRITICAL-029` itself stayed OPEN because its
would-be closers (`INFRA-CRITICAL-031`/`032`) close it only via a
sibling-trailer pattern the automated close ceremony does not certify — that is
tracked separately, not asserted here as resolved.

Updated 2026-07-07: reconciling the sensor/VFD/device-audit registry entries
(PR #886) onto main's chain surfaced two active CRITICALs whose fixes already
landed on the audit branch but whose registry rows stay OPEN until the
post-merge close ceremony records a main-reachable closing commit (PROC-HIGH-001,
`close` refuses branch-local SHAs): `SENSOR-CRITICAL-002` (HTTP-REST SSRF, closed
by the W1 network-security workstream) and `SENSOR-CRITICAL-003` (VFD tab
visibility, closed by the W5 frontend workstream). Both are `already-fixed-needs-close`.

Updated 2026-07-11: the reporting-line post-merge close ceremony (PRs #929/#937
merged; ceremony commit records main-reachable closing commits) RESOLVED six of
the audit-era criticals that sat in `already-fixed-needs-close` —
`FARM-CRITICAL-161`, `-163`, `-165`, `-168`, `-169`, `-171` — so their rows leave
the active table below (the table mirrors `active_critical_ids` exactly; the
contract invariant enforces the bijection). 8 active CRITICALs remain.

Updated 2026-07-12: reconciling the unified-SCADA-editor audit entries (PR #941)
onto the chain temporarily added three active CRITICALs
(`SENSOR-CRITICAL-004/005/006`) as `already-fixed-needs-close` while their
registry rows awaited the post-merge close ceremony.

Updated 2026-07-12 (close ceremony): PR #941 merged to main
(merge `f8974ea3`, a true merge — every fix commit is main-reachable), and the
post-merge close ceremony recorded a main-reachable closing commit for each of
the 42 findings that PR fixed. `SENSOR-CRITICAL-004` (68299d3d),
`SENSOR-CRITICAL-005` (a5edc846), and `SENSOR-CRITICAL-006` (ed3685e8) are now
RESOLVED and leave the active table below (the table mirrors
`active_critical_ids` exactly; the contract invariant enforces the bijection).
9 active CRITICALs remain.

Updated 2026-07-15: the control-plane stop-line reconciliation registered nineteen
new IN-PROGRESS findings and one OPEN frontend test-baseline finding without
changing the active CRITICAL set. The backup/DR audit then registered one OPEN,
two IN-PROGRESS, and one BLOCKED HIGH finding, again without changing the active
CRITICAL set. At that historical checkpoint the registry contained 950 entries;
later updates below supersede that snapshot and the header reflects the current
registry tip.

Updated 2026-07-15 (backup/DR closure reconstruction): the registry now contains
980 entries. `INFRA-CRITICAL-040` remains blocked on an independently trusted DR
notary; `INFRA-CRITICAL-041` and `INFRA-CRITICAL-042` have local fixes and tests
but remain IN-PROGRESS until their closing commit is merged and the post-merge
registry ceremony records a main-reachable SHA.

Updated 2026-07-16 (adversarial backup execution-boundary review): the registry
now contains 991 entries. `INFRA-CRITICAL-043` has a local exact-commit runner
bundle fix and remains IN-PROGRESS until merge/close ceremony.
`INFRA-CRITICAL-044` remains an OPEN production blocker: an absolute sanitized
inner shell cannot secure the earlier sshd/login-shell startup boundary, so a
dedicated root-owned backup account and forced-command broker must be proven on
the target before production closure.

Updated 2026-07-16 (protected-job authority review): seven additional findings
were registered IN-PROGRESS, bringing the registry to 998 entries.
`INFRA-CRITICAL-045` has local job-level main guards, exact-SHA checkout and
parsed workflow invariants, but remains IN-PROGRESS until merge and the
post-merge close ceremony records a main-reachable closing commit.

Updated 2026-07-17 (control-plane and DR close ceremony): PR #1003 merged to
main as `ccce62224`. PRs #1002 and #1006 subsequently added 24 farm/feed and
capacity-review records, so the ceremony was rebuilt on `main@7e2be9b0b` and
retained all 1,022 entries. The registry CLI verified the exact `Closes:`
trailer and main reachability for 62 findings, including
`INFRA-CRITICAL-041/042/043/045`, then re-chained the ledger. Those four
CRITICAL rows are RESOLVED and leave the active table. The independent notary
(`INFRA-CRITICAL-040`) and production forced-command broker cutover
(`INFRA-CRITICAL-044`) remain blocked by external operator evidence;
production deployment remains locked.

Updated 2026-07-17 (farm/feed cutover adversarial review): five concrete
single-ledger blockers were registered IN-PROGRESS, bringing the registry to
1,028 entries. Four are active CRITICALs: depleted feed can fail open without a
movement (`FARM-CRITICAL-237`), the legacy-balance backfill lacks row-level
reconciliation provenance (`FARM-CRITICAL-238`), concurrent NULL-lot receipts
can split the canonical projection (`FARM-CRITICAL-240`), and migration rollback
can erase live drain writes (`FARM-CRITICAL-241`). They remain `real-open` until
the implementation wave supplies PostgreSQL concurrency, rerun, rollback, and
parity evidence.

Updated 2026-07-18 (production host control-plane recurrence review): exact-main
capacity evidence registered four new active findings and closed the already
merged default-deny image-tag gap. Two findings are CRITICAL and enter the
active table: `INFRA-CRITICAL-077` covers the missing host-global lock between
DR recovery and capacity/deploy mutation; `INFRA-CRITICAL-078` covers the
production deploy/capacity recurrence of opaque, unpinned SSH and mutable
target-host Git authority. Both remain `real-open` until native fingerprinted
transport, hermetic release material, the shared lock, and adversarial recovery
tests merge.

Allowed truth buckets:

- `real-open`
- `already-fixed-needs-close`
- `superseded`
- `blocked`
- `stale`
- `new-finding-required`

| Finding                 | Registry state | First sprint | Owner                      | Truth bucket              |
| ----------------------- | -------------- | ------------ | -------------------------- | ------------------------- |
| `INFRA-CRITICAL-029`    | OPEN           | 1.1          | data-expert                | real-open                 |
| `FARM-CRITICAL-061`     | OPEN           | 1.1          | farm-expert                | real-open                 |
| `AISAFETY-CRITICAL-003` | OPEN           | —            | ai-safety-auditor          | already-fixed-needs-close |
| `SENSOR-CRITICAL-003`   | OPEN           | —            | sensor-expert              | already-fixed-needs-close |
| `DATA-CRITICAL-001`     | OPEN           | —            | data-expert                | real-open                 |
| `INFRA-CRITICAL-039`    | OPEN           | —            | infra-expert               | already-fixed-needs-close |
| `RBAC-CRITICAL-001`     | OPEN           | 1.2          | auth-security-expert       | already-fixed-needs-close |
| `RBAC-CRITICAL-002`     | OPEN           | 1.2          | auth-security-expert       | already-fixed-needs-close |
| `RBAC-CRITICAL-003`     | OPEN           | 1.2          | auth-security-expert       | already-fixed-needs-close |
| `INFRA-CRITICAL-040`    | IN-PROGRESS    | —            | infra-expert               | blocked                   |
| `INFRA-CRITICAL-044`    | OPEN           | —            | infra-expert               | blocked                   |
| `FARM-CRITICAL-237`     | IN-PROGRESS    | 4.1          | farm-expert                | real-open                 |
| `FARM-CRITICAL-238`     | IN-PROGRESS    | 4.1          | data-expert                | real-open                 |
| `FARM-CRITICAL-240`     | IN-PROGRESS    | 4.1          | data-expert                | real-open                 |
| `FARM-CRITICAL-241`     | IN-PROGRESS    | 4.1          | data-expert                | real-open                 |
| `INFRA-CRITICAL-077`    | IN-PROGRESS    | 1.1          | infra-expert               | real-open                 |
| `INFRA-CRITICAL-078`    | IN-PROGRESS    | 1.1          | security-reviewer          | real-open                 |
| `ORPHAN-CRITICAL-418`   | OPEN           | —            | aria-acceptance-gap-hunter | already-fixed-needs-close |
| `ORPHAN-CRITICAL-419`   | OPEN           | —            | aria-acceptance-gap-hunter | real-open                 |
| `ORPHAN-CRITICAL-420`   | OPEN           | —            | aria-acceptance-gap-hunter | real-open                 |
| `ORPHAN-CRITICAL-427`   | OPEN           | —            | aria-acceptance-gap-hunter | already-fixed-needs-close |
| `ORPHAN-CRITICAL-428`   | OPEN           | —            | aria-acceptance-gap-hunter | real-open                 |
| `ORPHAN-CRITICAL-439`   | OPEN           | —            | aria-acceptance-gap-hunter | already-fixed-needs-close |
| `ORPHAN-CRITICAL-440`   | OPEN           | —            | aria-acceptance-gap-hunter | already-fixed-needs-close |
| `ORPHAN-CRITICAL-446`   | OPEN           | —            | aria-acceptance-gap-hunter | already-fixed-needs-close |
| `ORPHAN-CRITICAL-451`   | OPEN           | —            | aria-acceptance-gap-hunter | already-fixed-needs-close |
| `ORPHAN-CRITICAL-460`   | OPEN           | —            | aria-acceptance-gap-hunter | already-fixed-needs-close |
| `ORPHAN-CRITICAL-461`   | OPEN           | —            | aria-acceptance-gap-hunter | already-fixed-needs-close |
| `ORPHAN-CRITICAL-469`   | OPEN           | —            | aria-acceptance-gap-hunter | already-fixed-needs-close |
| `ORPHAN-CRITICAL-479`   | OPEN           | —            | aria-acceptance-gap-hunter | already-fixed-needs-close |
| `ORPHAN-CRITICAL-484`   | OPEN           | —            | aria-acceptance-gap-hunter | already-fixed-needs-close |
| `ORPHAN-CRITICAL-485`   | OPEN           | —            | aria-acceptance-gap-hunter | already-fixed-needs-close |

Updated 2026-07-26 (ARIA control-plane audit): seven ORPHAN CRITICALs joined the
active set. Five come from the audit of ARIA's own control plane — a corrupted
failure ledger silently un-tripping the breaker, a producer and executor that
share no queue, budget and breaker enforcement with zero production callers, a
bash sandbox perimeter with no caller, and a hard-fail registry that was pure
data. Two were found by auditing that audit's own fixes: containment with no
sandbox backend installed anywhere, and an observe burn-in that rejected the
runtime writes it exists to produce. Four are marked
`already-fixed-needs-close` with their closing commits below; the registry CLI
close operations follow once this branch merges, because a `Closes:` trailer on
an unmerged commit is a claim, not evidence.

Updated 2026-07-27 (self-audit of the audit branch): `ORPHAN-CRITICAL-446`
joined the active set. The commit titled "make all three convergence
independence layers functional" left the cross-reviewer's text hardcoded to
`None` at the point the round's dispatch map is recorded, so the diversity
layer short-circuited on `cross_review_text_unavailable` and computed neither
of the two comparisons it exists for. Worse than a no-op: every `converged`
verdict was unconditionally downgraded to `cross_review_self_agreement`, making
convergence structurally unreachable. Bucketed `already-fixed-needs-close`
because the fix and its eight regression tests are in this branch; the registry
close waits for merge, like the rows above it.

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

- `ORPHAN-CRITICAL-418` — fixed in `8c30bd69b` predecessor / `d1c3399ee` here; see the commit body for the mechanism and the regression test.
- `ORPHAN-CRITICAL-427` — fixed in `873f038f8` predecessor / `05153e93d` here; see the commit body for the mechanism and the regression test.
- `ORPHAN-CRITICAL-439` — fixed in `55cd94464`; see the commit body for the mechanism and the regression test.
- `ORPHAN-CRITICAL-440` — fixed in `55cd94464`; see the commit body for the mechanism and the regression test.
- `ORPHAN-CRITICAL-446` — fixed in this branch; `aria-kernel/tests/test_cross_review_independence_text.py` pins both the pre-fix shape and the echo-chamber catch.
- `ORPHAN-CRITICAL-451` — fixed in this branch; firejail removed as an accepted sandbox backend because its branch applied none of the READONLY_PATHS while satisfying the S0 exit criterion. `aria-kernel/tests/test_sandbox_and_perimeter_hardening.py` pins it.
- `ORPHAN-CRITICAL-460` — fixed in this branch; a shell control operator after an allowed prefix bypassed the allowlist, the denylist and the force-push check at once. Same test file pins eleven bypass spellings and nine non-regressions.
- `ORPHAN-CRITICAL-461` — fixed in this branch; broader-scope claims, globs, empty surface lists, an echo of the canonical suite, and every gh-api route that writes main all passed. Same test file pins them.
- `ORPHAN-CRITICAL-484` — fixed in this branch; the executor could publish a queue-less bootstrapped tree under the canonical artifact name because the steps preceding the integrity gate index the tree. The publish now requires positive ancestry proof from the restore step, and a blocked publish is RED rather than green.
- `ORPHAN-CRITICAL-485` — fixed in this branch; the breaker producer was unreachable on the scheduled lane at four levels and its test called a private function with a synthetic error. Moved to the planner dispatch timeout arm the nightly genuinely walks, tested through the public entry point, verified failing with the producer deleted.
- `ORPHAN-CRITICAL-479` — fixed in this branch; a NameError on the only real worker-dispatch path shipped with 2905 passing tests because nothing covers that callsite. `aria-kernel/tests/test_executor_unbound_names.py` now statically resolves every loaded name in the three spawn-path modules; the first two versions of that detector passed with the bug reintroduced and are documented in the file.
- `ORPHAN-CRITICAL-469` — fixed in this branch; the agent-invocation queue was stranded between the 01:00 producer and the 02:00 consumer because the executor workflow had no state-restore step, so `next_pending_request` always read a bootstrap-empty tree. The same missing restore left the cross-host lease preflight unable to observe a held lease. `.github/workflows/aria-agent-executor.yml` now restores and republishes the tree, gated on the integrity verdict, and `test_workflow_enterprise_preflight` pins the YAML against the registered contract.

- `AISAFETY-CRITICAL-003` (single process-global `ANTHROPIC_API_KEY`, no per-tenant
  key — BYOK impossible): the Faz 1 BYOK work (encrypted per-tenant credentials +
  the `LlmProvider` abstraction + the settings CRUD) implements the fix; the
  registry row stays OPEN only until the post-merge close ceremony records a
  main-reachable closing commit (`close` refuses branch-local SHAs, PROC-HIGH-001).

- `SENSOR-CRITICAL-002` (HTTP-REST sensor adapter fetches an operator-controlled
  URL with no host/IP/protocol validation — SSRF enabling cloud-metadata
  credential theft): the W1 network-security workstream on the sensor audit branch
  routes every outbound adapter fetch/socket through `SsrfValidatorService`
  (`validateUrl` / `validateHost` — DNS-pre-resolve + private/metadata/CGNAT IP
  denylist + `redirect:'error'`), so metadata endpoints and private ranges are
  rejected before a connection opens. The registry row stays OPEN only until the
  post-merge close ceremony records a main-reachable closing commit.
- `SENSOR-CRITICAL-003` (VFD tab renders sensor data and has no VFD list/detail
  wiring — registered VFD devices are invisible): the W5 frontend workstream moved
  `useVfdDevices`/`useVfdStats`/`useVfdDevice` onto the TanStack Query +
  `createTenantQueryKey` pattern and wired the DevicesPage VFD tab and detail route
  to VFD data, so registered drives are visible. The registry row stays OPEN only
  until the post-merge close ceremony records a main-reachable closing commit.

The 2026-06-20 registry close follow-up left no OTHER active CRITICAL in
`already-fixed-needs-close`; reconciled items moved to `Resolved Evidence`.

## Implementation Evidence Pending Registry Close

- `COMPLIANCE-CRITICAL-001`: implementation branch
  `codex/ssot-critical-implementation` now carries the GDPR tenant-erasure
  SSoT architecture, but the registry row remains OPEN until the branch is
  committed, CI evidence is attached, and the registry CLI records the closing
  commit. The architectural proof is not service-local: the target roster lives
  in `libs/event-contracts/src/tenant-erasure-targets.ts`; reusable target
  execution lives under
  `libs/backend-common/src/compliance/tenant-erasure/`; every target service is
  wired through the shared module or the farm-specific domain handler; admin-api
  owns the operation ledger, proof aggregation, db-migrate schema-deletion
  request, and final `TenantErased` event. The guardrail is
  `tests/invariants/tenant-erasure-ssot.spec.ts` plus the strengthened
  outbox/infrastructure and migration-timing invariants.

## Resolved Evidence

- `SENSOR-CRITICAL-001` + `ALERT-CRITICAL-001`: registry state is `RESOLVED` with
  closing commit `9c3155b45` (PR #651, the trailer-carrier). PR #610
  (`3dc425092`, "transactional-outbox SSoT for domain events") moved
  sensor-service and alert-engine domain-event publishing onto
  `OutboxPublisher.enqueue(event, manager)` — atomic with the write, eliminating
  the fire-and-forget path the findings describe. They could not be closed
  against #610 directly (no `Closes:` trailer); #651 carried the trailers so the
  registry close-ceremony tool accepted it as the main-reachable closer.

- `BILLING-CRITICAL-001`: registry state is `RESOLVED` with closing commit
  `87555ff6f`. PR #640 (real Stripe integration) converted the last
  fire-and-forget money handler (create-subscription) to the transactional
  outbox + wired the real Stripe path, carrying the `Closes:` trailer; closed
  via the registry close-ceremony tool.
- `INFRA-CRITICAL-021`: registry state is `RESOLVED` with closing commit
  `4d08ba21985b27aaf91de4a9cdbab131801f5bbb`. PR #560 activated
  `tests/invariants/no-shared-entity-decorators-via-main-barrel.spec.ts`,
  allowing only token-only audit deep imports while rejecting concrete
  entity-bearing backend-common barrel paths.
- `INFRA-CRITICAL-025`: registry state is `RESOLVED` with closing commit
  `4d08ba21985b27aaf91de4a9cdbab131801f5bbb`. PR #560 changed
  `apps/messaging-service/test/e2e-setup.ts` to re-export canonical
  `@aquaculture/backend-common/context.withTenantContext`; the active
  `tests/invariants/messaging-e2e-tenant-context.spec.ts` rejects local
  AsyncLocalStorage helpers in the E2E harness.
- `FARM-CRITICAL-001`: registry state is `RESOLVED` with closing commit
  `4d08ba21985b27aaf91de4a9cdbab131801f5bbb`. PR #560 pins tenant-scoped MinIO
  cleanup through `tests/invariants/farm-minio-orphan-cleanup-ssot.spec.ts`,
  covering per-tenant `withTenantContext`, `${tenantId}/` prefixes, and the
  storage primitive's empty-live-set fail-closed behavior.
- `FARM-CRITICAL-050`: registry state is `RESOLVED` with closing commit
  `4d08ba21985b27aaf91de4a9cdbab131801f5bbb`. PR #560 routed legacy
  `BatchService.recordOperation` and cleaner-fish mortality through
  `MortalityCullPolicyService`; recurrence is pinned by
  `tests/invariants/farm-stock-mutation-ssot.spec.ts` plus farm unit
  regression tests.
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
- `SENSOR-CRITICAL-004` (WS control-plane RS256→HS256 algorithm-confusion
  bypass): PR #941 routes SCADA socket JWT verification through the platform
  RS256-only path and broadens `tests/invariants/jwt-rs256-only.spec.ts`.
  Reproducible proof: the sensor-service scada-runtime auth specs + the JWT
  invariant pass on the branch. The row stays IN-PROGRESS until the post-merge
  close ceremony records the main-reachable closing commit.
- `SENSOR-CRITICAL-005` (WS `TAG_WRITE` accepted without a tenant fence):
  PR #941 tenant-fences TAG_WRITE, resolves targets against the unified tag
  registry, and replaces the fake ack with an honest `queued` result.
  Reproducible proof: `apps/sensor-service/src/scada-runtime` gateway specs on
  the branch. IN-PROGRESS until the post-merge close ceremony.
- `SENSOR-CRITICAL-006` (control-security PINs stored plaintext and compared
  client-side): PR #941 moves the secret server-side (scrypt `pinHash` at save,
  read-path redaction, `PIN_VERIFY` socket verification with lockout, tag-keyed
  TAG_WRITE elevation). Reproducible proof:
  `apps/sensor-service/src/process/services/__tests__/pin-control-security.spec.ts`
  - gateway elevation specs on the branch. IN-PROGRESS until the post-merge
    close ceremony.
