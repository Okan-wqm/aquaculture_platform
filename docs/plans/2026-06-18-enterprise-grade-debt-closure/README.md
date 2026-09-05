# Enterprise-Grade Debt Closure Program

Created: 2026-06-18

This plan is the governed execution artifact for raising `/var/aqua-saas` to a
more consistent enterprise-grade architecture. It is intentionally not a loose
roadmap: every sprint item must map to registry evidence, an owner agent, and a
machine-checkable exit gate.

The companion manifest is `manifest.json`. It captures the registry tip hash,
active finding counts, wave layout, sprint gates, and the adversarial
reverse-engineering review lanes. The initial Wave 0 finding truth table is
`finding-truth-table.md`. GitHub required status checks are governed by
`.github/manifests/main-required-status-checks.json` and enforced statically by
`npm run gates:required-status-checks`.

## Registry Snapshot

- Base commit: `2de67e4a5a6ffdcf675be0fcd4322854fcecd62f`
- Registry entries: 1835
- Registry tip hash: `6657881f756901f8eaf7e2bb2d6e9aecc2991f535637e09a0e3b7e641e438da6`
- OPEN findings: 302
- IN-PROGRESS findings: 63
- Active CRITICAL findings: 28
- `npm run findings:verify`: passing against registry tip `6657881f756901f8eaf7e2bb2d6e9aecc2991f535637e09a0e3b7e641e438da6`
- Worktree state at plan creation: dirty before this plan was written; existing
  source changes are treated as user work and are not part of this plan artifact.

## Operating Rules

- Registry truth comes first. If code or tests prove a finding is already fixed,
  the registry must be reconciled through the registry CLI before that item is
  planned as implementation work.
- No sprint can close with a CRITICAL/HIGH contradiction between registry,
  review files, tests, and commits.
- Every fix must close the root cause and add or reuse a test, invariant, or
  gate that catches recurrence.
- Direct edits to registry state, plan manifest, or control-plane files require
  CODEOWNERS coverage and `npm run findings:verify`.
- Plan counts and active CRITICAL rows are not manually trusted. The plan
  contract invariant compares `manifest.json` and `finding-truth-table.md`
  against `docs/reviews/_registry/findings.jsonl`; registry drift fails
  `npm run invariants:fast`.
- Required status checks for `main` are not prose. The SSOT is
  `.github/manifests/main-required-status-checks.json`; static drift fails
  `npm run gates:required-status-checks`, and external GitHub state must pass
  `npm run gates:required-status-checks:live` before EDGE closure, including
  administrator enforcement.
- Edge/Rust work is a parallel ray, but its stop-the-line gates start early:
  SENS required checks, RustSec, ADR-034 parity, and edge truth matrix are not
  final packaging tasks.

## Core Agents

The execution program uses these core agents as owners or mandatory reviewers:

- `architectural-arbiter`
- `context-manager`
- `prompt-writer`
- `data-expert`
- `multi-tenant-saas-expert`
- `auth-security-expert`
- `security-reviewer`
- `infra-expert`
- `performance-expert`
- `frontend-expert`
- `messaging-expert`
- `farm-expert`
- `edge-expert`

## Reverse-Engineering Attack Lanes

Each wave opens and closes with read-only adversarial review by these lanes:

- Architecture attacker
- Security attacker
- Performance/scalability attacker
- SSoT/control-plane attacker
- Data/schema/event-contract attacker
- Tenant/compliance attacker
- Product/realtime/mobile attacker
- Edge/Rust/industrial attacker

They do not implement. Their job is to break plan assumptions, find stale
registry state, identify missing gates, and reject paper-only closure.

## Waves

### Wave 0 - Truth Freeze And Control Plane

Sprint 0.1 creates the governed plan artifact, captures the registry hash, and
builds a truth table for active findings: `real-open`,
`already-fixed-needs-close`, `superseded`, `blocked`, `stale`, and
`new-finding-required`.

