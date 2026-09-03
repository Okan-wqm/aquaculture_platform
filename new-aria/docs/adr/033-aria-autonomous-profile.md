<!-- ARIA-LIVE-AUTHORITY: docs/aria/CURRENT_STATE.md and executable contracts supersede stale runtime/provider/branch statements in this document. -->

# ADR-033 — ARIA Autonomous Runtime Profile + Self-Closing Loop Architecture

**Status:** Accepted (Plan ARIA-V3 §B2 + §B3)
**Date:** 2026-05-15
**Branch:** `snowball` (ARIA-only; not merged to `main`)
**Supersedes:** none
**Superseded by:** none
**Related:** ADR-031 (ARIA snowball meta-system), ADR-014/015 (NATS cert-only identity, pattern-analogous identity discipline)

> **Note on ADR numbering:** Plan ARIA-V3 §B3 originally proposed
> ADR-016. That number is already double-claimed in `docs/adr/`
> (`016-deploy-resilience-architecture.md` and
> `016-stripe-sdk-adoption.md` — a separate cleanup is tracked).
> ADR-033 is the next unclaimed canonical number at the time of
> filing.

---

## Context

Plan ARIA-V3 closes the four architectural gaps (GAP-1..4) that
previously kept the ARIA kernel's self-closing loop operator-bound
at every materialize / merge step. The four gaps were:

1. **GAP-1** — `materialize_agent_draft` / `materialize_skill`
   hard-coded `if not acknowledge: raise GovernanceError`; the
   `genesis_policy.materialization_requires_acknowledge` flag was
   dead config.
2. **GAP-2** — `auto_merge_runner` parameter on the autonomy
   orchestrator was `Optional[None]`-default; the dispatch
   silently skipped the merge runner when not provided.
3. **GAP-3** — `github_adapter` was `Optional`; tests built fake
   adapters via duck typing; production silently no-op'd PR opens.
4. **GAP-4** — the genesis drafter was a template-only renderer
   producing markdown; no real grammar validator, no real PII
   filter, no real classifier — `worker_executor` spawned `claude
   code agent` against an unverified target subagent name.

Phases A0..B1 of Plan ARIA-V3 closed GAP-1..4 + cost circuit breaker
(B0) + DEBT-2026-05-08-001 retirement (B1). Phases B2 and B3
together close the LOOP CONTRACT — making it architecturally safe
to enable end-to-end autonomous materialize-and-merge on the
L3-snowball lane.

This ADR records the strategic decision underpinning B2 + B3:

- WHY a new runtime profile (`autonomous`) was the right shape.
- WHY the kernel-immutability rule receives ONE narrow carve-out
  (worker_executor subprocess boundary).
- WHAT alternatives were considered + rejected.
- HOW the operator rolls back if the autonomous path
  misbehaves.

## Decision

**Add a fifth runtime profile (`autonomous`) to the four-mode
taxonomy** (`observe / standard / strict / frozen`), with explicit
ACTION_PERMISSIONS entries (no inherit-from-strict semantics).
Autonomous is set ONLY via `aria-kernel profile set --profile
autonomous --operator-approval-ref <ref>`; default stays `standard`.

**Three independent circuit breakers gate every autonomous cycle:**

1. **Cost circuit breaker** (Plan ARIA-V3 §B0) — `aria-tools/budget/`
   tracks daily / monthly / per-run USD. Tripped on cap exceedance.
2. **Failure circuit breaker** (Plan ARIA-V3 §B2 §2j) — closed
   6-kind taxonomy at `aria-tools/breakers/`. Sum > N in 24h
   sliding window trips. N from `genesis_policy.circuit_breaker.
   threshold_24h` (default 3).
3. **Cross-host lease lock** (Plan ARIA-V3 §2n + INFRA-HIGH-004) —
   `aria-tools/locks/autonomous-host.lock` carries
   `{host_id, pid, lease_acquired_at, lease_expires_at}`. Fresh
   lease held by a different host blocks the autonomous path
   (local daemon AND GHA cron honor the lease).

**Lane is kernel-derived only** — `lane_classifier.py` extracts the
lane from PR metadata (base branch → `L3-snowball` / `L0-main` /
`None`). Operator CLI rejects `--lane` (invariant I-V3-29b verifies
via source-grep). Tier-1: lane forgery structurally impossible.

