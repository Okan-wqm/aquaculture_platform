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
