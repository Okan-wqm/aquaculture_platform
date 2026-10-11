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