**Three-event materialize chain** (Plan ARIA-V3 §2g + AUDITTRAIL-
CRITICAL-003) — `draft_validated → ack_consumed → materialize_committed`
share a `materialize_event_id` UUID, enabling audit replay.

**SPEC §5.4 carve-out** — the kernel-immutability rule "ARIA never
invokes these agents (it does not have Agent tool in its kernel)"
receives ONE narrow exception: under `autonomous` profile ONLY, the
`tools/aria-poc/worker_executor.py` subprocess boundary may spawn
`claude code agent --subagent-type aria-drafter ...`. Every other
profile blocks this path via ACTION_PERMISSIONS. Kernel-internal
`Agent()` invocation remains forbidden (invariant I-V3-31e verifies
kernel Python modules contain zero `from claude.code.agent`
imports and zero `Agent(...)` syntactic invocations).

## Alternatives considered + rejected

### Alternative A — Extend `strict` profile (no new profile)

Use the existing `strict` profile to gate autonomous merge. Add
the breaker / lease checks to the strict-mode hook chain.

**Rejected because:**

- `strict` is documented in SPEC §5.4 (Trust Levels) as a profile
  where "Human merge mandatory" (line 485 — Level 2 baseline). Any
  L3 auto-merge under strict would contradict the existing SPEC
  contract; operators set strict EXPECTING the auto-merge gate to
  stay closed.

  > **Amendment 2026-08-19 (ORPHAN-HIGH-728).** "Operators set strict" is
  > now precise rather than assumed. A scheduled lane may RESOLVE strict
  > from the L1 acceptance ladder, but only within
  > `runtime_profile.scheduler_profile_ceiling` — an operator-recorded value
  > in this same control plane, defaulting to `standard`, which
  > `set_profile` refuses to let a non-operator setter raise. The
  > expectation this bullet rests on is therefore unchanged and now
  > enforced: strict is reached because a human granted it, and the
  > auto-merge gate stays closed under strict either way (`pr_merge` is
  > `{autonomous}` and `RealAutoMergeRunner` forces `dry_run` for every
  > other profile).
- ACTION_PERMISSIONS for `strict` does not currently list
  `pr_open` as auto-merge-eligible (it lists `pr_open` for PR
  creation, not merge). Conflating these two semantics inside one
  profile string makes the action-table hard to reason about.
- A separate `autonomous` profile is the architecturally clean
  shape: explicit operator opt-in (`aria-kernel profile set
  --profile autonomous --operator-approval-ref <ref>`); no
  semantic drift on existing profiles; explicit transition audit
  row in `runtime-profile-history.jsonl`.

### Alternative B — Boolean feature flag (`enable_autonomous_merge`)

Add a `enable_autonomous_merge: bool` to `genesis_policy.json`
and gate the auto-merge path on that single boolean. No new
profile state.

**Rejected because:**

- The auto-merge path requires a full state machine: profile +
  breaker + cost + lease + classifier + ack-ledger. A boolean
  cannot represent the multi-dimensional readiness state without
  duplicate flags (`enable_autonomous_merge` AND
  `enable_cost_circuit_breaker` AND ... AND ...).
- A profile string is a single SSoT consumed by
  `enforce_profile_for_action`, the gate, ack_ledger's
  `actor_kind` field, audit rows, and operator CLI. A boolean
  flag would need to be wired into each independently — drift
  risk.
- Profile transitions emit `runtime_profile_changed` governance
  rows AND require `operator_approval_ref`. A boolean toggle has
  no native audit story.

### Alternative C — External orchestrator (kernel as observer)

Move the auto-merge loop out of the ARIA kernel entirely; the
kernel stays observe-only. A separate `aria-autonomous-merger`
microservice listens on the kernel's outbox and acts on its
behalf.

**Rejected because:**

