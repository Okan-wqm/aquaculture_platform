# ARIA agent_eval — mock-only evaluation and no procedural memory (2026-10-02)

Context: kernel item K10 "AE" of the memory and repository-knowledge program (K-11: "agent_eval
switches to real mode: drafter / implementer performance is measured and written to procedural
memory"; audit 5 BLOCKERs: learning is not measured, procedural events have no writer and no
reader). Measured on `origin/aria/state` on 2026-10-02.

Owner: claude (implementation), okan (review). Deadline 2026-10-16.

## ARIA-HIGH-285 — agent_eval runs only in mock mode and measures no agent

Three defects in one organ, read on `main @ 2d582ae0c`:

1. **The switch defaults to mock.** `run_agent_eval(mock_mode: bool = True)`
   (`aria-kernel/aria_kernel/agent_eval.py:272`) answers a fixture with `_mock_response_envelope`
   (`:249`), which copies the fixture's expected verdict and evidence, so a mock run cannot fail
   (`:313`). The CLI defaults to it too (`cli.py:1221`, `--mock-mode` `store_true` `default=True`;
   `cli.py:4091` `mock_mode = not args.no_mock_mode`), and the only scheduled caller,
   `.github/workflows/aria-agent-eval.yml:144`, never passes `--no-mock-mode`.
2. **Real mode had no producer.** `mock_mode=False` needs the response of a ledger-bound
   invocation, eight `SourceLedgerRef`s and an unexpired operator approval
   (`_validate_real_eval_provenance`). Only the operator-run genesis SHADOW bridge
   (`shadow_eval_bridge.py`) assembles them; no lane does, and the autonomy cycle never calls
   agent_eval at all.
3. **No procedural memory.** Drafter and implementer outcomes are recorded (plan evaluated or
   abandoned, implementation merged or rejected, attributed self-reverts) and never become
   performance. Nothing writes or reads a procedural memory event, so no planner or implementer
   can learn from a repeated failure.

Measured on `origin/aria/state`:

- `tools/agent-evals/runs.jsonl`: 30 rows, all `mock_mode: true`, all passed — five fixtures on
  2026-08-12, 08-16, 08-23, 08-30, 09-20 and 09-27.
- `tools/plans/events.jsonl`: 17 plans — 13 abandoned (`stalled`), 3 escalated to HUMAN_REQUIRED
  (`convergence_envelope_dead:challenger_plan`), 1 open; no implementation event.
- No ledger carries a procedural memory event; `tools/agent-genesis/requests.jsonl` holds 15
  requests, all `requested`.

Rule: agent evaluation measures real outcomes. The kernel offers no runtime switch that
substitutes a synthesized response; when the evidence a measurement reads is missing, the
measurement refuses by name in governance. Measured performance lands in a declared, append-only
procedural memory surface that a later actor reads.

### Fix (same branch)

- `agent_eval.run_agent_eval` has no `mock_mode` and no envelope synthesizer; the CLI's
  `agent-eval run` has no mock flag and requires `--real-envelope-file`. A test that wants a
  fixture run builds a fake invocation ledger. Historical mock rows stay readable and segregated.
- `agent_eval.observe_agent_performance` is the real mode: one procedural `performance_observed`
  event per finished drafter episode (plan evaluated or abandoned) and implementer episode
  (merged or rejected), and a superseding event when a self-revert is attributed to a merge. No
  LLM call. `reflection.run_reflection` runs it on every cycle path; with no plan ledger it
  records `agent_eval_real_refused` (`agent_eval_inputs_missing:plan_convergence_events`) in
  governance and on the reflection row.
- Surface `memory_procedural` (`memory/procedural.jsonl`) is declared exactly like the six
  `memory/*` ledgers. The K2 lane (`fix/aria-memory-not-compactable`) flags those `memory=True`;
  a test pins the new declaration equal to `memory_learning_events` but for name and path, so it
  goes red after the K2 merge until the flag is set here too.
- Reader: `cross_review_bridge.issue_implementation_envelope` adds an `observed_failure_mode`
  must-check obligation for every attributable failure mode the implementer hit in three or more
  episodes (the program plan's lesson trigger).
- The weekly lane registers fixtures, runs the same observation, prints the KPIs and reports the
  real fixture-run windows; it runs nothing in mock mode.

### Learning KPIs (K-10)

Live, from the recorded episodes (`agent-eval kpis`, doctor organ `learning`):

- repeat-failure rate per role, split by failure mode;
- implementer scorecard and drafter scorecard per agent (episodes, attributable, succeeded,
  success rate, outcomes). Lane failures (`stalled`, `convergence_envelope_dead`, lease and poll
  timeouts) are recorded and kept off an agent's scorecard.

Not computable from recorded evidence, named in the KPI output:

- repeat-failure rate per class_key: plans record no class_key (tool:rule);
- memory ablation: no replay lane runs a request with memory on and off;
- precision trend after an FP label: no signed FP label and no ARIA-authored detector precision
  series exist;
- impact-miss rate: no recorded row places a post-merge regression's paths against the plan's
  impact closure;
- implementer scorecard per agent_version_hash: implementation events record the agent name only.

On the live plan ledger the observation records 16 drafter episodes, all lane failures: repeat
rate 0.875 (13 `stalled`, 3 `convergence_envelope_dead`), no attributable drafter episode, no
implementer episode.
