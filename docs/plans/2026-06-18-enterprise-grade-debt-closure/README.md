# Enterprise-Grade Debt Closure Program

Created: 2026-06-18
Control-plane status reviewed: 2026-07-30

Program status is `ACTIVE`. This dated record is not a completion claim: the
P1 control-plane blockers below must produce their listed machine evidence
before the affected integration units can advance.

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
- Registry entries: 1251
- Registry tip hash: `173930c0f64e30085e7b09f1d1a109f9cc45b7e2e116325007720e4a80424955`
- OPEN findings: 486
- IN-PROGRESS findings: 42
- Active CRITICAL findings: 41
- `npm run findings:verify`: passing against registry tip `173930c0f64e30085e7b09f1d1a109f9cc45b7e2e116325007720e4a80424955`
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

## Capability Reconciliation Frontier — 2026-07-29

`manifest.json.capability_reconciliation` is the sole execution record for the
unmerged branches, unmerged local refs, and dirty worktrees observed at
`2026-07-29T10:17:45Z`. The refs are pinned as evidence sources; they are not
the integration unit.

The dated observation contains 44 losslessly retained sources, 44
source-adjudication queues, 13 typed source slices, and 126 atomic integration
units. The exact base is read only from
`manifest.json.capability_reconciliation.reconciled_base_sha`; the narrative
does not duplicate it. Every source has exactly one adjudication queue, but a
source never owns behavior and is never itself an integration unit. A source
slice is typed, digest-bound provenance with `authority_role=PROVENANCE_ONLY`,
and exactly one integration unit may reference it. `capability_groups` are
reporting indexes only: they cannot own a source, finding, dependency, gate,
strategy, or runtime authority.

An `integration_unit` is one root-cause behavior with one globally unique
`authority_key`. Its `strategy` is the only execution decision. Source
`disposition` remains source-level forensic classification and cannot select
an integration strategy. Each unit is evaluated against the reconciled base:

1. If main already owns the behavior and its acceptance evidence, the source
   contributes no code.
2. If a source contains a unique, current, root-cause implementation, only the
   minimal coherent commit set may be cherry-picked onto a fresh-main worktree.
3. If the capability is absent from main but the source implementation is
   stale, conflicted, duplicated, or structurally weaker, the capability is
   implemented again from fresh main under the current SSoT.
4. A merge commit is only a transport mechanism after every carried behavior
   maps to an atomic unit and passes its own evidence contract; branch-level
   approval cannot replace capability adjudication.
5. Dirty worktrees remain read-only evidence until their changes are decomposed
   into atomic capabilities. No cleanup, reset, checkout, or conflict
   resolution may alter them during assessment.

`ALREADY_ON_MAIN` is a typed proof, not a narrative claim. A remote source must
carry either `ANCESTOR` or complete-tree `TREE_EQUIVALENT` evidence with
full-length Git object IDs. A partial source uses a typed `SLICE_BLOB_EQ` or
`CHAINED_TREE_EQUIVALENT` unit proof and the source itself is not classified as
whole-tree main parity. This distinction preserves the four-file messaging
slice, the PR #891 sensor stack, and all unproven paths without duplication or
loss.

`finding_binding` is the unit-level finding SSoT:

- `BOUND` owns non-empty canonical IDs that exist in
  `docs/reviews/_registry/findings.jsonl`.
- `CREATE_REQUIRED` owns no canonical ID and records domain, severity, reason,
  and source-qualified legacy references until the registry CLI allocates a
  collision-free identity.
- `NOT_REQUIRED` owns no closure finding and states why the unit is provenance
  or control evidence. Reporting references are non-owning and remain inside
  the same binding object.

For every `BOUND` unit, each canonical registry row's `owner_agent` must equal
`ownership.accountable_registry_owner`. Dispatch remains separately assigned
through `ownership.execution_owner`, with independent
`ownership.mandatory_reviewers`; historical non-dispatchable registry
accountability is never rewritten merely to make an executor name match.

Every `BOUND` unit derives `deadline_alignment` from the canonical registry.
When a target exceeds a registry deadline, the manifest records each exact
finding/deadline/target mismatch as `REGISTRY_RESCHEDULE_REQUIRED`; that unit
cannot become ready, integrating, or verified until a registry event reconciles
the schedule.