- This is the V0 architecture from before Plan ARIA-V3. The
  previous review identified that an external orchestrator
  creates a SECOND trust boundary (the kernel trusts the
  orchestrator's `merge_committed` event without verification).
  Plan ARIA-V3 §A1 collapsed `auto_merge_runner` into the kernel
  precisely to remove this seam.
- The kernel-internal materialize chain (three-event linkage by
  `materialize_event_id`) is harder to extend across the kernel-
  orchestrator boundary; audit replay requires reconciling two
  event streams.
- An external orchestrator does not solve the cross-host race
  problem — it shifts it to "which orchestrator instance is
  authoritative", which is the same problem with one more layer.

## Consequences

### Positive

- The autonomous loop has explicit operator opt-in (`aria-kernel
  profile set --profile autonomous ...`). Default remains
  `standard`.
- Three independent breakers (cost / failure / lease) make
  multiple independent failure classes detectable at the kernel
  boundary.
- Audit trail is complete: profile transition, lease acquire,
  breaker state, materialize chain (3 events), ack mint+consume
  — every step writes to `governance.jsonl` (hash-chained).
- The SPEC §5.4 carve-out is narrow + auditable (only worker_executor
  subprocess spawning aria-drafter under autonomous profile).
  Other invocation paths remain forbidden.

### Negative

- The autonomous profile is a new SSoT that future contributors
  must learn. Existing tooling (docs, runbooks) needs updates.
- The carve-out in SPEC §5.4 weakens the
  "kernel never invokes agents" invariant from absolute to
  contextual. The architectural-arbiter audit (recorded in
  `/root/.claude/plans/immutable-sparking-waterfall.md` §6) is
  the precursor evidence; this ADR is the contemporaneous record.
- The cross-host lease lock relies on TRUSTED-WITNESS contract
  rather than a kernel mutex. If a malicious actor bypasses the
  lease check, double-claim is possible. Mitigation: only
  authorized hosts (the operator's laptop + the GHA cron runner)
  can reach the kernel writers; the lease is enforced at the
  kernel boundary as a self-discipline.

### Rollback path

If the autonomous path misbehaves in production:

1. **Immediate kill switch:** operator runs `aria-kernel profile
   set --profile strict --operator-approval-ref <ref> --reason
   "autonomous misbehavior incident <ID>"`. Next cycle exits
   cleanly with `profile_frozen` equivalent.
2. **Breaker trip:** if a runaway-cost or runaway-failure
   condition is detected, the breakers trip automatically and
   the orchestrator refuses subsequent cycles until the operator
   resets via `aria-kernel circuit-breaker reset
   --operator-approval-ref <ref> --reason <text>`.
3. **Lease release:** if the lease becomes stuck (a crashed
   daemon left a fresh-but-orphan lease), the operator runs
   `aria-kernel autonomy lease release --operator-approval-ref
   <ref>` to clear it.
4. **Full retreat:** revert the autonomous profile addition by
   reverting commits 7952b385 (B2) and the B3 commit (this ADR).
   The four-mode taxonomy + four-action-permission table return
   verbatim; the new modules (`circuit_breaker.py`,
   `autonomous_host_lease.py`) become dead code but harmless.

The rollback path is invariant-test-protected: I-V3-26
(tripped breaker emits audit row), I-V3-27 (set_profile requires
approval ref), I-V3-29c (cross-host lease blocks).

## Compliance + audit references

- Plan ARIA-V3 SPEC: `docs/aria/SPEC.md` §2 L3 Hard Limits + §5.4
  Existing-agent integration policy + §8.1 Trust Levels (all
  amended in this commit).
- Invariant suites locking the contract:
  - `aria-kernel/tests/invariants/v3/test_phase_b2_autonomous_profile_breaker.py`
    (13 cases, I-V3-24..29c)
  - `aria-kernel/tests/invariants/v3/test_phase_b3_spec_adr_amendment.py`
    (7 cases, I-V3-30..31e — added by this commit)
- Plan source: `/root/.claude/plans/immutable-sparking-waterfall.md`
- 4-agent audit (architectural-arbiter + test-runner + audit-trail
  + infra-expert) that gated the Plan ARIA-V3 architectural
  decision: see plan §1 CONVERGED state.

## Author + sign-off

- **Author:** ARIA primary-planner + operator review
- **Branch policy:** `snowball` only; ADR-033 itself stays
  ARIA-scoped. Promotion to `main` requires explicit operator
  decision per `/var/aqua-saas/CLAUDE.md` ARIA Snowball branch
  policy.
