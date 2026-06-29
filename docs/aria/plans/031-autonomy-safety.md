<!-- ARIA-HISTORICAL: Historical plan document. Live authority is docs/aria/CURRENT_STATE.md plus executable contracts. -->

# ARIA Plan 031 — Make ARIA as autonomous as safely possible

> **Status:** Implemented (Gate A + Gate B + expert-consensus gate + burn-in→ladder
> bridge + mock runner + harness gate + runbook).
> **Branch:** `claude/aria-gaps-cost-review-rebmuc`

## Summary

The goal is to let ARIA run as autonomously as possible. Two honest facts shape
the design:

1. **The operator cannot be the code-correctness reviewer.** Someone who cannot
   out-write the AI cannot catch its subtle regressions by reading diffs. So
   safety must come from **deterministic mechanisms**, not human review — tests,
   fixtures, invariants, the Plan 030 acceptance harness, a regression-anchor
   requirement, an oscillation guard, and an evidence-verified expert-consensus
   gate. The human's role shifts from "diff reviewer" to "direction approver +
   watcher of a deterministic ACCEPT/REJECT." This is ARIA's own "trust evidence,
   not assertions" stance applied to itself.
2. **The autonomy-progress bridge did not exist in code.** The unlock ladder
   (`docs/aria/policy/autonomy-unlock.json`) and its evaluator
   (`autonomy_unlock.evaluate_autonomy_unlock`) existed, but the counter writer
   `record_acceptance_event` had **no runtime caller** — so clean cycles never
   accumulated toward unlock and autonomy was structurally unable to progress.

This plan (a) builds the missing bridge so clean+ACCEPT cycles flow to the
burn-in counter automatically, (b) adds two deterministic safety gates
(regression-anchor + oscillation guard) that replace the operator-reviewer, (c)
adds an evidence-verified expert-consensus gate so a fix is reviewed by ≥2
independent topic-experts whose verdicts are re-checked against repo evidence,
(d) wires the Plan 030 harness as the cycle-clean precondition, and (e)
documents the operator/env-bound real-merge boundary that must remain.

> **Honest boundary:** real autonomous MERGE (real LLM + auto-merge to main) is
> unreachable in this environment and must not be faked. `merge_authority.py`
> demands operator/environment-bound proofs (profile approval_ref, GitHub App
> token, enterprise readiness proofs, runner attestation, rollback bundle, the
> triple gate + final live re-eval). This plan does NOT open those; it proves
> the mechanism in mock and leaves the real opening to the operator.

## Faz 031b Gate A — regression-anchor requirement (tier-1 "make impossible")

`validation_matrix_gate.enforce_validation_matrix` gains
`require_regression_anchor` (default False — the general gate's contract and all
human/backfill/replay callers are unchanged). The cycle's validation-matrix
phase sets it True, because every change committed inside the cycle window is an
ARIA-authored autonomous fix. Under enforced mode the diff MUST contain at least
one test/fixture file (`has_regression_anchor` is the SSoT: TS `__tests__`/
`*.spec.*`/`*.test.*`, Python `test_*.py`/`*_test.py`/`tests/`, fixture corpora)
or the gate blocks before any risk branch. Every autonomous fix must leave a
durable regression test. `historical_attestation` replay is bypassed.

## Faz 031b Gate B — oscillation guard (converge ping-pong to a human)

`oscillation_guard.py` counts consecutive reopens of the same
`finding_fingerprint` (`belief:<id>` for reopened beliefs) via a governance-event
tail-scan, mirroring `architecture_spine_gate`'s regression-streak counter — a
clean resolution resets the streak. At the threshold (3) `guard_fix_dispatch`
escalates to a HUMAN_REQUIRED record and raises to refuse further autonomous fix
dispatch, converging a fix→reopen→refix loop to "ask a human." Observation and
decision are separate: `record_reopen` (the `memory._apply_diff_to_existing_-
beliefs` hook) is a pure counter increment with no escalation or profile gate;
`guard_fix_dispatch` (the dispatcher gate) owns escalation + blocking.

## Faz 031e — expert-reviewer consensus gate (evidence-verified)

`expert_review_gate.py` wires four existing pieces into the autonomous-fix path
(no new infrastructure):

- **WHO reviews:** `select_expert_reviewers` routes the fix's affected files
  through the Lane-A domain touch-map (reused `select_specialist_agents`) and
  tops a single-domain fix up to ≥2 independent reviewers with cross-cutting
  reviewers (`security-reviewer`, `architectural-arbiter`). Read-only judges,
  separate from the fixer.
- **CONSENSUS:** ≥2 distinct reviewers, unanimous `satisfied`, mean confidence
  ≥ `CONSENSUS_MIN_CONFIDENCE` (0.80, the same threshold the judge gate uses).
