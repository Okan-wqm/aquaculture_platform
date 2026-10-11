# ARIA — a total provider outage loses no work (2026-10-11)

Owner: claude (implementation), okan (review).

Operator decision (2026-10-11): "If Z.ai's quota also runs out and we have no quota at all, jobs
must not be lost." The 2026-10-07 rule ("stop, wait, resume; nothing lost") already had an
owner: the provider-available clock (`provider_clock`, ARIA-HIGH-365), the outage ledger
(`provider_outage_ledger`, ARIA-HIGH-366) and the lease rule (ARIA-HIGH-367). This review maps
every clock that can drop, expire, reject, abandon or charge work while no provider can run, and
closes the five that the existing owner did not reach. Every fix reuses that owner. None adds a
second outage mechanism.

## The map (HEAD 7eb8bef99)

Already outage-aware, and kept as is:

| Clock                                      | Where                                                                                                 | Why it is safe in a total outage                                                                                                                           |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Request anchor TTL, claim gate and sweep   | `agent_invocations.py:3369-3404`, `:3500-3554`                                                        | provider-available age over `role_head_providers`                                                                                                          |
| Agent-request lease reaper                 | `agent_invocations.py:6720-6743`                                                                      | `lease_expired_during_provider_outage:` is harness-class                                                                                                   |
| Requeue budget                             | `agent_invocations.py:2726`                                                                           | the provider-class releases (`provider_quota_unavailable:`, `provider_unreachable:`, `native_runtime_*`) are harness-class                                 |
| Plan stall, 72 h                           | `plan_convergence.py:1178-1203`                                                                       | `available_age` gated by `outage_causality`                                                                                                                |
| Implementation orphan reap, 24 h           | `plan_convergence.py:1071-1130`, `autonomy_orchestrator.py:1474-1495`                                 | `available_age` with `awaits_provider`                                                                                                                     |
| Delivery attempts, `MAX_DELIVERY_ATTEMPTS` | `converged_delivery.py:320-361`                                                                       | the implementer mint is critical path (`request_admission.py:92`) and moves the plan to IMPLEMENTATION_REQUESTED, so a waiting request is never re-offered |
| Convergence rounds                         | `convergence_drainer.py:501`, `:1080-1093`                                                            | no timeout; `max_rounds` is read only after answers                                                                                                        |
| Step remint budget                         | `step_request.py:44-60`                                                                               | PENDING/REQUEUED/STALE are live, so a waiting step mints no successor                                                                                      |
| Judge fan-out, consensus, panels           | `judge_fanout.py`, `human_required.py:752-841`, `human_required_adjudication.py:1253`                 | no deadline; panel judges are requests (above)                                                                                                             |
| HUMAN_REQUIRED SLA                         | `human_required.py:62-68`                                                                             | notify-only, never auto-resolves                                                                                                                           |
| Watchdog stall, F-finding cool-off         | `aria_watchdog.py:320`, `finding_grounding.py:383`                                                    | `provider_clock`                                                                                                                                           |
| Prolonged outage                           | `provider_outage_ledger.py:65`, `:289`                                                                | one HUMAN_REQUIRED item at 30 days; nothing is killed                                                                                                      |
| Signed operator request                    | `operator_request_outage.py:10-58`                                                                    | `expires_at` is a signed term (ADR-0018) and stays wall-clock by design; an expiry that an outage overlapped raises a re-sign item                         |
| Discretionary minting, planner/worker hook | `request_admission.py:298-302`, `planner_dispatch_hook.py:460-484`, `worker_dispatch_hook.py:238-260` | no mint or claim while every provider of the seat is cooled                                                                                                |

Observed and left as is (not a loss, or not reachable in a total outage):

- The outage's own HUMAN_REQUIRED item (HIGH, 72 h SLA) lapses, and the doctor is red for the
  rest of the outage. This is the operator's promise. The item says what to do.
- `judge_fanout.pending_judge_counts` counts on a 4-day wall-clock horizon (`judge_fanout.py:221`).
  After a long outage it under-counts the judge backlog. The admission door's budget still bounds
  minting.
