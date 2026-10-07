# ARIA mints agent requests faster than the executor drains them (2026-10-07)

Owner: claude (implementation), okan (review). Deadline 2026-10-14.

## ARIA-HIGH-364

RCA blocker 2 (2026-10-06): minting is not tied to drain capacity or executor liveness.

Measured on a copy of the runner's store (2026-10-06):

- ARIA minted about 66 agent requests a day and the executor drained about 28.
- The request ledger held 1,866 rows: 836 `ANCHOR_STALE`, 606 never claimed, 373 accepted.
- 325 requests were minted between 09-27 and 10-04, while the executor workflow was disabled.
- The human-required panels alone minted about 18 envelopes a cycle into a 630-request backlog.

Evidence (at `main@958eed5b7`):

- `aria-kernel/aria_kernel/agent_invocations.py:1280`: the mint takes no decision. Every producer
  calls it directly.
- `aria-kernel/aria_kernel/judge_fanout.py:300`, `human_required_adjudication.py:443`,
  `autonomy_orchestrator.py:419`, `goldset.py:286` and `convergence_drainer.py:1048` start new
  work without reading the drain. The judge fan-out's per-role cap counts its own role only.
- `aria-kernel/aria_kernel/planner_dispatch_hook.py:72`: the planner daemon does not back off on a
  cooled provider. It claims, the child refuses `no_eligible_provider`, and it releases on every
  poll.

Rule: a request is minted only through one admission decision. That decision must know how fast
the queue drains, whether anything drains it, and whether any provider can run the role.

Fix:

- `request_admission.admit_request(producer, role, ...)` is the decision. The mint requires its
  `Admission` (no default) and refuses a refused one for a new identity.
- `PRODUCER_CLASSES` classifies every producer per role, with no default:
  - `critical_path` is plan rounds, the remint of a dead step, implementation of a CONVERGED plan
    and its reviews, and operator mints. These are always admitted and recorded.
  - `discretionary` is judge, arbiter and replay panels, adjudication panels, goldset curation,
    change intelligence, decision questioning, queue projections, plan seeding and genesis
    authoring runs.
- A discretionary mint is admitted only when all three hold:
  - the executor drains: it has a result or claim within 36 h, or no claimable request has waited
    36 h;
  - the role has a provider that is not cooled (`provider_cooldown.active_provider_cooldowns`);
  - `backlog + n <= max(32, 2.0 x drained/day over 7 days)`. The backlog counts only claimable
    requests inside the anchor window.
- The knobs are policy (`genesis_policy` block `request_admission`, refused out of bounds). The
  snapshot is measured once per cycle with the batch `derive_request_states` (ARIA-HIGH-358).
- A refusal is `request_admission_throttled:<reason>`. It is recorded once per (cycle, producer,
  role, reason) on `agent-invocations/admissions.jsonl`, and on governance once per (cycle, role).
- Each producer re-derives refused work next cycle. Goldset curation used to ask only on the cycle
  its proposal changed; it now asks from the latest proposal.
- The daily report gains `## Request Admission`.
- The planner daemon returns `provider_cooldown` before claiming, and that status is in its
  back-off set.
- Adjudication panels are discretionary, so the same budget also caps the anchor_stale-to-panel
  amplifier (ARIA-HIGH-360, 37%). The finding-opener throttle (`cycle_guard`) and the step remint
  budget (`step_request`) are unchanged.

### Review of #1833 (2026-10-07)

- HIGH-1, seeding starved: panels and judges run before the drainer and refill the headroom every
  night, so `plan_seed` was refused every cycle. `plan_seeds_per_cycle` (policy, default 1,
  minimum 1) admits that many new plans per cycle ahead of the budget. The executor must still be
  draining and a provider must be able to run the challenger. A reserved fraction would still be
  consumed by producers that ask earlier, and reordering the cycle couples admission to the order
  of the phases. A quota does neither.
- MEDIUM-2: the mint records `request_admission` (producer, class) on every request. A panel
  re-mint inherits its dead predecessor's class (`human_required_panel.remint_critical` or
  `.remint`), not a role list. A row from before the door re-mints as discretionary.
