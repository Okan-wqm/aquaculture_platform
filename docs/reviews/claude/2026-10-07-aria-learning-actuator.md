# ARIA learning loop has no actuator (2026-10-07)

Context: blocker 7 of the 2026-10-06 loop RCA ("the learning loop has no actuator"). Measured
read-only on the runner store (`.aria-state-store/` in the gharunner actions-runner work
directory) on 2026-10-07 at about 10:40Z, and replayed on a copy in a scratch directory.

Owner: claude (implementation), okan (review). Deadline 2026-10-14.

## ARIA-HIGH-370

### 1. Every plan failure was unattributable

`memory/procedural.jsonl` holds 19 drafter failure episodes:

- 13 `stalled` and 5 `convergence_envelope_dead`, all with `attributable=false`;
- 1 `operator_withdrawn` with `attributable=true`, which records an operator's act as the plan's
  failure.

The episode took the first token of the plan's terminal reason
(`agent_eval.py:923` on main) and filtered it through a denylist of lane tokens
(`UNATTRIBUTABLE_FAILURE_MODES`, `agent_eval.py:844`). `convergence_envelope_dead:<role>` names the
lane, and nothing ever read the cause. For all five dead envelopes the cause is on the
agent-invocation ledgers, one join away:

| Plan (cycle)    | Dead step             | Kernel-named cause                                                 |
| --------------- | --------------------- | ------------------------------------------------------------------ |
| 20260816T182612 | challenger_plan       | result refused by evidence law: `agent_evidence_ref_malformed`     |
| 20260918T153436 | challenger_plan       | release `PLAN_CONTENT_INVALID` `plan_content:absent_or_not_object` |
| 20260929T143339 | challenger_plan       | release `AGENT_REFUSED` `evidence`                                 |
| 20260930T214247 | challenger_plan       | release `AGENT_REFUSED` `evidence`                                 |
| 20261004T073028 | completeness_critique | result refused by evidence law: `agent_evidence_path_missing`      |

The `stalled` plans really are lane failures: 13 plans had no event for more than 72h.

**Fix.** `failure_attribution.py` attributes a failure only when the failure's own evidence names
the work, so the rule is an allowlist of evidence:

- **`evidence_law`** and **`gate_refusal`**: the dead step's latest request is read, then its
  refused result (`agent_evidence_*` codes) or its last claim release (the closed `release_reason`
  code).
- **`cross_review_rejection`**: an evaluation that ended on unresolved material cross-review risk.
- **`agent_refusal`**: the agent refused the request. That refusal is a verdict on the plan, so the
  failure is attributed to role `drafter`.
- **`apply_gate`**: the implementer's change failed a check judged against its own diff.

Runtime and provider releases (fault domain `harness`), lease expiry, stalls, operator acts and
lane-class rejection classes are never attributed. Lane 365's fault domain is respected.

`agent_eval._unrecorded_episodes` re-judges each recorded row once. It appends a superseding row
with a `lineage_id`, so the ledger stays append-only.

**Replay on the real store.**

- **Rows appended:** 7 (6 re-judged, 1 new).
- **Attributable episodes:** 5 of the 19 (before: 0 honest, 1 false).
  - `agent_refused_evidence`: 2, role drafter.
  - `agent_evidence_ref_malformed`: 1, challenger_plan.
  - `plan_content_invalid_plan_content_absent_or_not_object`: 1, challenger_plan.
  - `agent_evidence_path_missing`: 1, completeness_critique.
- **Not attributable:** 14 episodes: 13 stalls and `operator_withdrawn`.
- **Recurring modes:** at `LESSON_EPISODE_THRESHOLD` = 3, the real history holds no recurring mode
  yet. Its largest count is 2.

The completeness-critique refusal cites a state-store path that the kernel itself handed the critic
(`tools/coverage/...json`). The evidence names the critic, and that is how the episode is
attributed. The underlying drift between the mint and the evidence law is RCA blocker 5 (#1797).

### 2. Lessons reach the role's envelope and gate admission

`recurring_failure_modes` counts each mode per attributed role. `planner_lessons` gives an
envelope two kinds of lesson:

- the plan's own lessons, attributed to role `drafter`;
- the lessons of its own role. A challenger's refused outputs reach the next challenger envelope,
  never the primary's.

The role rides in the obligation as data (`attributed_role`). The obligation's text is still the
kernel's template.

`admission_lessons.py` adds the RCA's "kernel-attributed failure modes gate candidate admission".
A candidate is identified by its finding id and the grounds of its evidence refs: the path, or the
pseudo-ref scheme. When the last 3 attributed episodes of earlier plans with that identity all
failed in one mode, `V9PressureSourceProvider` skips the candidate unchanged, and the skip names
the lesson. Behaviour at the edges:

- An operator request is exempt, as it is from the loop guards.
- Unattributed episodes are skipped, not counted.
- A converged episode, a different mode or a changed identity admits the candidate.

### 3. Calibration recommendations pointed at a dial that did not exist

`calibration/recommendations.jsonl` has 36 rows over 36 cycles. Each row recommends four adapter
weights, for example `tenant-scoping-adapter` 50 → 40 at precision 0.19 over 58 labels.

The producer keyed labels by `metadata.pressure_source`, falling back to `tool_id`
(`calibration.py:74`), and read the current weight from the pressure-source table with a default
of 50 (`calibration.py:86`). The counts behind that:

- 0 of 245 labelled rows carry `pressure_source`.
- Every key is an adapter, and every adapter weight is the phantom 50.
- `record_weight_override` refuses any source outside that table (`pressure.py:109`).

So nothing could apply these recommendations, and they were never empty.

The `memory/calibration` and `memory/contradictions` ledgers are a separate matter. They are
written only when a quarantined tool's candidate or belief appears, or when a withdrawn belief is
re-emitted. The store holds 0 withdrawn beliefs. Those two ledgers are empty because no such
events occurred; no producer is missing.

**Fix.**

- **`calibration_dials.py`:** a labelled row measures its tool's dial (`tool_pressure_weight`,
  neutral 50, bounds 20..80). That dial scales the `shadow_raw_delta` pressure that carries the
  tool's raw findings (`pressure.py`). The producer and the Beta-Binomial source calibration share
  one row reader.
- **`calibration_actuator.py`:** after the producer, in the same phase, the actuator does three
  things.
  - **Applies** a recommendation that lies inside the bounds and moves at most 10, with one step
    per dial per window. Each application is recorded in `calibration/auto-applied.jsonl` together
    with its evidence (the recommendation hash, precision and sample count) and its bet.
  - **Judges** the bet once 5 new labels exist. It reverts the dial when they contradict the
    producer's own threshold, and holds the dial otherwise.
  - **Surfaces** everything else as `recommendation_only` with a reason. The pressure-source table
    stays the operator's dial.
- **Profiles:** under observe or frozen, nothing is written.

**Replay.** On the real labels, the first cycle applies all four recommendations:

- bundle-budget 50 → 55;
- kernel-dead-wire 50 → 40;
- security-boundary 50 → 40;
- tenant-scoping 50 → 40.

On the next three cycles, all four are surfaced as `window_open`.

### Tests

- `tests/test_learning_attribution.py` (10): each evidence type is attributed, harness failures
  are not, recorded rows are re-judged once, and the lesson reaches the challenger envelope.
- `tests/test_candidate_admission_lessons.py` (4): admission gating through the production
  provider.
- `tests/test_calibration_actuator.py` (9): bounded apply, surfacing, revert and hold, profile
  withholding, and the pressure dial.