- After a PARTIAL outage, the step remint, the queue re-offer lineage and the panel reopen budgets
  count an `anchor_expired_during_provider_outage:` expiry (`step_request.py:110`,
  `autonomy_orchestrator.py:316`, `human_required_adjudication.py:1391`). In a total outage the
  clock pauses, so no such expiry is written.
- The worker scheduler daemon writes rows per poll. The cycle bounds it with
  `max_iterations_per_phase`, and nothing runs it as a standing service.

## ARIA-HIGH-435 — a Z.ai refusal decided at the admission never cooled Z.ai

### Symptom

Z.ai's admission probe is a real one-token completion (`zai_runtime.probe_zai_status`). Its
refusal is the vendor's own answer: 429/402 and the quota codes are DECIDED UNAVAILABLE as
`quota_or_rate_limited_http_<status>`, and 401/403 as `auth_rejected_http_<status>`
(`tools/aria-poc/zai_runtime.py:339-357`). The admission seam cooled only a logged-out session
(`provider_outage_seams.py:24-48`).

On HEAD a Z.ai 429 row passed through `observe_native_admission` left no outage and no
cooldown (`open_outages() == ()`, `active_provider_cooldowns() == {}`). Two consequences:

1. If the Z.ai quota is first met at an admission, Z.ai never gets an outage interval. Z.ai heads
   `glm_first` (`runtime_profiles.json:109-126`: challenger_plan, cross_review,
   completeness_critique, adversarial_judgment, verification, change_intelligence,
   goldset_curation, maintenance_utility). For all of those roles the provider-available clock
   kept running through a total outage. A challenger request aged into ANCHOR_STALE, and a plan
   waiting on it was ABANDONED at 72 h.
2. If a run did open the outage, the back-off still lapsed within an hour and the admission never
   renewed it. `cooled_providers()` then read Z.ai as serving, so discretionary minting reopened.
   The planner hook claimed, the child refused (exit 0, `planner_dispatch_hook.py:734`) and
   released, and the daemon never backed off. Every claim spent one real Z.ai probe.

### Root cause

The admission was made a detection seam for one fact, the logged-out session (ARIA-HIGH-366).
It was not made one for the other facts a real completion probe decides.

### Fix (tier 2: every decided refusal goes through the one writer)

`provider_outage_seams.admission_signature` maps a decided status reason to its exhaustion
signature. The logged-out reasons keep their exact entries. The completion probe's reasons are
matched by prefix (`COMPLETION_PROBE_SIGNATURE_PREFIXES`: `zai_quota_refusal`,
`zai_auth_refusal`), and the signature must name the row's own provider. The row goes through
`record_provider_cooldown`, the one writer, which opens the outage once per transition. Each
re-probe that meets the standing outage renews the back-off (900 → 1800 → 3600 s, capped at
`MAX_REPROBE_SECONDS`) and writes no second item. A refused request (`request_refused_http_*`)
and a vendor 5xx are not outage facts and cool nothing. Restoring stays with the served spawn: a
200 probe admits, and the spawn restores. `observe_native_admission` takes `now` for a test's
clock.

Tests (`tests/test_provider_outage_signal.py::TheAdmissionDecidesAZaiRefusal`):

- a quota refusal opens the `(zai, quota)` outage and cools Z.ai;
- a credential refusal is an `auth` outage;
- six re-probes across lapsed back-offs renew the cooldown, with one outage and one item;
- `request_refused_http_404` and `vendor_error_http_503` cool nothing;
- the prefixes are pinned to `zai_runtime._classify`'s own reasons.

The first four failed on HEAD (no outage, no cooldown). zaiwriter (ARIA-HIGH-434) confirmed the
reason prefixes are stable.

## ARIA-MEDIUM-436 — a queued item aged on the wall clock its request does not use

### Symptom

`fold_queue` set its horizon to `now - max_age_seconds` on wall time (`next_cycle_queue.py:213`).
Its own window is "the agent request before its mint" (`item_max_age_seconds`, `:141-154`). The
request it becomes ages in provider-available time (`_anchor_expiry_reason`). During an outage
the projection is refused (`autonomy_orchestrator.py:524-531` breaks), so an outage longer than
the window expired every queued item. Only a pressure that the next reflection re-planned into
its top three came back (`reflection.py:109`, `:228-244`). An item the anchor-stale disposition
had re-offered already had its HUMAN_REQUIRED record resolved, so its expiry left no record.