- MEDIUM-3: a cleared panel whose successor is refused raises `RequestAdmissionThrottled`, and
  the sweep reports it as `throttled_retry`. The record stays open and the next sweep retries.
- MEDIUM-4: the admitted row is written by the mint, in the request's own transaction, only for a
  new identity. A call outside any cycle is measured fresh, not against a day-old snapshot.
  `dispatcher_factory` receives the cycle id.
- MEDIUM-6: `backlog_floor` is at least 1. An out-of-bounds value takes the shipped default and is
  disclosed once on governance (`request_admission_policy_invalid`).
- `admissions.jsonl` is a declared, hash-chained ledger. Every append verifies the chain under its
  lock, and the mint appends inside its state transaction. The cycle and the executor are
  serialized by the shared concurrency group and the state-writer lease. The door's in-process
  view refolds when another writer has appended.

### Merged with main (#1825, #1826, #1836, train #1850)

- One new mint site: `judge_remint.remint_judge_request`, reached from the panel re-mint
  (`remint_judge_for_panel`) and the anchor-stale disposition (`anchor_stale_effects.remint_judge`).
  Both now carry an admission that inherits the dead judge's recorded class
  (`human_required_panel.remint*`, `anchor_stale.remint*`). The executor convergence advance runs
  the drainer (plan steps, critical path; it never seeds), and the converged seam mints through
  the implementer (critical path).
- MEDIUM-5: `remint_judge` re-raises `RequestAdmissionThrottled` ahead of its `GovernanceError`
  operator arm, and the sweep records nothing for that request (`throttled_retry`). The next sweep
  decides it again; it is never an operator escalation.
- One admission predicate for an outage: `provider_outage.provider_outage` over the cooldown rows.
  `provider_clock` (ARIA-HIGH-365) reads the outage intervals to answer "was the provider out
  then", which the lease reaper asks; it does not admit.

### Re-review of #1833 (2026-10-07)

- HIGH-A: the anchor-stale sweep's bound now counts decided items, not examined ones. Before it
  re-mints, it asks the door once per (producer, role). A refused class waits like a full judge
  backlog: no record, retried next cycle, and no slot taken. Previously the same newest refused
  judges were re-planned every cycle, and the older open records and expiries behind them were
  never decided. The `RequestAdmissionThrottled` arm stays for the budget edge inside one sweep.
- MEDIUM-B: the orchestrator asks the door (`convergence_drainer.seed_admission`, the drainer's
  own question) before booking a new plan. A refused seed writes one governance row
  (`convergence_seed_throttled`). It is not counted as minted or rejected and starts no
  convergence.
- MEDIUM-C: the earlier claim was overstated. A panel opened as discretionary, so under backlog
  pressure the critical re-mint behind it was unreachable. A panel now opens under the dead
  request's recorded class (`human_required_panel.open_critical`). A critical death
  (implementation, Gate-B or expert review, authoring step) is recovery of in-flight work. In-flight
  plans never depended on it: the drainer re-mints a dead plan step itself.
- A critical call reads no ledger. An uncycled key is never cached, and the cache keeps the 16
  newest cycles.

## ARIA-MEDIUM-376

`aria-kernel convergent-plan` could not run at all. The subcommand imported
`start_convergent_plan_with_envelope`, which V8 deleted (B-V2-07), so both `start` and
`issue-challenger` died on an `ImportError` before argument dispatch. The neighbouring CLI test
asserted only that no `TypeError` appeared, which an `ImportError` also satisfies.

Evidence (at `main@958eed5b7`): `aria-kernel/aria_kernel/cli.py:5680` (the import) and
`aria-kernel/tests/test_cli_issue_challenger.py:100` (the assertion an `ImportError` passes).

Fix: `convergent_planning_bridge.start_convergent_plan_with_challenger` runs the V8 shape the
drainer's seed branch runs. It opens the plan with `start_convergent_plan_drafted_by_primary`, then
mints the round-1 challenger, with scope, obligations and evidence derived from the plan's own
`plan_started` record (ARIA-HIGH-345). The operator's obligations are added to those. `start`
loses `--evidence-ref` and `--allowed-scope` and gains `--workspace-root`. A subprocess test runs
`--help`, `start` and `issue-challenger` end to end.
