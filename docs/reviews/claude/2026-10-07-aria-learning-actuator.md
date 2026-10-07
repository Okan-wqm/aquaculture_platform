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

### Review corrections (review of #1829)

The review held the merge on 4 HIGH and 3 MEDIUM findings. Each fix below has a test that failed
on the first version of the branch (b7de16a13). Where that version lacked the symbol the test
reads, the test fails on import instead. The sections above describe the first version. Where they
disagree with this one, this section wins.

**HIGH-1. Attribution blocked known-bad codes instead of allowing known-good ones.**

- `failure_attribution.attribute_evaluation` now attributes only codes in
  `ATTRIBUTABLE_GATE_CODES`:
  - `material_cross_review_risks_present`, `unresolved_material_risk`
    (cross-review rejection);
  - `plan_contract_incomplete`, `critical_risks_present`, `high_risks_present`,
    `unknown_risks_present`, `new_risk_category_round_3`, `coverage_gaps_present`,
    `architecture_spine_regression` (gate refusal).
- A forced escalation (gate decision `human_escalation`) counts as the kernel's only when every
  code it carries is in `KERNEL_FORCED_CODES`. Any other forced row is an operator's act and is
  never attributed.
- Abandons are never attributed.
- `cross_review_self_agreement` (ARIA-HIGH-375, #1831) is kept off the allowlist on purpose. It
  marks a round that failed the cross-review independence check, which is a routing fault in the
  kernel, not the drafter's. A test pins that it stays unattributed.

**HIGH-2. The kernel's own harness verdict was ignored.**

- A dead step is attributed only when its last release has fault domain `request`, and when no
  harness release came after the rejected result. Every outage kind, and any unclassified string,
  is excluded.
- These are excluded too:
  - the validator's "could not verify" codes and `*_evidence_baseline_unavailable`;
  - the kernel-owned codes `response_schema`, `separation_of_duties` and `plan_contract`;
  - the extraction failure `plan_content:absent_or_not_object`;
  - any refusal class outside `agent_contract.REASON_CLASSES`. The executor now records such a
    class as `unspecified`.
- `attribution_void.ATTRIBUTION_VOID` voids an attribution whose kernel cause a later fix removed.
  Its entries:

  | Mode                           | Role                    | Before            | Fixed by |
  | ------------------------------ | ----------------------- | ----------------- | -------- |
  | `agent_evidence_path_missing`  | `completeness_critique` | 2026-10-06T16:50Z | #1797    |
  | `agent_evidence_ref_malformed` | `challenger_plan`       | 2026-10-04T06:10Z | #1731    |
  | `agent_refused_evidence`       | `drafter`               | 2026-10-04T06:10Z | #1731    |

  The two #1731 entries cover the `gh-run-list:` pseudo-ref that the kernel's own seed carried.

- Every recorded row now carries `gate_epoch`, a digest of the gate modules.

**HIGH-3. Admission lessons blocked forever and could blame the wrong party.**

- **Wrong party.** Only failures with attribution role `drafter` count. A challenger's or critic's
  failure never refuses the drafter's candidate.
- **No way back in.** The breaker is now half-open. It admits one probe 7 days after the newest
  counted failure, or as soon as the gate epoch has moved. The skip or the selection names the
  breaker state.
- **Identity.** A failing-CI candidate is keyed on its workflow plus its failing `job::step` pairs
  (`plan_content.failing_signature`, which the synthesizer now writes). An F candidate is keyed on
  its ARIA-HIGH-363 subject.
- **Composition with #1826.** The slot policy cools a workflow after any failure, and its drop
  stands alone. This brake only judges what the slot policy kept, and the test pins that it adds no
  duplicate refusal.

**HIGH-4. The calibration actuator flapped, and its revert test proved nothing.**

- **Measure versus dial.** No outcome metric exists for the pressure a dial scales: the
  effectiveness ledger is kept per source and has recorded 0 merges. So no bet is claimed.
  - The dial is the trust weight of a tool's findings.
  - Its measure is the labelled precision of those findings, read through a 90% Wilson interval.
- **Step and undo rules.**
  - A step needs 10 fresh labels whose interval sits on the step's side.
  - A step is undone only when the opposite bound crosses (hysteresis), and a 14-day cooldown
    follows.
  - A window with no labels closes as `held_timeout` after 21 days and takes no further step.
  - The recommendation itself also needs 10 labels.
- **Security adapters** (security-boundary, tenant-scoping, agent-harness-security and
  typeorm-entity-schema) can only be raised, and their floor is 50.

**MEDIUM.**

- The dial is clamped on read as well as on write.
- A flapping verdict is re-judged on each transition.
- The plan and procedural ledgers are read once per synthesis.

**Replay on the real store, after the corrections.**

- **Attribution.** 0 episodes are attributable. Four rows would have been attributed, and the void
  registry names the fix for each: #1731 three times and #1797 once. The 2026-09-18 extraction
  failure is not attributed.
- **Calibration.** Only security-boundary and tenant-scoping still reach 10 labels with a
  recommendation. Both are surfaced as `security_tool_cut_is_operator_act`, and nothing is applied.

### Second review corrections

A second review of the fixes found 1 HIGH and 5 MEDIUM. Every test named below failed on a0e67fefc,
with one exception: `test_a_terminal_lease_expiry_is_not_the_agents` only fails there because the
old code lacks `forced_by`, so it stands as a regression guard.

**H-A. An environment fault plus an allowlisted code still blamed the drafter.** An evaluator row
is now judged as a whole: it is attributed only when every code on it is an allowlisted gate code
or `max_rounds_reached`. Two rows that looked like gate failures are therefore now unattributed:

- `[coverage_environment_unable, material_cross_review_risks_present]`;
- `[architecture_spine_unavailable:git_timeout, plan_contract_incomplete]`.

Without the environment fault, both plans would have gone to NEXT_ROUND.

**M1. The gate epoch hashed the wrong modules.** The epoch is now a digest of the normalized syntax
tree of named gate definitions (`attribution_void.GATE_DEFINITIONS`). That list covers:

- the evaluator, `architecture_spine_gate`, `plan_contract` and `must_satisfy`, which produce the
  allowlisted codes;
- the submission judge, the evidence law and the release vocabulary.

Docstrings are stripped and comments are not in the tree. Of the two options the review offered,
I chose the syntax-tree digest over a version constant: it moves exactly when the gate code
changes, and nobody has to remember to bump anything. A test pins both properties.

The failure's own epoch cannot be recovered, because no ledger records the kernel commit. Recording
time is still a sound bound. The observer runs in the cycle that saw the failure, so a later
deploy can only make the stamp newer. A newer stamp can delay an epoch probe; it cannot grant one
that the gate change did not earn.

**M2. A lease expiry let an earlier rejection stand.** A lease expiry now ends the analysis: the
reaper's `stale` row, or a `lease_expired` requeue or escalation. The global fault domain in
`release_reason` stays `request`, because its reader there is the requeue budget. Only attribution
treats it as silent.

**M3. The operator could fake a kernel escalation.** `force_plan_human_required` now stamps
`forced_by`. It is `operator` by default and on the CLI, and `kernel:<caller>` for the drainer, the
round controller and converged delivery. Only kernel-stamped forced rows are attributed, and an
unknown forcer is refused. Old rows without the stamp stay unattributed.

**M4. A red run with no job data fell back to a workflow-only key.** In that case there is now no
`failing_signature`, the identity is unknown, and the breaker does not count the attempt.

**M5. The one probe was not counted.** Granted probes are recorded in `admission/probes.jsonl`
(declared surface `admission_probes`). A second probe needs a full `PROBE_INTERVAL` since the first,
or a different gate epoch. While a plan is in flight, a probe is not spent.

### Tests

- `tests/test_learning_attribution.py` (10) and `tests/test_learning_attribution_review.py` (13).
- `tests/test_learning_actuator_second_review.py` (10).
- `tests/test_candidate_admission_lessons.py` (12).
- `tests/test_calibration_actuator.py` (12).