### Fix (tier 1: the one clock, required)

`fold_queue` takes `clock: ProviderClock` as a required argument, so no caller can fall back to
wall time. An item is aged only when its latest offer is older than the window in
provider-available time. The providers are the heads of the roles the projection mints, read
from `request_admission.PRODUCER_CLASSES["next_cycle_queue.projection"]`. Wall time is checked
first, so the ledger is read only for an item already old by the wall clock. Each writer builds
the clock BEFORE its transaction (`item_clock`). A first draft built it inside, and
`ensure_tools_dir` deadlocked on the tools index lock under the queue lock.

Tests (`tests/test_next_cycle_queue_fold.py::AnItemWaitsOutAProviderOutage`):

- an outage longer than the window expires nothing, and the standing item still holds its pressure;
- the window counts again after the restore;
- an outage of a provider the projection is not routed to pauses nothing.

The first two failed on HEAD.

## ARIA-HIGH-440 — the plan-stall rule read only segment 0 of the request ledger

### Symptom

The 10-day end-to-end test (below) mints its requests through the real writer. Its plan waits
on a challenger request through the outage, and on day 3 it was ABANDONED with stall
`{cause: no_request, request_id: None, provider_available_hours: 89.25}`.
`close_abandoned_plan_requests` then CANCELLED the challenger request.

`resume_candidate_plan_id` read `agent-invocations/requests.jsonl` with `load_jsonl`
(`plan_convergence.py:1182-1184`) to find the plan's newest request. Since 5cf8e0f61
(2026-10-02, ARIA-HIGH-275) that file is frozen segment 0. Every new request lands in
`agent-invocations/requests/<YYYY-MM>.jsonl` (`ledger.SEGMENTED_LEDGERS`), whose one reader is
`load_segments`. For every plan started since then, the stall cause therefore read `no_request`,
`request_awaits_provider(None)` answered False, and ARIA-HIGH-365's B1 pause never applied. A
plan waiting through an outage was abandoned at 72 h of wall time, under the wrong cause.

Production (origin/aria/state 75b6e407a, read-only): `requests/2026-10.jsonl` holds 434 rows,
60 of them planning rounds, and segment 0 holds none of October's rows. No October plan has been
abandoned yet (the last abandonment is 2026-09-29), so the defect fires on the first outage that
runs past 72 h.

### Root cause

The B1 tests appended request rows straight into segment 0 (`append_declared_fixture` into
`requests.jsonl`). No writer has put a row there since 2026-10-02. The reader that saw only
segment 0 passed every one of them.

### Class audit

These modules name a segmented surface's segment-0 path. Each is classified by what it does
with it:

| Site                                                  | What it does                                                                 |
| ----------------------------------------------------- | ---------------------------------------------------------------------------- |
| `agent_invocations.py:124`, `:1746`                   | lock anchors of the mint transaction (ARIA-HIGH-275)                         |
| `agent_invocations.py:357`                            | branches on `SEGMENTED_LEDGERS` and reads the family through `load_segments` |
| `budget.py:596`, `tools/aria-poc/ci_executor.py:4313` | lock anchors; the rows are read through `transaction.load_segments`          |
| `merge_authority.py:953/957`                          | `read_prefix` branches on `SEGMENTED_LEDGERS`                                |
| `search.py:31`                                        | `rebuild_index` branches on `SEGMENTED_LEDGERS` and calls `load_segments`    |
| `state_manifest.py:242/300`                           | the surface declarations                                                     |
| `plan_convergence.py:1182-1184`                       | **blind**: `load_jsonl` of segment 0 (this finding)                          |

`specialist_review_runner.py:37/484` mention the path only in docstrings. The one blind reader
is fixed here. No ARIA-MEDIUM-441 was needed.

### Fix (tier 1 for the reader, tier 3 for the class)

