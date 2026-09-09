# ARIA Delivery Restart — root-cause plan

**Date:** 2026-09-09
**Evidence base:** `aria/state@0f3ea2d2` (live tip), `origin/main@bc264753b`, GitHub Actions run history, live GitHub Actions runner state.
**Method:** every claim below was measured, not inferred. Where a measurement contradicts an earlier written finding, the correction is recorded inline.

---

## 1. What is actually true

ARIA's autonomous delivery lane has produced, over its entire life:

| Measure                               |                          Value | Source                                      |
| ------------------------------------- | -----------------------------: | ------------------------------------------- |
| Agent invocation requests minted      |                            807 | `agent-invocations/requests.jsonl`          |
| Requests that returned a result       |                            188 | `agent-invocations/results.jsonl`           |
| Plans started                         |                             13 | `plans/events.jsonl`                        |
| Plans CONVERGED                       |                          **0** | same                                        |
| Implementation requests               |                          **0** | `delivery_closure.compute_delivery_closure` |
| Pull requests opened by ARIA          |                          **0** | same + `gh pr list`                         |
| Last successful `aria-auto-cycle` run |            **#57, 2026-08-05** | Actions API                                 |
| Non-successful runs since             | **101 consecutive** (#58–#158) | Actions API                                 |

Budget distribution across the 807 requests: `adversarial_judgment` 295, `evidence_judgment` 288, `human_required_adjudication` 159, `maintenance_utility` 49, `challenger_plan` 13, `consensus_arbitration` 3. Roles `primary_plan`, `cross_review`, `implementation` and `verification` were minted **zero** times.

Derived request states (`derive_request_states`, run against the live store): `ANCHOR_STALE` 528, `ACCEPTED` 147, `PENDING` 75, `REJECTED` 28, `ACCEPTED_PENDING_BRIDGE_PERMANENT_FAIL` 12, `HUMAN_REQUIRED` 9, `STALE` 7, `ACCEPTED_PENDING_BRIDGE` 1 — 807 exactly.

**This is not one failure.** Five independent breakages exist, four of which are individually sufficient to stop delivery. They are ordered below by dependency: each phase makes the next one measurable.

### Framing corrections carried into this plan

- **`primary_plan` is not minted in round 1 by design.** `cross_review_bridge.py:209` states it: _"round-1 has no primary envelope (cycle_runner's plan_content IS the primary draft)"_. Earlier analyses called its absence the structural blocker. It is not. The real break is D-07.
- **`0 PR` describes ARIA's lane, not the repository.** 109 pull requests merged between 2026-09-03 and 2026-09-09 (14/6/14/14/17/21/23 per day, accelerating). None came from an `aria/*` head ref. ARIA's autonomous lane is dead; the human + agent remediation around it sped up.
- **The knowledge-graph is not idling for want of input.** Its write side is independently closed (D-10). Convergence alone would not fill it.

---

## 2. Phase 0 — restore observation

Nothing below Phase 0 can be measured until Phase 0 lands.

### ARIA-DELIVERY-01 · The runner is off — deliberately · Tier 4 · owner: operator · due: operator's call

**Answered: this was an operator decision, not an ARIA fault and not automation.**

`/root/.bash_history` lines 600-608 record one host-wide quiesce, in order:

```
600  systemctl is-active docker docker.socket cron aria-gateway sulotrading sulotrading-http
601  touch /etc/cloud/cloud-init.disabled
602  systemctl disable --now droplet-agent
603  systemctl disable cron aria-gateway sulotrading sulotrading-http
606  systemctl disable --now actions.runner.…suderra-droplet-claude.service
608  reboot
```

The runner was collateral in a deliberate "stop every scheduled workload" sweep — cloud-init, droplet-agent, cron, `aria-gateway`, both sulotrading units and the runner, then a reboot. The journal corroborates the timing: `Stopping … 2026-09-08 09:48:04Z`, preceded by two `Runner connect error: Resource temporarily unavailable (pipelinesghubeus6…)` at 08:48 and 09:39.

Ruled out by measurement: `/aria-pause` writes `aria-tools/ARIA_STOP` and never touches systemd, and no `ARIA_STOP` marker exists; no script anywhere in the repository stops or disables the runner.

**Consequence for this plan.** `aria-gateway.service` was disabled in the same command and is still `disabled` + `inactive`. That is the daemon D-12 depends on, so one operator decision covers both.

**Work.** Decide whether the scheduled workloads come back. If yes, restore the runner and `aria-gateway` together — after ARIA-DELIVERY-03, because an 18-hour queue released under the current gate refuses on arrival. If no, ARIA stays off and every finding below is dormant rather than urgent; say so explicitly so the plan is not read as a live incident.

**One inconsistency worth settling either way.** The unit carries `Restart=always` (`80-restart-always.conf`, 2026-08-27) while being `disabled`. A disabled unit does not start at boot, so "always restart" and "disabled" encode opposite intents. Whichever is right, the other should go.

**Acceptance.** Either run #158 leaves `queued`, or the plan records that ARIA is intentionally parked.

### ARIA-DELIVERY-02 · State publication is self-locked · Tier 1 · owner: operator · due: 2026-09-10

**Evidence.** Commit `0cd47ed4c` (2026-09-05 06:47:26, author `aria-state-maintenance`) added **15 zero-byte `.lock` files** to the `aria/state` tree. Its source is `aria-state-maintenance.yml:125` — `git add -A` followed by a raw `git push`, a second publisher that never runs the kernel's publish gate. Since that commit, every cycle publish is refused:

```
state_publish_commit_snapshot_mismatch: ... (state_snapshot_unclaimed_tree_entry:tools/cycles.jsonl.lock)
```

`autonomy_evidence.py:2366` allows only `{GENESIS, snapshot.json, *claimed_paths, *present_markers}`; `state_manifest.py` declares exactly one lock surface (`locks/autonomous-host.lock`) and none of the 15. The last content-bearing publish was `00d97a0a9`, 2026-09-04 23:22:57.

**Work — both halves are required.**

1. Review and merge `fix/aria-state-integrity-20260906` (`8731a13d1`, PR #1455). It replaces `git add -A` + `git push` with `aria_kernel state publish`, routing the maintenance lane through the same gate as every other publisher. This stops new contamination.
2. Land a one-time commit removing the 15 `.lock` files from the `aria/state` tip. PR #1455 alone does not clear them — and once maintenance publishes through the gate, the existing locks would refuse _it_ too.

Do not widen the allowlist. The lock sidecars are runtime artifacts of `file_lock`; the correct outcome is that they never reach staging.

**Acceptance.** `state publish` against an isolated store returns `published: true`; the next nightly's step 27 is green.

**Rollback.** Publication is already fail-closed; a regression stops publishing rather than corrupting state.

---

## 3. Phase 1 — make the queue flow

619 of 807 requests never returned. Three mechanisms, in the order they bite.

### ARIA-DELIVERY-03 · The gate meters a currency that is never billed · Tier 1 · owner: kernel lane · due: 2026-09-12

**This is not a cap-tuning problem. The queue was stopped by the wrong meter.**

ARIA runs on a managed Claude Code subscription. `aria-agent-executor.yml:384-386` _refuses to start_ if `ANTHROPIC_API_KEY`, `CLAUDE_API_KEY` or `ANTHROPIC_AUTH_TOKEN` is present — "API-key Claude mode is disallowed for ARIA; use a managed Claude Code login on the trusted runner" — and the runner's credential is `CLAUDE_CODE_OAUTH_TOKEN`. There is no marginal per-token charge on this path.

The codebase already knows this and says so twice:

- `budget.py:417` — _"Time, not dollars, is what binds under a Claude Code subscription: there is no marginal per-run charge, so the scarce things a runaway loop consumes are the shared usage quota and CI minutes, and both are spent in seconds."_
- `budget.py:725` stamps every cost row `usd_basis: notional_api_equivalent`, with the comment _"this figure prices the call at API list rates. It is a comparable, not an invoice. … **Nothing gates on it.**"_

**And yet `cost_budget.assert_within_budget` gates on exactly that figure.** `cost_budget.py` never references `usd_basis` at all. Two modules in one package hold contradictory positions on whether the number is authoritative, and the one that gates is the one whose own ledger says it should not.

Measured consequence: `per_run` `$0.50`, pre-flight estimate `$0.8416`, actual attributed cost of real planning work `$8.27` and `$7.72` — every figure notional. Run #190: `attempted=7 succeeded=0 failed=7 stop=budget_exhausted`. The delivery lane was stopped by an imaginary invoice.

**One genuine exception.** `90-glm-policy.conf` (operator decision, 2026-08-29) sanctions cross-provider failover, and the runner's EnvironmentFile carries `ARIA_ZAI_API_KEY`. That path _is_ API-billed, so USD there is an invoice, not a comparable.

**Work — split the meter by billing channel.**

1. **Subscription path (default):** gate on what actually binds — tokens per accepted result, wall-clock, and attempt/loop count. All three already exist and are merely advisory: `token_economy.py` computes `tokens_per_accepted` against `DEFAULT_TOKENS_PER_ACCEPTED_THRESHOLD = 400_000` but only _recommends_ an effort downgrade, and `budget.record_run_wall_clock` records seconds that nothing enforces. Promote them from recommendation to gate. This is also the loop protection the USD cap was standing in for: "no accepted result in N spawns" is already a computed condition in `recommend_efforts`.
2. **API path (z.ai / GLM failover):** keep the USD gate. Real money, real cap.
3. **Make the distinction structural.** The gate must read `usd_basis` (or the resolved provider) instead of applying one meter to both channels, so a notional figure can never again refuse work. Cap coherence (`monthly >= daily >= per_run > 0`) belongs on the API branch, refused at policy load rather than discovered per dispatch.
4. **Fix attribution coverage.** 807 requests and 188 results produced **two** cost-attribution rows. Whatever meter becomes authoritative is worthless at that sampling rate — record a row per dispatch.

**Acceptance.** A subscription-path dispatch is never refused for notional USD. A runaway loop is stopped by the token / wall-clock / attempt budget and names which one bound. A GLM dispatch is still refused when the real USD cap binds. Every dispatched request carries an attribution row.

### ARIA-DELIVERY-04 · A budget refusal leaked its lease · Tier 1 · owner: kernel lane · **status: fixed in this branch**

**Evidence.** Ten requests were claimed after 2026-08-25. Seven carry `claimed` and nothing else — no `released`, no `requeued`, no result. The remaining three carry the healthy `anchor_stale+claimed+released+requeued` set. Run #190's log shows why, seven times:

```
GovernanceError: cost_budget_per_run_cap_exceeded: estimate=0.8416 cap=0.5
During handling of the above exception, another exception occurred:
  ci_executor.py:1472  _emit_dispatch_summary(
  dispatch_failure.py:300  "failure_class": failure.failure_class ...
AttributeError: 'str' object has no attribute 'failure_class'
```

`_emit_dispatch_summary` is annotated `failure: DispatchFailure | None`. Exactly two call sites — both in the cost-reservation path — passed a bare `str`. The emitter's guard catches `(OSError, ValueError)`, so an `AttributeError` escaped `invoke_claude_cli`, missed main()'s `ClaudeAuthFailure` / `ClaudeCliUnavailable` arms, and never reached the `_release_claim` that a non-zero `cli_exit` triggers. The lease then sat in `CLAIMED` until expiry.

The refusal path had never executed before: the cost gate had never refused, so the type error had never run.

**The claim ordering is not the defect.** `main()` does release on `cli_exit != 0`; the release was skipped because the error handler crashed before returning.

**Fix applied.**

- Both call sites now build a real `DispatchFailure(failure_class="policy_violation", retryable=False, phase="preflight")` and keep the human message on stderr.
- `build_dispatch_result_summary` rejects a non-`DispatchFailure` with `ValueError`, which the emitter's existing guard catches — so a contract violation is named on stderr instead of killing a dispatch. The docstring already promised this invariant; it now holds.
- Regression test: `test_untyped_failure_is_a_named_valueerror_not_an_attributeerror`.

### ARIA-DELIVERY-05 · Anchors expire faster than the queue drains · Tier 2 · owner: kernel lane · due: 2026-09-15

**Evidence.** 528 `anchor_stale` claim events, every one `reason: anchor_expired`, across 528 distinct requests: 3 on 08-09, 1 on 08-13, **300 on 08-17**, 118 on 08-20, 9 on 08-21, 6 on 08-22, 71 on 08-25, 20 on 08-26.

**Correction to an earlier reading.** The two windows are **equal**, not mismatched: `STALE_PLAN_MAX_AGE_HOURS = 72` and `DEFAULT_ANCHOR_MAX_AGE_SECONDS = 3 * 24 * 3600`. The defect is not a short anchor; it is that minting is decoupled from drain capacity, so a backlog that cannot be drained inside 72 hours dies in bulk and the system reads the bulk death as housekeeping.

**Work.** Apply back-pressure at the mint boundary: refuse to mint planner/judgment work that cannot be drained within the anchor lifetime at the observed drain rate. `human_required_adjudication` is exempt — an operator-facing item must not be suppressed by throughput.

**Acceptance.** Under an artificially slow drain, `anchor_expired` stays at 0 and the queue stops growing.

### ARIA-DELIVERY-06 · An empty drain reports success · Tier 3 · owner: kernel lane · due: 2026-09-12

**Evidence.** Executor run #166 (2026-08-30) concluded `success` with:

```
"claimed_requests": []
DRAINED:
chain decision: {"dispatch": false, "reason": "drain_empty"}
```

while 82 requests sat pending. Seven such "successful" runs occurred between 08-26 and 08-30, all doing nothing.

**Work.** Distinguish _empty because the queue is empty_ (green) from _empty because nothing is claimable_ (red, with the reason named: `all_anchors_stale`, `budget_exhausted`, `lease_held_elsewhere`). This is the same false-success class as D-11.

**Acceptance.** A run against a stale-only backlog ends red and names its cause.

---

## 4. Phase 2 — close the convergence gate

### ARIA-DELIVERY-07 · `CHALLENGER_DRAFTED` never advanced to `cross_review` · Tier 1 · owner: kernel lane · due: 2026-09-15

**Evidence.** Exactly one plan reached `CHALLENGER_DRAFTED` — `plan-cyc-20260810T052441Z`, event recorded 2026-08-11T22:55:31. Its challenger result was `accepted`, and the bridge ledger records `transition: ok, attempt 1` at the same second. The plan was then abandoned on 2026-08-16 as _stalled_. Across all 807 requests, `cross_review` was minted **zero** times.

Two paths could have advanced it and neither did:

- `advance_plan_rounds` (`plan_round_controller.py:58`) handles `CHALLENGER_DRAFTED` → `_ensure_cross_review_round`, but has **no caller outside `cli.py:4439`**.
- `convergence_drainer.py:1017` carries its own `CHALLENGER_DRAFTED` → `_ensure_envelope(_STEP_ROLE_CROSS_REVIEW, ...)` mirror path, and did not fire across four nights.

**Work.** Determine why the drainer's mirror path did not trigger with a successful bridge and a live plan state, and fix at that seam. A state machine with a reachable state and no reachable exit is the defect, regardless of which of the two paths is meant to own it.

**Acceptance.** A plan moves from `CHALLENGER_DRAFTED` to `CROSS_REVIEW_REQUESTED` without operator intervention.

### ARIA-DELIVERY-08 · A rejected challenger has no forward path · Tier 2 · owner: kernel lane · due: 2026-09-16

**Evidence.** The single plan that reached a terminal verdict died `convergence_envelope_dead:challenger_plan`. Its challenger request `AIR-aria-challenger-planner-00daad84a5df` (minted 2026-08-16T20:11:30) returned **`rejected`** — the plan died of a verdict, not of age.

**Design constraint — an earlier draft of this plan violated it.** Automatic re-mint of a rejected challenger is forbidden by `agent_surface.py:206`:

> `ACCEPTED/REJECTED stay out — they are verdicts about the WORK and their consumers handle them through result folds, never re-mints.`

`REMINT_ELIGIBLE_DEAD_STATES` is `{HUMAN_REQUIRED, ANCHOR_STALE, STALE, CANCELLED, EXPIRED}` — queue-mechanics deaths only.

**Work.** A `REJECTED` challenger must **advance the round** (round-2 primary answers the critique) or open a fresh plan; when the round budget is exhausted, write an honest `HUMAN_REQUIRED`. Include the sibling starvation case: `ACCEPTED_PENDING_BRIDGE` (1 request today) is neither live nor re-mint-eligible, and blocks its successor through the `planner_request_exists` idempotency check.

**Acceptance.** A rejected challenger produces a next round or a named terminal state — never silence.

### ARIA-DELIVERY-09 · A crashing adapter fails the whole cycle · Tier 1 · owner: kernel lane · due: 2026-09-12

**Evidence (scoped to one run).** Run #151, step 22 (`Run the nightly cycle under the resolved profile`, `failure`):

```
"non_ok_tools": [{"tool_id": "tenant-scoping-adapter", "status": "crash",
                  "cycle_id": "cyc-20260906T194118Z-auto", "artifact_status": "present"}]
"cycle_status_counts": {"integrity_failed": 1}
"tool_status_counts": {"crash": 1, "ok": 8}
"overall_status": "failed"
```

**Scope honesty.** This is proven for `cyc-20260906T194118Z-auto`. It is _not_ established as the cause of all 101 failed runs. The adapter's health ledger shows 20 × `CALIBRATE` and 1 × `QUARANTINED`, so a crash is not its steady state.

**Work.** Fix the adapter crash. Separately, decide whether one crashing tool out of nine should fail the cycle: quarantine-and-continue is a deliberate relaxation of the integrity invariant in `cycle.py`, so it must be recorded as a policy decision with the quarantine visible — not slipped in as a robustness tweak.

---

## 5. Phase 3 — let learning write (runs in parallel with Phase 2)

### ARIA-DELIVERY-10 · The memory hook cannot write · Tier 1 · owner: kernel lane · due: 2026-09-17

**Evidence.** `autonomy_orchestrator.py` passes `signer_key_fp=None,  # V31-D2 will thread the cycle key fp here`. `cycle_phases/memory.py:192` gates the write on `if pattern_signature and signer_key_fp and signer_key_fp.startswith("SHA256:")`.

Therefore **no convention row is written even at CONVERGENCE**. The empty `tools/knowledge-graph/conventions.jsonl` is not a symptom of the missing convergence — it is an independent closure. The full chain otherwise exists: record at 0.5/`hypothesis` (`memory.py:44`) → serve above 0.7 (`knowledge_graph.py:55`) → promote to 0.75/`verified` on merge (`implementation_reconciler.py:98` → `knowledge_graph.py:566`).

**Work.** Thread the cycle's ephemeral key fingerprint (V31-D2), reconciling with the `needs_signing` disclosure already sitting on `fix/aria-memory-hook-20260906`.

**Acceptance.** A synthetic CONVERGED plan writes a 0.5/`hypothesis` row; a simulated merge promotes it to 0.75/`verified` and `lookup_pattern` serves it.

---

## 6. Phase 4 — make self-observation honest

### ARIA-DELIVERY-11 · The doctor greened an empty funnel · Tier 3 · owner: kernel lane · **status: fixed in this branch**

**Evidence.** `doctor.py:246` returned `ok / no_implementation_requests` whenever the denominator was empty. Measured against the live store: `delivery_closure = ok` while `implementation_requests=0, prs_opened=0, verified_prs=0, slo.met=false`. `test_phase_v12_d_delivery.py:294` asserted that behaviour, pinning the false success in place.

The consequence reaches further than the report: `self_improvement.scan_signals` converts **only** `fail` checks into `doctor_fail` signals, so the emptiest possible delivery lane generated no signal at all.

**Fix applied.** The organ now fails when `slo.met` is false and names the gaps (`delivery_slo_unmet:verified_prs<3`). The test asserts the new contract. `run_doctor` gates no workflow, so no CI path changes behaviour.

### ARIA-DELIVERY-12 · Self-improvement is disconnected in four places · Tier 2 · owner: kernel lane · due: 2026-09-18

1. **The lane is switched off, not unwired.** `open_self_improvement_missions` is called only from `cli.py:6195` and `gateway/scheduler.py:232`, and no `aria-*.yml` workflow runs the gateway — verified across all 102 remote branches. The host path does exist: `aria-gateway.service` is installed, and it is `disabled` + `inactive` because it was disabled in the same 2026-09-08 sweep as the runner (D-01). So this is one operator decision away from running, not a missing integration. Re-enabling it is necessary and not sufficient — items 2-4 below still gate the chain.
2. **Unranked source.** `SOURCE_RANK` lacked `self_improvement`, so every such mission fell to `_UNRANKED_SOURCE = 90` and lost every comparison. **Fixed in this branch** (ranked 5, below `service_hardening`), with an invariant test binding `SELF_IMPROVEMENT_SOURCE_KIND` to the table.
3. **The expected signal is suppressed by design.** `self_improvement.py:110-112` skips `verified_prs` gaps: _"a count shortfall is not a defect to fix in code"_. An earlier plan assumed `delivery_slo_gap` would fire once the gateway was wired; it will not. `doctor_fail` will — which is what D-11 unblocks.
4. **No consumer.** `propose_self_change` has no caller outside the CLI and tests, and nothing consumes the `next_action="propose_self_change"` that missions carry.

All four must land together; any one left open leaves the chain dry.

---

## 7. Phase 5 — context quality

### ARIA-DELIVERY-13 · The repo twin's history layer is dead · Tier 2 · owner: infra · **status: fixed in this branch**

**Evidence.** `aria-auto-cycle.yml:166` checked out without `fetch-depth`, giving depth 1. `twin/map.json` therefore reports `history_commits: 1`, `churn_files: 0`, `co_change_pairs: 0` while advertising `history_limit: 400`. Five other ARIA workflows already set `fetch-depth: 0`; the one lane that _builds_ the map did not.

**Fix applied.** `fetch-depth: 0` on the auto-cycle checkout. The map itself is separately 626 commits stale because cycles stopped on 09-04; that resolves with Phase 0.

### ARIA-DELIVERY-14 · `repository_map` is mostly empty · Tier 3 · owner: kernel lane · due: 2026-09-19

**Evidence.** Of 564 rendered `repository_map` blocks, **247 (44%) contain a single bullet** and 408 (72%) contain two or fewer; the largest has 26. A representative block is one `docs/reviews/*.md` path. The 70% presence figure overstates usefulness badly.

**Work.** Below a usefulness threshold, either fill the block or omit it. Handing an agent a one-line "map" manufactures the impression of context that was not supplied.

---

## 8. Phase 6 — clear the wreckage and close the books

### ARIA-DELIVERY-15 · Backlog disposition · owner: operator · due: 2026-09-16

528 requests are dead in `ANCHOR_STALE` and 61 `HUMAN_REQUIRED` items are open, most of them generated by ARIA's own dead requests (_"request '…' died ANCHOR_STALE unclaimed; panel disposition required"_). Once Phase 1 lands, sweep them explicitly — `re_mint` for the queue-mechanics deaths (which `REMINT_ELIGIBLE_DEAD_STATES` permits), `drop_with_reason` for the rest. Restarting the lane on top of an un-swept backlog re-runs the 08-17 bulk expiry.

### ARIA-DELIVERY-16 · Registry and branch reconciliation · owner: kernel lane · due: 2026-09-16

- Record ARIA-DELIVERY-01…16 in `docs/reviews/_registry/findings.jsonl` under the existing closure regime, so no item here lives outside the tracked state machine.
- Reconcile the two pending branches this plan depends on: `fix/aria-state-integrity-20260906` (D-02) and `fix/aria-memory-hook-20260906` (D-10). Also `fix/ci-delivery-dependencies-20260909`, which becomes live the moment the runner returns.

---

## 9. Dependency order

```
01 runner ─┬─► 03 cost policy ─► 04 lease [done] ─► 05 anchor ─► 06 drain honesty
           │                              │
02 publish ┘                              ▼
                              07 cross_review ─► 08 rejected-challenger ─► first CONVERGED
                                                                              │
                              10 memory signer ───────────────────────────────┴─► first convention

09 adapter        (parallel; also blocks Phase 1)
11 [done] / 12    (parallel)
13 [done] / 14    (parallel)
15 / 16           (after Phase 1)
```

**Shortest path to one green end-to-end cycle: 01 → 02 → 03 → 04 → 09.** Without those five, no cycle can finish. 01 is an operator decision rather than an engineering task; 04 has landed; 02 has a written fix awaiting merge. The remaining engineering on the critical path is 03 and 09.

## 10. What is not yet known

- Why the drainer's `CHALLENGER_DRAFTED` mirror path did not fire (D-07) — the seam is located, the cause is not.
- Whether the `tenant-scoping-adapter` crash recurs outside `cyc-20260906T194118Z-auto` (D-09).
- ~~Whether the runner stop was deliberate (D-01).~~ **Answered: deliberate, operator-initiated, host-wide.**
