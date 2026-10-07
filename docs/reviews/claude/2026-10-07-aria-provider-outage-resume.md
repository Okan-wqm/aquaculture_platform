# A provider outage paused nothing: ARIA's timers killed the work waiting for it (2026-10-07)

Owner: claude (implementation), okan (review). Deadline 2026-10-14.

Operator requirement (Okan, 2026-10-07): the subscription or API key may run out and be bought
again later. Everything must continue from where it left off, and nothing may be lost inside ARIA.

Audit base: origin/main `958eed5b7`. Store evidence was read from the runner's `aria/state` store
(read-only).

What already worked: a provider failure is released harness-class (no attempt charged), and a
quota or auth failure cools the provider (`provider_cooldown`). What did not: the cooldown is a
probe back-off, not an outage. No timer could tell "three days without a provider" from "three
days of neglect".

## ARIA-HIGH-365

Wall-clock timers kill work during a provider outage.

- **B1.** `plan_convergence.py:919,1106` abandons a plan whose newest event is older than 72 h.
  The stall record names the cause (`provider_quota_unavailable:anthropic`), and the plan is
  ABANDONED (terminal) anyway. Harness releases write no plan event, so a 72 h outage is a 72 h
  stall.
- **B2.** `plan_convergence.py:941,1054` with `autonomy_orchestrator.py:1314` reaps an
  implementation request outstanding 24 h to IMPLEMENTATION_REJECTED (terminal).
- **B3.** `agent_invocations.py:3292,3429` age a request by `created_at` and mark it ANCHOR_STALE
  (terminal). Each successor spends one of `MAX_STEP_REQUEST_REMINTS = 2` (`step_request.py:60`);
  exhausting them gives `convergence_envelope_dead` and the plan goes HUMAN_REQUIRED. Measured:
  37 of the store's 1157 `anchor_stale` requests had only provider- or harness-class releases, and
  5 plans ended `convergence_envelope_dead`.
- **Operator-request expiry.** `operator_request_terms.py:64` refuses an unconsumed request at its
  signed `expires_at` and spends it. One convergence runs at a time and an outage holds it, so
  requests expire queued behind it.

Fix:

- **One outage fact.** `aria_kernel/provider_outage_ledger.py` writes `provider_outage_opened`
  once per `(provider, kind)` transition and `provider_restored` on positive evidence only: a
  spawn that ran (every kind), or an admission that found the session logged in (`logged_out`
  only). The cooldown's `until` is not a restore. A nightly lane probes up to a day after a reset,
  and counting that gap as available is how the clock would kill work again.
- **The provider-available clock.** `aria_kernel/provider_clock.py`: `provider_available_age(since,
now, roles|providers, base_dir)` is wall time minus the intervals in which every provider heading
  the work's roles was in an open outage. It is the head of the routing ladder, not every rung:
  `provider_not_configured` and `cli_unavailable` are admission-time host facts that never write
  an outage. Counting such rungs as available kept the clock running through the B1/B3 outages
  measured above. Pausing on the head errs only when a rung did serve, and a serving rung writes
  plan and claim events, so the bound is never reached. B1, B2, B3, the claim-time anchor gate
  and the watchdog read it. The clock reads the ledger lazily, only after wall time already
  exceeds a bound.
- **Bound.** `escalate_prolonged_outages` raises one HIGH item for an outage open over 30 days,
  once per autonomy cycle check. It never kills the work it pauses.
- **Outage-overlapped expiries are named.** When an outage overlapped a request's wait but was
  shorter than the excess, the anchor still expires. The `anchor_stale` row then carries
  `anchor_expiry_cause.anchor_expiry_reason_in_outage(<providers>)`, the one spelling
  ARIA-HIGH-360 defines (`anchor_expired_during_provider_outage:anthropic`). It is harness-class in
  `classify_release_reason`, so the expiry disposition spends no re-mint budget on it.
- **Successors.** With the clock, an outage can no longer age a request into ANCHOR_STALE, and the
  lease reap no longer charges an outage (ARIA-HIGH-367 M1). No outage death is left to exempt
  from `MAX_STEP_REQUEST_REMINTS`, so the step rule needs no second clock. A test pins the step
  `live` with zero successors through a 3-day outage.
- **Operator-request expiry: a different seam, on purpose.** `expires_at` is a signed term
  (ADR-0018 B1). It bounds how long a rolled-back store can re-admit a spent request, and it is
  read from git objects, never from runner-writable state (ARIA-LOW-267, ADR-0023). The outage
  ledger is runner-writable, so stretching the signed lifetime by it would let one appended row
  re-open the replay window. The expiry stays wall-clock. `operator_request_outage.py` turns an
  expiry whose life overlapped an outage into one HUMAN_REQUIRED re-sign item carrying the
  request text and finding, so nothing is spent in silence.