The stall rule reads the requests through `load_segments`. `_plan_stall`, the one staleness
rule that ARIA-LOW-439 extracts next, keeps that reader. The B1 tests mint through `create_agent_invocation_request`. With the
segment-0 reader restored, three of them fail (two in B1A, one in E439).
`tests/invariants/test_segmented_ledgers_are_read_whole.py` fails any production module (in
aria_kernel, tools/aria-poc and tools/aria) that hands a segmented family's segment-0 path to a
plain reader. The paths come from `SEGMENTED_LEDGERS`. The pin follows each path through the
names it is bound to, comprehension targets, module tables and same-module helpers. Readers that
branch on the registry are allowed. The pin flags HEAD's `plan_convergence.py:1183`, and its
own shape tests keep it from going blind.

## ARIA-LOW-439 — the in-flight reader judged staleness on the wall clock

### Symptom

`in_flight_plan_id` skipped a plan older than 72 h by wall time (`plan_convergence.py:1223`).
The adoption beside it judges provider-available time (`:1178-1200`). Past 72 h of outage the
plan source therefore saw no plan in flight while the orchestrator adopted one. The plan source
then ran the full detector scan (`cycle_phases/plan_source.py:229-237`) and recorded the
admission-lessons half-open probe (`:290-291`; `PROBE_INTERVAL` is 7 days) on a seed that the
adopted plan made moot.

### Fix (tier 1: one predicate)

`plan_convergence._plan_stall` is the staleness rule both readers ask. The adoption abandons
what it returns. `in_flight_plan_id` only skips it.

Tests (`tests/test_provider_outage_timers.py::E439TheInFlightReaderAsksTheAdoptionsQuestion`):

- the reader and the adoption agree on a plan that a 4-day outage holds (failed on HEAD);
- the reader skips a plan that is really stalled and never abandons it.

## ARIA-MEDIUM-438 — a re-probe of a standing outage was counted as a new harness failure

### Symptom

A drain child that re-probed a provider already in an open outage (the back-off ran out and the
vendor still refused) was `harness_failed` (`ci_executor_drain.py:960-1001`). The run exited red
every re-probe night (`:112-126`). Each `auth_failed` re-probe also recorded a persistent breaker
failure. The failure window is 96 h (`genesis_policy.minimum_window_hours`) and the threshold is
3, and there are two drains a day, so a credential outage tripped the breaker on its second day.
A tripped breaker makes preflight block every action-authority profile, strict included
(`autonomy_orchestrator.py:863-869`). Every kernel-only phase then stopped for the rest of the
outage, and for up to 96 h after the provider came back.

### Root cause

ARIA-HIGH-366 made the outage one fact per transition: one item, and one `::error::` from the
claim that opened it (`ci_executor.py:5373-5380`). The drain's count was the last place that
still counted every re-probe.

### Fix (tier 1: the transition is the one failure)

`provider_outage_ledger.standing_outage` returns the provider's open outage of the given kinds
that was already open when a probe was launched. It compares at the ledger's one-second
resolution, so an outage opened in the second the probe started belongs to the probe. The drain
stamps each child's launch time. A failed child whose `failure_class` reports such an outage
(`OUTAGE_KINDS_BY_FAILURE_CLASS`: `credit_exhausted` → quota; `auth_failed` → auth or
logged_out; `provider_unreachable` → unreachable) is listed in the payload's `standing_outage`
and is attempted, not failed. It is not a breaker event. The route's same-run circuit still
opens, so one drain re-probes an outage once. The child whose failure opened the outage is
counted as before. An unreadable ledger counts the failure, which is the conservative side.

Tests (`tests/test_drain_standing_outage.py`):

- an auth re-probe is green and records no breaker failure;
- a quota re-probe is green;
- the failure that opens the outage is red with one breaker failure;
- no outage on the ledger means the failure is the harness's;
- a restored outage does not excuse a new failure;
- a standing quota outage does not excuse a new credential failure.

The first three failed on HEAD (exit 1, and no `standing_outage` key).

## ARIA-MEDIUM-437 — the worker lane charged every expired lease to the assignment

### Symptom