Sprint 0.2 makes the control plane trustworthy before domain work starts:
`invariants:fast` must be green, retired review scripts must be removed or
replaced, CODEOWNERS must cover active control-plane and plan paths, and the
plan manifest must be validated.

### Wave 1 - Stop-The-Line Platform Gates

Sprint 1.1 attacks remaining infra/schema/deploy boot blockers first, including
the active INFRA-CRITICAL entries listed in `manifest.active_critical_ids`,
tenant fan-out, runtime
`synchronize`, schema drift, HR/admin drift, and shared schema moves.

Sprint 1.2 closes security and performance foundation gates: service identity,
keyring bootstrap, Apollo Router signing, NATS least privilege, SLO SSoT,
token hot path performance, raw tenant metrics, and supply-chain blockers.

### Wave 2 - Tenant, Compliance, Data Contracts

Sprint 2.1 closes tenant trust and object-authorization foundations: tenant
source allowlists, shared-device cache isolation, server-side feature
entitlements, task assignee scope, and farm/site object authorization.

Sprint 2.2 defines the GDPR erasure event/outbox/legal-hold contract before
service handlers are implemented. `COMPLIANCE-CRITICAL-001` starts only after
schema fan-out, outbox, and legal-hold gates are green.

### Wave 3 - Messaging, Mobile, PWA Product Truth

Sprint 3.1 hardens product contracts before live behavior work: messaging cache
key SSoT, `gates:aquamobil-messaging-contracts`, GraphQL/codegen hard gates,
and messaging test-suite honesty.

Sprint 3.2 closes realtime, media, offline, and push paths with E2E and load
evidence: WS envelopes, read/edit/delete/typing, MediaViewer, attachment auth,
EXIF/MIME SSoT, service worker artifacts, and deployed `/mobile/` CSP proof.

### Wave 4 - Farm And Domain Workflow Integrity

Sprint 4.1 reconciles against
`docs/plans/2026-06-13-farm-module-enterprise-hardening.md`, then closes
destructive correctness: `FARM-CRITICAL-001`, `FARM-CRITICAL-050`, idempotency,
tank-batch membership, cull/mortality persistence, locks, and audit rows.

Sprint 4.2 closes farm readback, auth, and mobile parity: feeding enum casing,
harvest actor derivation, transfer input parity, pending transfer counts, daily
counts, FCR correctness, stale KPI invalidation, and product E2E.

### Wave 5 - Edge/Rust Parallel Ray

Sprint 5.1 builds the edge truth matrix against ADR-034, the edge v2 plan, RC4
evidence, and current registry state. It closes SENS required-check evidence,
RustSec blockers, TypedAuthz/co-approver evidence, ADR-034 schema parity, and
edge NATS/event-contract parity.

Sprint 5.2 closes edge runtime foundations: OPC UA TLS lifecycle, brute-force
throttle, session quotas, subscription notifier, config reload, SQLCipher v1 to
v2 migration, clock authority, mTLS/cert rotation, and Rust PR gates.

### Wave 6 - Closure, Evidence, Release Discipline

Sprint 6.1 adds release-grade evidence: k6 baseline, WebSocket load tests, DB
EXPLAIN gate, bundle/PWA budgets, edge signed manifest, SBOM, cosign verify,
SLSA/in-toto provenance, and exact tag/Cargo parity.

Sprint 6.2 is closure-only: registry sweep, full invariants, affected
lint/test/build, targeted product E2E, edge gates, final manifest hash update,
and no active CRITICAL/HIGH without valid BLOCKED evidence.

## Required Commands

Every sprint exit:

```bash
npm run findings:verify
npm run invariants:fast
npm run gates:required-status-checks
nx affected --target=test
nx affected --target=lint
nx affected --target=build
```

Wave-specific exits add the targeted gates in `manifest.json`.

## Initial Blockers

These are not optional work items. They block normal domain execution:

- `npm run invariants:fast` must pass.
- Registry/code contradictions must be reconciled through the registry CLI.
- Active CRITICAL findings must be assigned or validly marked BLOCKED.
- Product contract gate `gates:aquamobil-messaging-contracts` must be green
  before messaging/mobile closure.