- **L1 continuity gap: not extended.** `autonomy_unlock.py:43` certifies that ARIA has been
  running autonomously and successfully, recently and without a hole. An outage is such a hole:
  no autonomous success happened in it, and the next success runs on a renewed credential, maybe
  another model. Bridging it would certify operation that did not occur and could unlock merge
  authority on pre-outage evidence, from a runner-writable ledger (the ARIA-LOW-267 adversary).
  The ladder's rows are evidence, not work: nothing is destroyed, and the ladder re-accumulates.

## ARIA-HIGH-366

Incomplete outage detection, and a signal that was noisy or silent.

- A bare 429, a 529 or a dropped connection released as the generic
  `native_runtime_execution_unavailable` (`ci_executor.py` CLI-exit arm). Nothing was cooled or
  recorded. The comment at `claude_runtime.py:1765` named an `EXTERNAL_OUTAGE` path that did not
  exist.
- A logged-out session was decided at admission (`managed_session_logged_out`) and released as
  `native_runtime_admission_unavailable`, with no cooldown and no signal: 73 releases on
  2026-09-18/19.
- The worker lane's auth arm (`worker_executor.py:383`) cooled nothing.
- `external_outage_reaper.py` was dead: nothing wrote `api_backoff_exhausted`.
- An auth outage re-wrote a cooldown row and an `::error::` every 900 s
  (`ci_executor.py:5204-5212`). Nothing showed the operator a cooldown.
- `aria_watchdog.py:300` turned every plan an outage stalled into a MEDIUM finding.

Fix:

- New signatures `claude_logged_out`, `codex_logged_out`, `claude_unreachable` and
  `zai_unreachable`, and kinds
  `logged_out` and `unreachable`. `record_provider_cooldown` opens the outage itself, so no seam
  can cool a provider and skip the fact.
- `claude_runtime.extract_unreachable` and `ClaudeProviderUnreachable` cover the 429/529/503
  lines, the API's `rate_limit_error` and `overloaded_error`, and connection errors. They match on
  a nonzero exit only, after auth and credit. A Z.ai transport failure (`zai_unreachable`) raises
  the same fact. The executors cool the provider and release `provider_unreachable:<provider>`
  (harness, new code `PROVIDER_UNREACHABLE`).
- `provider_outage_seams.observe_native_admission` handles the admission seam. `_cool_provider`
  records on both executor lanes. The worker lane's auth and unreachable failures take its
  cooling arm.
- **Once per transition.** One HUMAN_REQUIRED item `provider_unavailable:<provider>:<kind>`
  carries the remedy (renew, re-login, or the key file path). It resolves automatically on
  restore through ARIA-HIGH-360's `write_kernel_disposition` (`resolved_by: kernel`, with the rule
  `provider_restored`; never a panel approval). The
  `::error::` is printed only by the claim that opened the outage. The re-probe back-off doubles
  while the outage stands, up to 3600 s.
- **Dead path deleted, not wired.** The reaper requeued on a 30-minute wall clock and escalated
  after four requeues. Wiring it would have added a timer that kills work in any outage longer
  than two hours. It is deleted together with the `EXTERNAL_OUTAGE` state.
- The watchdog measures provider-available age. The daily report gains a `Provider Outages`
  section with every open or week-old interval.

## ARIA-HIGH-367

Outage-killed work contaminated learning, and closed plans kept their queue.

- **H3.** `agent_eval.py:845,893` exempted failures by name. `pending_tasks_present` caused by an
  outage scored against the drafter. `finding_grounding.py:371` put an outage-killed plan's
  finding on the 7-day cool-off.
- **H4.** `abandon_plan` (`plan_convergence.py:1249`) left the plan's PENDING requests claimable;
  claim selection never checks the plan. Recovered quota went to answers no plan could take.
- **M2.** `agent_invocations.py:2897` returned HUMAN_REQUIRED for any `human_required` row before
  the re-derivation at `:2978` could run. AIR-aria-autonomy-planner-eb17609b38b1 (three
  `claude_cli_exit_1`) and -228f33e15113 (three `prompt_hash_binding_mismatch`) stayed stuck.
- **M1.** `agent_invocations.py:6631` charged every expired lease to the request.

Fix:

- `outage_attribution.failure_is_lane_fault` decides the finding cool-off. A failure is the lane's
  when the stall's fault domain is `harness`, or when a no-answer mode's last wait overlapped an
  outage.
