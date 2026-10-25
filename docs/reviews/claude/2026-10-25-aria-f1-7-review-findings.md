# ARIA F1.7 review: non-blocking findings (2026-10-25)

The F1.7 package (compare_eval_windows gains a paired exact-McNemar gain mode, alpha and
min_discordant_pairs are pre-registered in genesis_policy, genesis_superiority decides on real runs
only) was reviewed on branch `feat/aria-f17-paired-gain-test` under lenses ssot and evidence. The
points below did not block the merge. They were re-checked at the branch head (5ada00c87) before
registration; a few cited line numbers moved after main was merged in (for example
agent_eval.py:849-863 is now 848-863, :200-203 is now :205-208 and :893-953 is now 943-955) and the
entries cite the head's. Ten review points are registered as nine findings: the two held-out points
are one (ARIA-MEDIUM-946). No point was dropped: every cited location still exists and supports its
claim.

## ARIA-HIGH-943

The EVAL_WINDOW -> ACTIVE significance level has two pre-registered owners: the gate reads
superiority.alpha while service_expertise.genesis.alpha (SE-13), documented as that same level, is
read by nothing, and the SE-13 text says p < alpha where the code promotes at p <= alpha

- Severity: HIGH; owner: Okan-wqm; deadline: 2026-11-20.
- Raised by: the F1.7 review (lens ssot), registered by the F1.7 findings clerk; non-blocking at
  merge.
- Plan item(s): F1.7.
- Evidence:
  - `aria-kernel/aria_kernel/data/genesis_policy_default.json:154-155` (service_expertise.genesis
    \_doc and alpha: 'EVAL_WINDOW -> ACTIVE ... p < alpha (PREREG's own level)')
  - `aria-kernel/aria_kernel/data/genesis_policy_default.json:182-188` (the new superiority block:
    alpha 0.05, whose \_doc calls it a copy of service_expertise.genesis.alpha)
  - `aria-kernel/aria_kernel/genesis_policy.py:1040` (SERVICE_EXPERTISE_SCHEMA genesis.alpha)
  - `aria-kernel/aria_kernel/genesis_policy.py:1054` (SUPERIORITY_SCHEMA alpha)
  - `aria-kernel/aria_kernel/genesis_policy.py:1088` (service_expertise_policy: no caller outside
    tests)
  - `aria-kernel/aria_kernel/genesis_superiority.py:98` (the gate passes the superiority block's
    alpha)
  - `aria-kernel/aria_kernel/agent_eval.py:960` (the paired verdict is p_value <= alpha)
- Rule: One owner per concept (CLAUDE.md Working Style; PLAN-v2 F1.8: parameters are pre-registered
  in genesis_policy): the level of the EVAL_WINDOW -> ACTIVE decision is pre-registered once, and
  the comparison operator the pre-registration states is the one the code applies.
- Failure scenario: The review's probe set service_expertise.genesis.alpha to 0.01 and printed
  'service_expertise.genesis.alpha = 0.01' beside 'superiority.alpha (the gate reads) = 0.05', so
  tightening the SE-13 level changes no promotion. A p-value exactly equal to alpha promotes in code
  (p <= alpha) while the SE-13 text says p < alpha. Not a blocker at merge: the spec puts alpha in
  the superiority block and both shipped values are 0.05. The clerk's grep found no caller of
  service_expertise_policy outside tests.
- Close condition: One owner. Either the gate reads service_expertise.genesis.alpha and
  superiority.alpha is deleted, or SE-13 drops genesis.alpha by a PREREG amendment and its \_doc
  points at superiority.alpha (the spec puts alpha in superiority). The \_doc text and the code use
  the same operator, pinned by a test at the boundary (alpha set equal to an exact p-value). A test
  overrides the surviving key and shows the gate follows it, and the strict parser refuses the
  removed key by its dotted path.

## ARIA-HIGH-944

The EVAL_WINDOW -> ACTIVE gate compares an entity with its own previous window
(incumbent_agent=entity_id), never a candidate with the incumbent it would replace, so it measures
change over time, and a new entity with no runs 30-60 days ago is always insufficient_evidence

- Severity: HIGH; owner: Okan-wqm; deadline: 2026-11-20.
- Raised by: the F1.7 review (lens evidence), registered by the F1.7 findings clerk; non-blocking at
  merge.