`worker_dispatch.reap_expired_assignment_claims` wrote `lease_expired` and counted every expiry
(`_lease_expiry_count`). The budget is two (`DEFAULT_MAX_LEASE_REQUEUES`), and the third expiry
is a terminal `human_required` (`worker_dispatch.py:1066-1150`). Sometimes a worker claims while
the provider's back-off has lapsed and the outage still stands, and its runner is then killed.
The hook's timeout path leaves such a claim unreleased (`worker_dispatch_hook.py:309-326`). That
claim spent the assignment's budget. The agent-request lane had answered the same death since
ARIA-HIGH-367 M1 (`agent_invocations._lease_expiry_reason`).

On HEAD, three outage-eaten leases ended `['claimed', 'released', 'claimed', 'released',
'claimed', 'human_required', ...]`.

### Fix (tier 1: one rule, every lane)

The rule moves to its clock owner as `provider_clock.lease_expiry_reason(clock, claimed_at,
expires, providers)`, with `LEASE_OUTAGE_MIN_SHARE`. The agent-request reaper passes its role's
head. The worker reaper passes the head of the ladder that the assignment's target is routed
over. It reads that ladder through the hook's own resolver
(`worker_dispatch_hook.worker_ladder_for_target`, ARIA-HIGH-434), so the dispatch and the reaper
cannot read different agent files. An outage-eaten lease is released as
`lease_expired_during_provider_outage:<provider>`, and its governance row carries the reason.
`_lease_expiry_count` skips such rows. A row written before the reason was recorded still
counts.

Tests (`tests/test_wip_gate.py::ALeaseAnOutageAteIsNotTheAssignments`):

- four outage-eaten leases are all released, none charged, and the assignment stays pending
  (failed on HEAD);
- after the restore, the ladder counts again and ends at `human_required`.

## The end-to-end proof: ten days with no provider

`tests/test_total_outage_continuity.py` runs one scenario on a store minted through the
production writers. During each step, every loaded kernel and executor module's `datetime` is
frozen at the scenario's moment.

The store at T0:

- a plan waiting on its challenger (Z.ai heads `challenger_plan`);
- an evidence judge (Anthropic);
- a CONVERGED plan's implementation request (minted through the real bridge);
- a next-cycle queue item;
- a worker assignment.

The outage:

- **T0+1h:** Anthropic's weekly window is spent. This is the CLI's `rate_limit_event`, reset
  at T0+7d.
- **T0+2h:** Z.ai answers its admission probe 429, and Codex is logged out.
- **Days 0-9:** two drains and one cycle a day.
  - A drain is the real `ci_executor_drain.drain_pending` over the kernel's own
    `next_pending_request`. Its child does what `ci_executor` does on that host: the native
    admission, where a cooled provider is refused unprobed and the others are probed through the
    admission seam; then the claim, the spawn and the exhaustion arm.
  - A cycle runs `sweep_expired_anchors`, `reap_stale_claims`,
    `reap_expired_assignment_claims`, the adoption, the in-flight reader, the orphan reaper's
    decision, the prolonged-outage bound and the reflection's enqueue. The enqueue re-plans other
    pressures and never the queued one again.
- **Day 7:** Anthropic's reset comes, but the subscription is gone, so every re-probe is a
  credential failure.
- **Day 8:** a worker that claimed in a lapsed back-off is killed with its runner.
- **Day 10:** the subscription is renewed, and the first drain's spawn is served.

Asserted through the outage:

- no request expired, was released for its own fault, escalated or re-minted;
- no plan was abandoned or reaped, and no delivery attempt was counted;
- the queue item outlived the window;
- the killed worker's lease spent nothing;
- the only red drain is the day-7 transition, and the failure breaker stayed `ok`;
- the only operator items are the four outage transitions.

Asserted after the restore:

- only Anthropic's outages close;
- the first drain serves both the judge and the challenger (the challenger past its cooled Z.ai
  head);
- the plan continues from its own step with no remint;
- the implementation request, the queue item (whose projection is admitted again) and the
  worker (now claimable) are where they were;
- the clocks count again only for the roles Anthropic heads.

Red/green: all 12 tests fail on 7eb8bef99 with dfe4f63fb's routing applied (no continuity fix),
and all 12 pass with the six fixes.
