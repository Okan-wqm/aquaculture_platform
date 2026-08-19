# ADR-041 — ARIA Narrow Autonomous-Merge Lane (risk-L1 docs/tests)

- **Status:** Accepted (policy prepared; activation gated on the autonomy-unlock ladder)
- **Date:** 2026-07-02
- **Owner:** platform operator (Okan) + ARIA kernel
- **Tracking:** `docs/reviews/orphan-findings.md#ORPHAN-MEDIUM-300`
- **Relates to:** ADR-031/033/035/036 (ARIA), `docs/aria/ENTERPRISE_AUTONOMY_SSOT.md`, Plan 031c (burn-in→ladder), Plan 025 §E / 026R §D.4 (auto-merge triple-gate)

## Context

The 2026-07-02 operationalization decision (operator-approved plan, item 3)
opens a NARROW autonomous-merge lane for low-risk documentation and test
hygiene changes, with the unlock left to the evidence ladder. Implementation
review found that the executable policy surface for this lane **already
exists and is correctly shaped** — what was missing is this decision record,
the activation ceremony, and executable proof that the lane cannot fire
today. This ADR supplies those three.

### Terminology hazard this ADR codifies

Two independent "L1/L2/L3" scales coexist and MUST NOT be conflated (the
implementation review caught a draft runbook doing exactly that):

| Scale | Owner | Meaning of "L3" |
|---|---|---|
| **Autonomy-unlock ladder** | `autonomy_unlock.py` + `docs/aria/policy/autonomy-unlock.json` | HIGHEST autonomy level (most evidence required) |
| **Risk lanes** | `risk_policy.py` + `docs/aria/policy/risk-policy.json` | HIGHEST risk class (control plane; two-stage human approval) |

The narrow lane of this ADR is **risk-lane L1** (docs/tests, the LOWEST risk
class) unlocked at **ladder level L1** (the first evidence rung). A change to
`docs/aria/policy/**` classifies as **risk-L3** even though `docs/**` is a
risk-L1 glob, because `_first_matching_lane` checks L3→L2→L1 — policy files
can never ride the narrow lane.

## Decision

1. **Lane scope is the existing risk-L1 glob set** in
   `docs/aria/policy/risk-policy.json` (docs, markdown, `tests/**`,
   `__tests__`, `*.spec.*`/`*.test.*`, `test_*.py`/`*_test.py`, adapter
   fixtures/manifests). No glob changes are made: the set already matches the
   operator-approved scope, `blocked_globs` (secrets/billing/terraform/env)
   are checked before any lane, mixed-lane diffs classify `blocked`, and any
   path outside every lane classifies `blocked` (`risk_unknown_path`).
2. **`auto_merge_candidate_lanes` stays `["L1"]`** — risk-L1 is the only
   auto-merge candidate class.
3. **Activation is a deliberate operator ceremony, never a side effect.**
   The lane fires only when ALL of the following hold at merge time
   (enforced by `merge_authority.merge_pr_if_ready`'s ordered gate chain):
   - runtime profile is `autonomous` (set with `--operator-approval-ref`;
     audited in runtime-profile-history);
   - `assert_autonomy_unlocked(lane="L1")` passes against the REAL
     enterprise acceptance ledger (30 `observe_success` events from a
     PASSED real-mode burn-in — the mock operational-proof lane writes to a
     separate ledger by design and can never satisfy this);
   - the auto-merge policy master switch is enabled (`DEFAULT_POLICY`
     ships `"enabled": false`; the operator override is an explicit commit);
   - enterprise readiness, runner attestation, rollback bundle, incident
     pre-row, diff/change-ledger/branch-tip triple-gate, and a fresh
     pre-merge re-check all pass;
   - none of the three circuit breakers (cost, failure-count, cross-host
     lease) is tripped.
4. **Two-stage separation-of-duties approval remains reserved for risk-L3**
   (control-plane) merges. The narrow risk-L1 lane does not require a second
   signer; the second-signer decision is therefore NOT a blocker for this
   lane and is deferred to the first control-plane autonomous change, which
   this ADR does not authorize.

## Activation ceremony (operator runbook)

1. Trigger `aria-auto-cycle` with `mode=burn-in-observe` (workflow_dispatch)
   → REAL 30-cycle observe burn-in → `record_burn_in_acceptance(mode="real")`
   bridges the report into the acceptance ledger → `autonomy unlock` verdict
   for ladder-L1 flips valid.
2. Observe ≥1 week of nightly cycles at the DEFAULT scheduler ceiling
   (aria-auto-cycle cron) with the daily anchor `roi` block confirming spend
   behaves within caps.

   > **Amendment 2026-08-19 (ORPHAN-HIGH-728).** The nightly lane no longer
   > hardcodes `--profile standard`: it resolves
   > `min(scheduler_profile_ceiling, L1-ladder verdict)` per run. This step
   > stays reachable because the ceiling defaults to `standard` and only an
   > operator can raise it (`runtime_profile.set_profile` refuses a
   > non-operator setter that tries), so step 1 flipping the ladder valid
   > cannot end the observation window step 2 is made of. Raising the ceiling
   > to `strict` is a SEPARATE operator gesture — it belongs after this
   > window, and it grants PR-opening authority only: `pr_merge` remains
   > `autonomous`-only and no scheduled resolution can reach `autonomous`
   > (`runtime_profile.SCHEDULER_MAX_PROPOSABLE_PROFILE`), so steps 3-4 below
   > are unchanged and still gate every merge.
3. Enable the master switch via the auto-merge policy override (explicit
   commit, reviewed like any policy change — it lives under a risk-L3 path).
4. Start an autonomous-profile run with `--operator-approval-ref`; watch the
   first candidate merge end-to-end (dry-run row precedes the live merge in
   `pr-lifecycle.jsonl`).
5. Rollback: revert the enabling commit (single-commit revert), or trip
   `ARIA_STOP` / profile downgrade for immediate halt; breakers auto-trip on
   cost/failure anomalies.

## Executable proof (shipped with this ADR)

`aria-kernel/tests/test_narrow_lane_inactive_until_unlock.py` pins the
inactive-today claim: the risk classifier routes docs/tests to L1 and policy
files to L3; the empty enterprise ledger fails `evaluate_autonomy_unlock`
for every ladder lane; the shipped auto-merge policy refuses with
`auto_merge_disabled`; and `auto_merge_candidate_lanes` stays `["L1"]`.
A change that accidentally (or maliciously) widens any of these gates turns
the suite red.

## Consequences

- No behaviour changes on merge of this ADR — every gate above already
  refuses; the tests make that refusal a pinned contract instead of an
  implementation accident.
- The activation ceremony consumes evidence the nightly producer lane
  (ADR-relates: aria-auto-cycle) generates as a side effect of normal
  operation, so the ladder progresses without dedicated operator work
  beyond the two explicit triggers.
- Conflating the two L-scales is now a documented, test-adjacent hazard;
  future lane work cites this ADR's terminology table.