- Plan item(s): F1.7.
- Evidence:
  - `aria-kernel/aria_kernel/genesis_superiority.py:95` (incumbent_agent=entity_id)
  - `aria-kernel/aria_kernel/agent_eval.py:944-945` (an incumbent that is the candidate is read as
    its own previous window)
- Rule: PLAN-v2 section 2 'Kazanç/anlamlılık' and the Rule of ARIA-HIGH-734: gain is a paired test
  of a candidate against the incumbent on the same case ids.
- Failure scenario: An unchanged entity reads 'improved' only at the noise rate (<= alpha), so the
  A/A defect is fixed, but the test cannot say whether the candidate beats the version it would
  replace: any change in the environment between the two windows reads as a gain or a loss of the
  entity. A genesis entity with no eval run 30 to 60 days old has no previous window, so its proof
  is insufficient_evidence however well it does. The base window mode was also self-against-past and
  the commit body of c281aa278 documents the self mode, so this is not a regression; it was a
  non-blocking point at merge. Whether the gate is reachable in production at all is
  ORPHAN-HIGH-837.
- Close condition: compute_eval_window_superiority names the incumbent the candidate would replace
  (the ACTIVE version, or the entity's pre-change baseline) and runs the paired test on the same
  cases in the same window; the self-against-previous-window branch of \_compare_paired is deleted.
  This needs ARIA-MEDIUM-945 first. A test: a candidate with no history older than 30 days, run
  beside its incumbent on the same cases, gets a verdict.

## ARIA-MEDIUM-945

The distinct-incumbent side of the paired gain test can never pair real eval runs: a fixture_id is
globally unique with one target_agent and a run takes its target_agent from the fixture, so two
agents cannot run the same case, paired_case_count is always 0 and only hand-written run rows reach
a verdict

- Severity: MEDIUM; owner: Okan-wqm; deadline: 2026-11-20.
- Raised by: the F1.7 review (lens evidence), registered by the F1.7 findings clerk; non-blocking at
  merge.
- Plan item(s): F1.7.
- Evidence:
  - `aria-kernel/aria_kernel/agent_eval.py:182` (the fixture file is keyed by fixture_id alone)
  - `aria-kernel/aria_kernel/agent_eval.py:205-208` (a re-add with a different content hash is
    refused)
  - `aria-kernel/aria_kernel/agent_eval.py:367` (a run row takes target_agent from the fixture)
  - `aria-kernel/aria_kernel/agent_eval.py:946-953` (the distinct-incumbent branch pairs the two
    agents' fixture_ids)
- Rule: PLAN-v2 section 2 'Kazanç/anlamlılık': candidate and incumbent are measured on the same case
  ids; a code path the data model cannot reach is exercised only by hand-written rows.
- Failure scenario: The review's probe added CASE-001 for 'cand' and then for 'inc' and printed
  'REFUSED fixture CASE-001 already exists with different content hash'. Real runs of two distinct
  agents never share a fixture_id, so on real data paired_case_count is 0 and the verdict is
  insufficient_evidence; the tests reach a verdict only with hand-written run rows. Not a blocker at
  merge: the promotion wiring uses the self mode (ARIA-HIGH-944).
- Close condition: A case can be run against more than one agent: either a fixture lists several
  target agents or the run is told its target and the fixture is agent-neutral, with one owner of
  that fact. A test runs one fixture through run_agent_eval for two agents and the paired mode reads
  paired_case_count 1 with no hand-written row.

## ARIA-MEDIUM-946

'Same held-out case ids' (PLAN-v2 section 2, the Rule of ARIA-HIGH-734) is not represented: the
paired test pairs any fixture_id both sides ran and the kernel has no held-out notion, so the commit
that closes ARIA-HIGH-734 delivers its significance test and mock exclusion but not the held-out
part of its Rule

- Severity: MEDIUM; owner: Okan-wqm; deadline: 2026-11-20.
- Raised by: the F1.7 review (lens ssot and evidence), registered by the F1.7 findings clerk;
  non-blocking at merge.
- Plan item(s): F1.7.
- Evidence:
  - `aria-kernel/aria_kernel/agent_eval.py:943-955` (pairing on every fixture_id both sides have, no
    held-out restriction)
  - `docs/reviews/claude/2026-10-21-aria-quality-learning-program.md:104` (the Rule of
    ARIA-HIGH-734: a paired test on the same held-out case ids)
- Rule: PLAN-v2 section 2 'Kazanç/anlamlılık': the paired test runs on the same held-out case ids; a
  finding closes only when its Rule is delivered.
- Failure scenario: Any fixture both sides ran counts, and nothing marks a case as held out, so a
  gain on cases the agent was shaped on counts the same as a gain on unseen ones. Two review lenses
  reported this separately (ssot: the case set must be restricted in one place; evidence: the
  closing commit does not deliver the held-out clause); merged here. Acceptable until the sealed
  case set exists (ARIA-MEDIUM-766), but ARIA-HIGH-734 closes through its Closes: trailer without
  it.
- Close condition: When the sealed case set exists (ARIA-MEDIUM-766), \_compare_paired takes the
  held-out case-id set as an explicit argument and restricts the shared cases to it in this one
  place; the F1.8(a) and Kurul seam calls it with that set. A test: cases outside the set never
  enter the discordant pairs.

## ARIA-MEDIUM-947

compare_eval_windows' window mode still emits improved/regressed/flat from any pass_rate delta, with
no significance test, in the same words as the paired gain test; the weekly aria-agent-eval workflow
reports it as 'is round N+1 better than round N?' and the CLI exits 1 on an untested 'regressed'

- Severity: MEDIUM; owner: Okan-wqm; deadline: 2026-11-20.
- Raised by: the F1.7 review (lens ssot), registered by the F1.7 findings clerk; non-blocking at
  merge.
- Plan item(s): F1.7.
- Evidence:
  - `aria-kernel/aria_kernel/agent_eval.py:848-863` (the verdict is the sign of the pass_rate and
    consistency deltas)
  - `aria-kernel/aria_kernel/cli.py:4858-4875` (agent-eval delta prints it and exits 1 on
    'regressed')
  - `.github/workflows/aria-agent-eval.yml:182-199` (the weekly delta report per agent)
- Rule: One owner per concept: 'improved' and 'regressed' mean one thing, a significant paired
  difference (PLAN-v2 section 2 'Kazanç/anlamlılık').
- Failure scenario: The A/A 'improved' rate of about 36 % (measurement review M1; 48 of 100 trials
  in the F1.7 A/A fixture) remains on an operator-facing surface, and two producers emit the same
  'improved' label with different meanings. The F1.7 change adds a 'mode' field and documents that
  the window mode decides nothing; the labels are unchanged. Pre-existing, not a blocker at merge.
- Close condition: The window-mode labels are renamed (trend_up, trend_down, trend_flat) so
  'improved' and 'regressed' come only from the paired mode, or the weekly workflow and agent-eval
  delta call the paired mode; the exit code of agent-eval delta is no longer decided by an untested
  trend. A test: the window mode never emits 'improved' or 'regressed'.

## ARIA-MEDIUM-948

aa_noise_floor is the paired test's own exact size at n (<= alpha by construction), not a measured
A/A rate, so it cannot detect a broken exchangeability assumption in the self mode such as provider
or model drift between windows (PLAN F1.8 property 4); no consumer reads it and no test asserts it

- Severity: MEDIUM; owner: Okan-wqm; deadline: 2026-11-20.
- Raised by: the F1.7 review (lens evidence), registered by the F1.7 findings clerk; non-blocking at
  merge.
- Plan item(s): F1.7.
- Evidence:
  - `aria-kernel/aria_kernel/agent_eval.py:966-969` (computed from alpha and the pair count only)
  - `aria-kernel/aria_kernel/agent_eval.py:926-929` (the docstring: the test's exact size at this n)
  - `aria-kernel/aria_kernel/agent_eval.py:984` (emitted in the result)
  - `aria-kernel/tests/test_paired_gain_test.py:165` (the A/A test checks the promotion rate, never
    this field)
- Rule: PLAN-v2 section 2 (an A/A noise floor) and F1.8 property 4 (behaviour changes over time): a
  field named for an empirical A/A measurement is one, or is named for what it is.
- Failure scenario: Provider or model drift between the two windows makes an unchanged entity read
  'improved' more often than alpha, and aa_noise_floor still prints the theoretical size (<= alpha).
  A reader may take it for an empirical A/A check and trust the verdict. The clerk's grep found the
  field emitted and read nowhere.
- Close condition: Either the field is renamed for what it is (the exact size at n) and documented
  as theory, or the self mode measures an empirical A/A rate (for example the same test on two
  halves of one window) that can exceed alpha when the windows are not exchangeable, and the verdict
  is flagged then. A test with a built-in drift between two windows shows the measured rate move.

## ARIA-LOW-949

Repeated looks are not controlled: every record_transition attempt to ACTIVE recomputes the paired
proof, so the false-promotion rate across looks exceeds alpha; this is the F1.8(a) anytime-valid
decision, which the PAIRED_TEST name leaves room for

- Severity: LOW; owner: Okan-wqm; deadline: 2026-11-20.
- Raised by: the F1.7 review (lens evidence), registered by the F1.7 findings clerk; non-blocking at
  merge.
- Plan item(s): F1.7 and F1.8(a).
- Evidence:
  - `aria-kernel/aria_kernel/genesis_lifecycle.py:359-372` (the proof is recomputed on every ACTIVE
    attempt)
  - `aria-kernel/aria_kernel/agent_eval.py:885` (PAIRED_TEST names the fixed-n test)
- Rule: PLAN-v2 F1.8(a) and property 1: ARIA looks at results every cycle, so a fixed-n test's error
  rate grows with every look.
- Failure scenario: Each cycle that retries the ACTIVE transition is another look at growing
  evidence and the first look that reaches p <= alpha promotes, so across k looks the chance that an
  unchanged entity is promoted exceeds alpha (the SE-13 \_doc already says every run is a counted
  look). Not done in the F1.7 package by design: its commit body names F1.8(a) as a later package.
- Close condition: F1.8(a): a sequential, anytime-valid decision (e-value or confidence sequence)
  takes the paired mode under its own test name. Exit (PLAN-v2): on an A/A fixture, looked at every
  cycle, the 'improved' rate is <= alpha.

## ARIA-LOW-950

Two Wilson interval implementations exist: calibration_actuator.wilson (90 %, returns the interval)
and judge_calibration.wilson_lower (z parameter, 95 % by default, returns the lower bound); the
paired mode correctly reuses wilson_lower

- Severity: LOW; owner: Okan-wqm; deadline: 2026-11-20.
- Raised by: the F1.7 review (lens ssot), registered by the F1.7 findings clerk; non-blocking at
  merge.
- Plan item(s): F1.7.
- Evidence:
  - `aria-kernel/aria_kernel/calibration_actuator.py:75` (WILSON_Z = 1.645)
  - `aria-kernel/aria_kernel/calibration_actuator.py:82` (wilson)
  - `aria-kernel/aria_kernel/judge_calibration.py:340` (wilson_lower, z=1.96)
  - `aria-kernel/aria_kernel/agent_eval.py:981` (the paired mode calls wilson_lower)
- Rule: One owner per concept: the Wilson score formula lives in one function.
- Failure scenario: A fix to the formula (an edge case at 0 or n successes, a continuity correction)
  lands in one copy only. The two differ in z and return shape; the formula is the same.
  Pre-existing; the F1.7 change did not add a copy.
- Close condition: One module owns the Wilson score formula with z a parameter; wilson_lower and
  calibration_actuator.wilson both derive from it; a test pins both callers on the same known table.

## ARIA-LOW-951

A comment in the A/A promotion test says the base window comparison promotes about 44 % of the
trials, but the branch's own commit body (2fd9ad9fc) measured 48 of 100

- Severity: LOW; owner: Okan-wqm; deadline: 2026-11-20.
- Raised by: the F1.7 review (lens evidence), registered by the F1.7 findings clerk; non-blocking at
  merge.
- Plan item(s): F1.7.
- Evidence:
  - `aria-kernel/tests/test_paired_gain_test.py:167` (the '~44%' comment)
- Rule: Code comments state what is true (Working Style: report faithfully): a number in a comment
  is the number the run measured.
- Failure scenario: A reader trusts the comment and finds a different number in the commit body; the
  figure is the evidence the test was written against.
- Close condition: The comment carries the measured 48 of 100 for the seed in the test, or names no
  number.
