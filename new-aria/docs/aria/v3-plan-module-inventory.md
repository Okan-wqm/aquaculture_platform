# Plan ARIA-V9 + V10 v3 — Module Inventory Reconciliation (V8-RC)

**Purpose:** Reconcile the v1 plan's "MODIFY" vs "NEW" classification claims against the actual contents of `aria-kernel/aria_kernel/` at HEAD. The 4-validator audit (architectural-arbiter CRIT-001) flagged that several "existing, modify" modules did not exist; HEAD inspection shows the audit was based on a **stale read of the repo** — V8.3 / V8.17 / V8.18 work has landed and most modules cited in v1 DO exist.

**HEAD at audit time:** `c4399843` (chore(ci): harden npm ci against transient registry timeouts).

---

## Audit reconciliation

### Modules the v1 plan called "existing, modify" — confirmed PRESENT at HEAD

| Module | Size at HEAD | v3 classification |
|---|---|---|
| `plan_convergence.py` | 1697 lines | MODIFY (V9.0-B event types + state preconditions + cache deepcopy; V9.2 state.implementation record) |
| `plan_convergence_bridge.py` | 299 lines | MODIFY (V9.0-B match/case + assert_never; V9.3 issue_implementation_envelope) |
| `plan_synthesizer.py` | present | MODIFY (V9.4 5 pressure sources + caching + signature) |
| `convergence_drainer.py` | present | MODIFY (V9.3 implementation envelope minting + poll discipline) |
| `cross_review_bridge.py` | present | MODIFY (V9.3 issue_implementation_envelope sibling; the cross-review side already wired by V8.3) |
| `auto_merge.py` | 40673 bytes | INVOKE (V9.6 routes through existing `DEFAULT_POLICY.hard_forbidden_globs`; NOT re-stating weaker) |
| `auto_merge_runners.py` | present | MODIFY (V9.6 sync merge + 5-tuple idempotency + headRefOid recheck) |
| `skill_genesis.py` | present (V7) | MODIFY (V10.2 pattern_signature stability + N≥5 threshold) |
| `skill_genesis_drainer.py` | present (V7.4) | MODIFY (V10.2 sandbox dispatch + AST allowlist + HUMAN_REQUIRED registration) |
| `convergent_skill_authoring.py` | present (V6.2) | INVOKE (V10.2 backend; sandbox wraps the call site) |
| `agent_genesis.py` | present | NO CHANGE |
| `genesis_policy.py` | present | NO CHANGE |
| `budget.py` | present | MODIFY (V10.4 per-cycle cap + attribution wire) |
| `agent_invocations.py` | present | MODIFY (V10.4 invocation_role propagation) |
| `agent_compliance.py` | present | REUSE pattern (V9.0-D verify_no_path_escape mirrors lines 168-178) |
| `cli.py` | 164554 bytes | MODIFY (V9.7 6 new flags) |

### Modules the v1 plan called "NEW" — confirmed ABSENT at HEAD

| Module | v3 classification | LOC target |
|---|---|---|
| `plan_candidate_source.py` (renamed from `pressure_source.py` to avoid collision) | NEW (V9.0-A) | ~30 |
| `preflight.py` | NEW (V9.0-C) | ~80 |
| `gh_token_factory.py` | NEW (V9.0-C) | ~120 |
| `implementation_safety.py` | NEW (V9.0-D) | ~300 |
| `skill_genesis_sandbox.py` | NEW (V9.0-E) | ~80 |
| `knowledge_graph.py` | NEW (V9.0-F) | ~250 |
| `.claude/agents/aria-implementer.md` | NEW (V9.1) | ~250 |
| `aria-kernel/tests/invariants/v9/` | NEW dir | ~600 |
| `aria-kernel/tests/invariants/v10/` | NEW dir | ~400 |
| `docs/aria/v3-20-cycle-endurance-spec.md` | NEW | doc |
| `docs/aria/v3-one-way-door-decisions.md` | NEW | doc |

### Naming collision found at HEAD — v3 deviation from v1

`aria_kernel/pressure.py` (existing module) already defines a `SOURCE_WEIGHTS` dict keyed by pressure-cause strings (`tool_quarantine, evidence_gone, belief_stale, belief_revalidation, migration_surface_repeat, discovery_incomplete, contradiction, shadow_raw_delta`). This is the **pressure-arising taxonomy** — answers *why* a pressure point exists.

The v3 plan introduces a **plan-candidate-source taxonomy** — answers *which input lane* `plan_synthesizer` pulled this CONVERGED-candidate from (`git_diff, orphan_finding, f_finding, failing_ci, operator_feedback`).

These are complementary, not duplicate:
- `pressure.py` SOURCE_WEIGHTS — meta about an active pressure record
- v3 plan_candidate_source — meta about a synthesized plan candidate

To avoid naming confusion the v3 NEW module is named `plan_candidate_source.py`, exporting `class PlanCandidateSource(str, Enum)`. The v1 plan's `PressureSource` references are recorded here as superseded.

### Auto-merge module duplication clarified

The v1 plan said "extend `auto_merge_runners.py`" without naming `auto_merge.py`. HEAD has BOTH:
- `auto_merge.py` (40673 bytes) — `DEFAULT_POLICY` + `evaluate_auto_merge(pr, policy) -> Eligibility`
- `auto_merge_runners.py` (7265 bytes) — `RealAutoMergeRunner`, `NoOpAutoMergeRunner` (the protocol wired into orchestrator)

The v3 architecture: V9.6 INVOKES `auto_merge.evaluate_auto_merge` from inside `auto_merge_runners.RealAutoMergeRunner.__call__` — single source of truth for merge-eligibility policy; runner becomes a thin wrapper.

---

## Acceptance

This artifact closes finding **F-V8-RC-01** (architectural-arbiter CRIT-001 module reconciliation). Subsequent v3 phases reference module names per the tables above. No naming drift permitted.

V9.0-A may proceed with `plan_candidate_source.py` as the new module name.