- Edge required-check evidence must exist before edge closure claims. As of
  2026-06-18, `npm run gates:required-status-checks:live` passes and proves
  `main` enforces administrators and requires `sens-enterprise-summary` and
  `merge-gate` with strict status checks.

## Closure Ledger

- 2026-06-20: DigitalOcean release orchestration SSoT was corrected on branch
  `codex/ssot-critical-implementation`. `.github/workflows/ci-affected.yml`
  now owns the push-to-main release chain: quality gates, staging reusable
  workflow, production `Deploy to DigitalOcean` reusable workflow with
  `services: auto`, and `Production Post-Deploy Verify` only when production
  reports `deployed == true`. The deploy-config path filter now includes
  `.github/workflows/production-post-deploy-verify.yml`, and recurrence is
  pinned by `tests/invariants/deploy-ssot-contract.spec.ts` plus
  `tests/invariants/production-ops-proof-contract.spec.ts`.
- 2026-06-20: `COMPLIANCE-CRITICAL-001` implementation evidence was prepared
  on branch `codex/ssot-critical-implementation`; registry closure is still
  pending commit SHA, `npm run findings:verify`, and CI evidence. The slice
  establishes `TENANT_ERASURE_TARGET_SERVICES` as the event-contract SSoT,
  adds a shared `TenantErasureTargetModule`/registry/executor in
  `backend-common`, wires all 10 tenant-data target services, adds the missing
  durable outbox modules/migrations, and makes admin-api the only final
  orchestrator. Final `TenantErased` is emitted only after every target proof is
  recorded and db-migrate proves tenant-schema deletion through the
  `tenant_erasure` cleanup proof path. Recurrence gates were added through
  `tests/invariants/tenant-erasure-ssot.spec.ts`, strengthened critical infra
  and env-aware migration invariants, targeted event-contract, admin, farm, and
  db-migrate tests, and per-service type-checks.
- 2026-06-20: first implementation slice for the active CRITICAL truth table
  closed `INFRA-CRITICAL-021`, `INFRA-CRITICAL-025`, `FARM-CRITICAL-001`, and
  `FARM-CRITICAL-050` with closing commit
  `4d08ba21985b27aaf91de4a9cdbab131801f5bbb` after PR #560 merged to `main`.
  Code changes converged messaging E2E tenant context on
  `@aquaculture/backend-common/context.withTenantContext`; routed legacy farm
  `BatchService.recordOperation` and cleaner-fish mortality through
  `MortalityCullPolicyService`; activated
  `no-shared-entity-decorators-via-main-barrel` and
  `messaging-e2e-tenant-context`; added farm MinIO cleanup and stock-mutation
  SSoT invariants; and removed active specs from the dormant manifest. GitHub
  Actions on PR #560 passed, including `invariants-fast`, `validate-closes`,
  E2E, build, lint, type-check, test, `sens-api-gateway-rust`,
  `sens-enterprise-summary`, and `merge-gate`.
- 2026-06-19: `INFRA-CRITICAL-011` closed by PR #544, merge commit
  `1264a3060042861dd2e29fd145223a1211651323`. The messaging schema DDL
  authority is now TypeORM migrations plus platform bootstrap only; the stale
  service-local init SQL was deleted. Recurrence is guarded by
  `tests/invariants/messaging-schema-ssot.spec.ts` and the TPM CI dependency
  local action SSoT is guarded by
  `tests/invariants/github-actions-tpm-deps-ssot.spec.ts` plus
  `tools/gates/sens-enterprise-validation.ts`.
- 2026-06-19: `INFRA-CRITICAL-012` closed by PR #546, merge commit
  `053f996a318801c351e86405385465cc14e2c75b`. Messaging partition child
  creation has one runtime path: `PartitionManagerService` delegates to the
  platform SECURITY DEFINER primitive `platform.create_messaging_partition`.
  The stale raw partition creation query builders were removed, and
  `tests/invariants/single-partition-creator.spec.ts` is active in the registry
  invariant shard.