- The drafter side is ARIA-HIGH-370's `failure_attribution` (lane fix/aria-learning-actuator,
  merging first), which rewrites the `agent_eval` attribution this audit cited. It attributes a
  failure only on an allowlist of the work's own evidence. Every outage-kind release (quota, auth,
  `logged_out`, `unreachable`, the outage-eaten lease) is fault domain `harness`, and every
  no-answer reason code is a lane code there, so none is attributed. This change does not touch
  `agent_eval.py`.
- `plan_request_closure.py` closes an ABANDONED plan's unheld requests with a `plan_closed` claim
  event, which derives CANCELLED. It runs from `abandon_plan` and from the pre-mint anchor sweep,
  which covers plans abandoned before this change. Held claims finish under their lease.
- `_escalation_stands` keeps a `human_required` row when any row names a cause that is not the
  harness's, or when the charged count exceeds the ceiling. Only all-harness escalations are
  re-derived, which heals the two requests above. Deliberate escalations (`agent_refused`, branch
  collision) stand.
- A lease that expired inside an outage of its role's provider releases as
  `lease_expired_during_provider_outage:<provider>` (harness, uncharged).

## Alignment with the admission branch (ARIA-HIGH-364)

One detection, one writer: `provider_cooldown.record_provider_cooldown` writes the cooldown row and
opens the outage interval. ARIA-HIGH-364's `provider_outage.provider_outage(role, cooled, now=now)`
reads the cooldown rows, which now include the `logged_out` and `unreachable` kinds, for "may a
request run now". This change adds no second outage-active predicate. Its interval module is
`provider_outage_ledger.py`, a different file from 364's `provider_outage.py`, so the two compose
without a conflict. `provider_clock.provider_available_age` reads the intervals for "how long was
the provider out", which needs restore evidence that a cooldown's `until` does not give.

## Scope notes

- The Codex transport does not name `unreachable`. OpenAI heads no routing ladder, so its outages
  cannot pause a clock. Its logged-out session is detected at admission (`codex_logged_out`).
- The worker dispatch hook keeps releasing a cooled claim as `provider_quota_unavailable:<provider>`
  on the dispatch ledger. That reason is harness-class for every kind, so nothing is charged.

## Review corrections (PR #1835)

- **HIGH-1 (ARIA-HIGH-365).** The head-provider pause did not check that the outage caused the
  stall. With Anthropic out and Z.ai serving rung 2, a plan whose request was answered and then
  escalated (`agent_refused`) kept a near-zero available age and was re-adopted every cycle. The
  `provider_clock` claim that a serving rung resets the clocks was wrong. `outage_causality` now
  gates every pause: an outage pauses a timer only for a request whose last cause is in the
  `harness` fault domain or that never left PENDING/REQUEUED. A request answered and refused is
  held to the wall clock. `resume_candidate_plan_id` and `decide_orphan_reap` (new required
  `awaits_provider`) both apply it.
- **HIGH-2 (ARIA-HIGH-366).** The readers that asked about "any provider" (watchdog, finding
  cool-off, operator-request expiry) now ask about the heads of the planning roles (`covered_any`
  over `planning_heads()`); `None` is gone from the clock API. A provider on no configured routing
  ladder never holds an outage open for a clock (`routed_providers`). The operator resolving an
  outage item writes `provider_restored` with seam `operator_attested`. A kernel re-probe is not
  added: the native admission already re-probes a cooled provider when its back-off ends, and a
  logged-in answer closes a `logged_out` outage.
- **MEDIUM-1 (ARIA-HIGH-366).** `extract_unreachable` reads stderr and the CLI's `is_error` result
  event only, never assistant text.
- **MEDIUM-2 (ARIA-HIGH-366).** The judge batch records `provider_restored` on a served call and
  `zai_unreachable` on a transport failure.
- **MEDIUM-3 (ARIA-HIGH-367).** A lease expiry is waived only when the outage was standing at the
  expiry or covered `LEASE_OUTAGE_MIN_SHARE` (half) of the lease; a short blip is still charged.
- **MEDIUM-4 (ARIA-HIGH-367).** `plan_request_closure` treats `human_required` as unheld, so a
  healed escalation in an ABANDONED plan is closed.
- **LOW.** `ARIA-MIMARI-SEMALARI.md`, ADR-0001 (`docs/recommendations/architectural-arbiter/`)
  and `docs/aria/v10-4-closure-report.md` mark the reaper and the `EXTERNAL_OUTAGE` state as
  deleted by ARIA-HIGH-366.