`ATOMIC_PR_V1` defines five required gate IDs without mutable status. Every
unit owns its own typed `gate_results`; an omitted result is pending, and a
verified unit requires all five `PASS` results with evidence. The manifest
also locks unique source coordinates, exactly one adjudication per source,
exactly one unit per typed source slice, unique typed behavior targets, unique
authority keys, and an acyclic dependency topology. `integration_order` is the
sole ordering authority; integration-unit array position, `derived_from`, and
branch ancestry cannot create execution order. Every unit uses
`ownership.execution_owner`, `ownership.accountable_registry_owner`, and
`ownership.mandatory_reviewers`; the executable identities resolve to unique
`.claude/agents/**` frontmatter names. Legacy unit-level `owner`, `source_ids`,
and `derived_from` fields are forbidden. The invariant in
`tests/invariants/enterprise-grade-debt-plan-contract.spec.ts` rejects drift in
that control plane.

Source discovery is not a manually trusted count. CI Full fetches all remote
heads and runs `npm run gates:capability-source-inventory:remote`. That hosted
gate compares exact `origin/main` and remote branch heads only; it excludes
only the trusted detached pull-request ref and the exact event SHA, never a
named product branch.

The host gate runs `git fetch --prune origin` and then
`npm run gates:capability-source-inventory:live`. Pruning makes deleted remote
refs observable before comparison. The live mode adds locally unique branch
tips, every dirty registered worktree, and its byte digest evidence. Both
modes are read-only: the inventory gate itself never fetches, prunes, checks
out, resets, cleans, resolves, or deletes anything. Inspection failures and
undeclared, moved-head, base-SHA, kind, digest, or duplicate drift fail closed.
No remote branch, local branch, or dirty worktree record may disappear merely
because it becomes integrated or superseded. Retirement requires a nested
`retirement` record with `RETIRE_APPROVED`, approver, date, snapshot SHA-256,
content-addressed snapshot URI, evidence, and a `SIGSTORE_BUNDLE_V1`
authorization. The signed subject is the content-addressed authorization
statement; that statement binds the snapshot digest and source identity. The
snapshot, statement, and Sigstore bundle each have their own distinct
content-addressed URI and SHA-256, and all three artifacts appear in
`evidence`. Only issuer `https://token.actions.githubusercontent.com` and the
protected-main `source-retirement.yml` signer identity are trusted. A
dirty-worktree retirement also binds
`captured_content_sha256` to the recorded source content digest.

The content-addressed `source-findings.<sha256>.jsonl` selected by
`finding_inventory.artifact_path` is the occurrence-level finding provenance
SSoT. It contains one deterministic row per unique `source_id#raw_id`,
preserving noncanonical legacy variants such as `EDGE-CRITICAL-001-R1`
verbatim. The manifest pins the artifact bytes, its source-ref set, normalized
registry-and-schema authority, all 44 source attestations including zero-result
sources, and every integration-unit targeted-occurrence count. Finding
authority is one joint coordinate: the registry JSONL blob and the schema blob
that defines semantic projection and raw-ID grammar. Reconciled-base and
discovery-candidate coordinates are attested independently; identical blobs
are deduplicated while every unique registry blob records raw SHA-256 and row
count and every unique schema blob records raw SHA-256. A finding-authority
changing pull request therefore has one prospective candidate coordinate
without pretending its older reconciliation base has the same content. Remote
CI runs
`npm run gates:source-finding-inventory:remote` immediately after the remote
capability-source pin gate. Pull requests and protected-main pushes bind that
validation to immutable event SHAs, require a fast-forward ancestry chain, and
require the reconciled and tested-candidate blobs to match their respective
attestations. The event frontier may carry an intervening legitimate authority
version; its Git identity and ancestry are verified directly. Live
`origin/main` must still expose the event frontier's registry/schema coordinate
during pull-request validation and the candidate coordinate during
protected-main validation. A later main commit with no finding-authority
change may advance while an older exact-SHA run is executing, but a later
registry or schema change forces a rerun. No future merge SHA is embedded in
its own parent.