- **ANTI-HALLUCINATION:** every reviewer's `evidence_refs` is re-verified against
  the git blob at the fix's base SHA via `classify_evidence_ref`; a ref that does
  not resolve (`missing`/`invalid`) blocks the gate and escalates to
  HUMAN_REQUIRED. A reviewer that dreams cannot approve a fix.

Registered as the 16th `HARD_FAIL_CHECK` (`expert_consensus_evidence_verified`)
so the orchestrator's pre-PR-open loop refuses to open a fix PR without an
evidence-verified expert consensus (the registry grew 6→15→16 across plan
audits; the V9.0-D count invariant is bumped accordingly).

## Faz 031a + 031c — burn-in→ladder bridge with harness gate

`autonomy_ladder.record_clean_cycle` turns a deterministically-clean cycle into
an `observe_success` acceptance event. It REQUIRES `harness_accepted=True` (the
031c precondition: a cycle counts only if the Plan 030 harness still ACCEPTs).
Mode separation is load-bearing: `mode="real"` writes the real, profile-gated
unlock ledger; `mode="mock"` writes a SEPARATE demonstration ledger that is not
an enterprise surface at all, so a sandbox burn-in proves the mechanism but can
never unlock real merge. `evaluate_mock_unlock` reuses the same
`verdict_from_rows` rule (extracted from `evaluate_autonomy_unlock`).

`tools/aria-acceptance/burn_in_driver.py` is the self-driving mock runner (the
missing runtime caller). Verified end-to-end:

```
python3 tools/aria-acceptance/burn_in_driver.py --cycles 30 --mock
→ [031c] acceptance harness: ACCEPT
→ mock observe_successes=30, mock L1=True; REAL=0, REAL L1=False
```

## Faz 031d — runbook + honest boundary

`docs/aria/runbooks/autonomy-unlock.md` documents the real-mode unlock path and
the operator/env-bound real-merge blockers that must REMAIN (they are the safety,
not a restriction to remove).

## Acceptance

```
PYTHONPATH=aria-kernel python3 -m unittest \
  tests.test_regression_anchor_gate tests.test_oscillation_guard \
  tests.test_expert_review_gate tests.test_autonomy_ladder_bridge
python3 tools/aria-acceptance/burn_in_driver.py --cycles 30 --mock   # exit 0
python3 tools/aria-acceptance/harness.py                              # still ACCEPT
```

## Open risks / limits — ARIA-031-D1

- Opening autonomy comes WITH strengthening the gates: 031a only progresses when
  the regression/oscillation/expert-consensus gates (031b/031e) are preconditions.
- Mock events cannot open real merge (mode separation) — the sandbox cannot hack
  itself to merge.
- A deterministic gate is only as strong as the test/fixture it requires: Gate A
  forces "every fix leaves a test" but does not guarantee the test's *quality*
  (separate, future work).
- **Expert reviewers can share a correlated hallucination:** the evidence gate
  deterministically catches FABRICATED evidence (a file:line that does not exist)
  but not two reviewers making the same *interpretive* error on real evidence.
  031e is therefore a judgment layer ON TOP of the deterministic floor (Gate A +
  harness), not a replacement for it.
- Real autonomous merge stays operator/env-bound (031d) — deliberate, not removable.

## Plan 031-R — remediation (B1–B8)

An external multi-agent review + independent re-verification found that Plan 031
built and unit-tested the safety MECHANISMS but did not WIRE several into the
live autonomous path, and the evidence gate had loopholes. The 031-R remediation
turns "mechanism exists" into "mechanism is enforced on the path autonomy takes":

- **R1 (B2)** — Gate A enforced at the real chokepoint `emit_change_validated`
  (profile/claim_id-derived), not just a cycle phase the orchestrator skipped;
  the fixture anchor pattern narrowed so a production `fixture-*.ts` no longer
  counts.
- **R2 (B1)** — the expert-consensus gate is wired into pre-PR-open via a
  canonical verdict ledger (`expert_verdicts.py`); `open_pr_for_action` reads an
  approved, head-bound verdict and fails closed for ARIA-authored (claim_id)
  changes.
- **R3 (B3/B4)** — the expert gate requires ≥1 evidence ref per reviewer,
  `repo_verified` at base SHA (fail-closed without base_sha), and a cited line
  that actually exists (`classify_evidence_ref` line-bounds check).
- **R4 (B5)** — `workspace_root` threaded through the CLI consensus path so the
  evidence-gated arbiter fires there too.
- **R5 (B6)** — the acceptance harness rejects a non-clean terminal cycle
  (completed + runtime ok + no failed phases).
- **R6 (B8)** — write-tier SSoT reconciled (Python ↔ TS) + the Bash policy
  reworded so a read-only Bash scout stays cheap.
- **R7 (B7)** — a clean autonomous cycle advances the unlock ladder
  (operator-gated, mode-separated), and acceptance-event counting is idempotent
  by `(event_type, cycle_id, lane, head_sha)`.
