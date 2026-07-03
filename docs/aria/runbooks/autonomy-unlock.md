# Runbook — ARIA autonomy unlock (operator)

> **Audience:** the operator enabling ARIA autonomy on a trusted runner.
> **Companion plan:** `docs/aria/plans/031-autonomy-safety.md`.
> **Principle:** the operator is NOT the code-correctness reviewer. Safety comes
> from deterministic gates (Plan 030 harness, regression-anchor, oscillation
> guard, evidence-verified expert consensus). The operator approves *direction*
> and watches the deterministic ACCEPT/REJECT — they do not out-review the AI.

## How autonomy progresses

ARIA's unlock ladder (`docs/aria/policy/autonomy-unlock.json`) requires
accumulated acceptance events before a lane unlocks:

- **L1** — 30 `observe_success`
- **L2** — +30 `l1_autonomous_success`, +30 `l2_supervised_success`
- **L3** — +10 `l2_autonomous_success`, +5 `l3_approval_success`, +3 `rollback_success`
- **critical_violation_limit = 0** (any critical violation blocks unlock)

A clean cycle becomes an `observe_success` ONLY through
`autonomy_ladder.record_clean_cycle(harness_accepted=True, ...)` — and
`harness_accepted` is true only when the Plan 030 acceptance harness ACCEPTs
(drift evidence clean, cycle invariants held, scenario reactions intact). No
ACCEPT → no progress.

## Mock vs real (mode separation)

`record_clean_cycle` takes `mode`:

- `mode="mock"` writes a SEPARATE demonstration ledger
  (`aria-tools/aria-acceptance/mock-acceptance-events.jsonl`) that is **not** an
  enterprise surface. It proves the mechanism but can NEVER unlock real merge.
- `mode="real"` writes the real, profile-gated ledger
  (`aria-tools/enterprise/acceptance-events.jsonl`) that
  `evaluate_autonomy_unlock` reads. It only succeeds on a properly-profiled
  runner.

Demonstrate the mechanism (safe, no real unlock):

```
python3 tools/aria-acceptance/burn_in_driver.py --cycles 30 --mock
# → harness ACCEPT; mock observe_successes=30, mock L1=True; REAL=0, REAL L1=False
```

## Real-mode unlock (operator/runner-bound)

The real `observe_success` burn-in is the heavyweight, real-git, no-action
observe run (`burn_in.run_observe_burn_in`, 30 cycles / ≥20 valid, clean
worktree pre+post). It requires:

1. An **isolated trusted runner** with Codex managed-auth (absent in the
   sandbox).
2. The runtime profile set to the appropriate stage with a real operator
   `approval_ref` (`runtime_profile.set_profile`).
3. The harness ACCEPT as the per-cycle cleanliness gate.

Advance the ladder stage by stage, re-running the harness as the gate at each
stage; never skip a stage to reach a higher lane.

## The 6 operator/env-bound real-MERGE blockers (these MUST remain)

`merge_authority.merge_pr_with_authority` is the single real-merge boundary.
Beyond the unlock ladder, it demands the following operator/environment-bound
proofs. **These are the safety itself — they are not restrictions to remove or
work around:**

1. **Runtime profile `pr_merge`** set to autonomous/strict with a real operator
   `approval_ref` (`enforce_profile_for_action("pr_merge", ...)`).
2. **A live GitHub adapter** backed by a GitHub App token — a real PR
   (`adapter.get_pr`) and a real `adapter.merge_pr`, plus a `readiness_claim_id`.
3. **Enterprise readiness proofs** (`verify_enterprise_readiness`) — ledger-bound
   branch-protection, workflow-run/CI, artifact, retention, DLP, and token
   proofs produced on the trusted runner.
4. **Runner attestation** (`verify_runner_attestation`) — the ephemeral-runner
   Codex attestation binding the PR + head SHA to the readiness claim.
5. **Rollback bundle + pre-merge incident row** (`verify_rollback_bundle`,
   `ensure_pre_merge_incident_row`).
6. **Auto-merge triple gate + final live re-evaluation** — CI still green, branch
   tip unchanged (head SHA re-checked immediately before `adapter.merge_pr`).

Plan 031 does NOT open any of these. It proves the unlock mechanism in mock and
leaves the real opening — deliberately — to the operator on a trusted runner.

## What the operator watches (not reviews)

- `python3 tools/aria-acceptance/harness.py` → ACCEPT/REJECT (the deterministic truth gate).
- `aria-tools/human-required/*.json` → oscillation escalations + hallucinated-approval
  escalations the gates raised. These are the only items that need a human decision.
- The unlock verdict (`evaluate_autonomy_unlock(lane=...)`) → which thresholds remain.