Writers serialize through one repository-common lease shared by every
worktree and by the canonical finding allocator. They validate the exact prior
manifest, every governed artifact, any stale legacy artifact, and committed
registry/schema authority before publication. The candidate HEAD, joint
authority coordinate, live `origin/main`, every included source ref, and each
included dirty-worktree content digest form one publication fence and are
rechecked before and after the pointer switch. Writers fsync a
content-addressed artifact first and atomically switch the manifest pointer
second; the manifest is therefore always the single authority across a crash.
After the pointer switch, only lease-snapshotted unreferenced artifacts are
removed and the directory is fsynced. Any post-switch fence failure durably
restores the prior artifacts and manifest under the same lease before
reporting failure.
Validation requires exactly one governed artifact and rejects or recovers,
under the same lease, legacy, duplicate, non-regular, corrupted, orphaned
staging, or mismatched entries; interrupted cleanup cannot silently accumulate
disk usage. The canonical registry mutation entrypoint applies the same staging
inspection/recovery contract to every active-worktree registry and the shared
ID-reservation ledger.

The governed count and source-ref digest are read only from
`finding_inventory` after the schema-governed capability projection is
executed; a
historical count is never an input to discovery. A preliminary textual audit
reported 1,030 with source-ref-set SHA-256
`3426306d2cd36f6b74f84303030777de1c81613c4e554c8b75888448501676ac`.
The first parsed pass reduced that set to 1,010 with source-ref-set SHA-256
`8631e019aefbfe44e57c8a812a87923758ee99f5de5af4b642f927670e2e494a`
after proving that 20 references on `SRC-R-011` and `SRC-R-012` existed only in
JSONL lines rewritten by immutable-ledger re-chaining. The exact exclusions
and intermediate digest remain lineage evidence, not execution authority. The
current artifact is authoritative only when its manifest hash, algorithm
contract, source attestations, and execution-scope attestation all agree.

Structured registry records absent from main are `LEGACY_UNREGISTERED`.
Unstructured registry/review references are `PENDING_ADJUDICATION`, never
automatic implementation obligations. Reused raw IDs with different source
and main identities are `ID_COLLISION`, keep `canonical_id: null`, and require
fresh allocation. A collision cannot claim a capability target before that
allocation. `finding_allocation_policy.reserved_domain_floors` is derived from
every source occurrence and is consumed by the canonical allocator under the
same repository-common lease. The allocator takes the maximum across all
namespaces for a root domain from the invoking worktree's repository-global
source-finding artifact. That worktree must carry valid v3 authority; its floor
is re-derived through the schema SSoT from the content-addressed artifact and
must match the artifact hash and row-count authority. Every active-worktree
registry is still required and scanned under the common lock, while historical
worktrees are not forced to duplicate the new manifest schema merely to let
main allocate. Automatic allocation advances above the global high-water and
explicit imports at or below it fail closed. A fresh worktree therefore cannot
mint an ID still present in legacy provenance. Every source has one explicit
`SA-SRC-*`
`source_adjudications` queue with its execution owner, status, deadline, and
plan. Occurrence rows reference that queue without copying its policy fields.
`target_integration_unit_id` remains null unless an existing source-qualified
binding proves a behavior-level target. Source adjudication is not semantic
capability ownership: a pending row blocks only its source queue and a
non-null target unit from becoming `READY`, `INTEGRATING`, or `VERIFIED`.
Unrelated behavior units are never blocked merely because they once shared a
branch.

The common-lock claim has a machine-enforced backward-writer boundary.
Canonical registry mutation and source-finding publication both execute the
same active-worktree legacy-writer compatibility preflight. The publication
writer calls `assertCompatibleWriters()` while resolving its
repository-common lease and refuses publication before artifact generation
when that check fails. A writable legacy `cmdAdd`/append implementation that
does not use `finding-registry-v1.lock` blocks the operation with its exact
path; policy text cannot make an uncooperative writer mutually exclusive. On
2026-07-29 the shared development common-dir still contains 14 such
historical worktrees. Until the P1 evidence below exists, allocation and
source publication refuse rather than risk a duplicate.

Discovery compares parsed registry records through the capability fields
declared once by `findings.jsonl.schema.json`: `id`, `title`, `severity`,
`layer`, `evidence`, `rule_violated`, `override_of`, `notes`, and `narrative`.
Lifecycle, ownership, timestamps, close metadata, and ledger-chain hashes
cannot create a finding delta or collision. The same schema authority supplies
canonical classifiers, including `CVE`, and the exact `FARM-DATAMIG-001`
grandfather rule; source-local suffixes and legacy namespaces remain verbatim
provenance. Raw references inside changed registry records are extracted
structurally; only
added non-registry `docs/reviews/**` lines are scanned as text. Dirty sources
are compared directly from merge base to the effective worktree, including
untracked review files; merge-base-to-HEAD and HEAD-to-worktree deltas are
never unioned, so a dirty revert cannot survive as a false finding. Dirty
evidence is checked against the capability inventory digest before and after
inspection, so a torn snapshot fails closed. Every source ref or worktree HEAD
is likewise rechecked before and after its scan. Dirty registry and untracked
review evidence must be regular files, and parsed registry snapshot caching is
bounded. A disappeared legacy binding is a hard failure and can never be
silently pruned by a writer. Full local/dirty rediscovery is forbidden on the
production host. Its workflow-dispatch identity must be GitHub-owned and its
actual cgroup v2 evidence must prove finite memory, swap, CPU, and PID bounds
plus an exclusive isolated CPU partition; the environment label alone grants
nothing. Git output is also bounded to 32 MiB and individual evidence files to
16 MiB. Static artifact validation and remote-only rediscovery remain safe
required-CI operations.
`npm run gates:source-finding-inventory:refresh` is the sole host-safe writer:
it re-discovers remote sources, retains host rows, and emits the explicit
pending-isolation attestation; it never reads local/dirty evidence or requires
their Git objects. Host merge-base attestations are preserved while their
artifact-derived counts and digests are recomputed.
When `generation_attestation.host_source_state` is
`RETAINED_PENDING_ISOLATED_REDISCOVERY`, remote rows are live-validated but
local/dirty rows are explicitly retained evidence, not a claimed v3 rescan.
That dated blocker is owned by `infra-expert`, due 2026-07-30, with the
manifest plan requiring the cgroup-backed isolated full run and matching
content/start/end snapshot pins before replacement. Full validation rejects
the retained state.

### Open P1 Control-Plane Blockers — 2026-07-30

These entries remain open and keep their affected units in `ASSESSING`.
Passing static contracts proves fail-closed boundaries; it does not substitute
for the missing operational evidence.

| ID                              | State  | Owner               | Deadline   | Missing machine proof                                                                                                                                                                                                                                    | Execution plan                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ------------------------------- | ------ | ------------------- | ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `P1-WRITER-PROTOCOL-001`        | `OPEN` | `context-manager`   | 2026-07-30 | Fourteen registered historical worktrees still expose writers that do not prove the `finding-registry-v1.lock` protocol.                                                                                                                                 | Preserve every dirty-worktree digest and patch, add the fail-closed/common-lease guard or retire the exact worktree registration through the governed retirement contract, then run `npm run test:finding-registry-authority` and `npm run findings:writer-preflight`; both canonical mutation and source-finding publication must pass the shared preflight.                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `P1-ALLOCATOR-OIDC-001`         | `OPEN` | `security-reviewer` | 2026-07-30 | The OIDC verifier and authority workflow exist, but there is no retained exact-run proof that a durable repository-global allocation transaction prevents two fresh clones from issuing the same ID while an earlier allocation PR is unmerged.          | Make the protected-main GitHub Actions OIDC workflow the only mutation authority; verify issuer discovery, JWKS key, RS256 signature, audience, repository, protected ref, workflow identity, workflow SHA, run ID/attempt, and token lifetime; bind allocation to a durable repository-global high-water transaction; run an adversarial two-clone allocation test and retain the signed run artifact.                                                                                                                                                                                                                                                                                                                                                                                                           |
| `P1-AUTOMATION-PUBLICATION-001` | `OPEN` | `security-reviewer` | 2026-07-30 | Live GitHub inspection at `2026-07-30T07:22:24Z` found no `ARIA_GITHUB_APP_*` variables or private-key secret, and the protected-base `automation-publication-admission` context cannot be required until its workflow first exists on protected `main`. | `Okan-wqm` creates or selects a GitHub App installed only on `Okan-wqm/aquaculture_platform`, with requested token permissions exactly Actions `read`, Contents `write`, and Pull requests `write` (no Administration or Workflows permission), then places `ARIA_GITHUB_APP_CLIENT_ID`, `ARIA_GITHUB_APP_INSTALLATION_ID`, `ARIA_GITHUB_APP_SLUG`, and `ARIA_GITHUB_APP_PRIVATE_KEY` only in the `automation-publication` environment. After this bootstrap control-plane PR merges, immediately promote the base-owned admission workflow in one configuration-only PR, add its exact context to `.github/manifests/main-required-status-checks.json` and live branch protection, then retain an exact-head add/close/report retry run proving App scope, GitHub signature, artifact digest, and PR provenance. |
| `P1-HOST-SOURCE-TRANSFER-001`   | `OPEN` | `infra-expert`      | 2026-07-30 | Local-branch and dirty-worktree rows are retained, but no signed host-source snapshot and transfer artifact lets the isolated runner reproduce their bytes and Git coordinates.                                                                          | Capture each registered host source as an immutable manifest plus required patch/archive bytes without secrets; bind source ID, locator, HEAD, merge base, content SHA-256, and start/end observation pins; sign the manifest with the repository-owned GitHub OIDC/Sigstore identity, verify the bundle after transfer to the isolated runner, run bounded full rediscovery, and replace retained rows only when all digests agree.                                                                                                                                                                                                                                                                                                                                                                              |
| `P1-RULE-HEALTH-TELEMETRY-001`  | `OPEN` | `infra-expert`      | 2026-08-01 | Integration unit `IU-CI-023` has `finding_binding.status=CREATE_REQUIRED`: no canonical finding ID or retained month-long `agent_dispatch_total` / `agent_finding_issued_total` and per-gate observation proof exists.                                   | Keep repository-derived report sections explicitly labelled, then dispatch the Finding Registry Authority `add` operation from protected `main` with retry-stable command ID `enterprise-debt:IU-CI-023:add`. After its registry PR merges, bind the allocated finding to `IU-CI-023`; `observability-expert` reviews bounded-cardinality metric wiring and a complete monthly artifact before this item can close.                                                                                                                                                                                                                                                                                                                                                                                               |

The 2026-07-30 rule-health item is finding-linked through
`manifest.json` integration unit `IU-CI-023`. Its `CREATE_REQUIRED` binding is
an explicit absence of a canonical ID, not permission to invent one locally;
the Finding Registry Authority workflow is the only allocation path.

The GitHub-side private-key boundary is partially installed, not inferred from
workflow YAML. Live API state at `2026-07-30T07:22:24Z` proves that environment
`automation-publication` exists with exactly one custom deployment branch
policy, `main`. It currently contains none of the four App credentials named
above, so every publication workflow remains deliberately fail-closed. The
App private key must be an environment secret, never a repository secret; the
three identifiers are environment variables. The checked-in token contract
downscopes each mint to exactly this repository with Actions `read`, Contents
`write`, and Pull requests `write`; Administration and Workflows authority are
outside the contract. Absence of those credentials and absence of the
base-owned required admission context are the two explicit exit conditions of
`P1-AUTOMATION-PUBLICATION-001`, not an undocumented follow-up.

### Production Droplet Execution Boundary

The production droplet is a deployment and runtime target, not a CI runner.
On 2026-07-29 a broad Nx affected run exhausted available memory and was
terminated at the OOM boundary. Production stability therefore enforces these
rules:

- Broad Nx/Jest/Vitest, coverage, lint, build, and dependency-audit workloads
  run only on isolated GitHub Actions runners.
- The droplet permits selective exact-digest deployment, health/readiness
  checks, targeted read-only smoke checks, and an encrypted backup stream.
- Restore proof runs only on an isolated runner container, never on the
  production droplet.
- No broad Docker garbage collection, swap mutation, full-stack restart, or
  target-host image build is authorized by this programme.

Ledger work preserves `JSONL_PRIMARY` as the production authority.
PostgreSQL may be absent or `POSTGRES_SHADOW`; `POSTGRES_PRIMARY` is forbidden
in production. The only cutover-labelled unit is explicitly
`PRE_PRODUCTION_ONLY`, remains `production_cutover=false`, and requires restore
proof plus two distinct protected-main parity cycles.

## Core Agents

The execution program uses these core agents as owners or mandatory reviewers:

- `architectural-arbiter`
- `context-manager`
- `prompt-writer`
- `data-expert`
- `multi-tenant-saas-expert`
- `auth-security-expert`
- `security-reviewer`
- `compliance-expert`
- `legal-hold-auditor`
- `infra-expert`
- `performance-expert`
- `hr-expert`
- `frontend-expert`
- `messaging-expert`
- `farm-expert`
- `edge-expert`
- `alert-engine-expert`
- `supply-chain-auditor`
- `test-runner`
- `admin-expert`
- `mcp-expert`
- `build-validator`
- `mobile-app-auditor`
- `observability-expert`

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

These commands run on an isolated CI runner, never on the production droplet.

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
