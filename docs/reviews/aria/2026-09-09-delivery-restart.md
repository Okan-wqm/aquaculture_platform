# ARIA delivery restart — findings

**Cycle:** 2026-09-09-delivery-restart
**Evidence base:** `aria/state@0f3ea2d2`, `origin/main@bc264753b`, GitHub Actions run history, live runner and systemd state.
**Sequenced remediation plan:** `docs/plans/2026-09-09-aria-delivery-restart/PLAN.md`

ARIA has minted 807 agent requests, converged 0 plans and opened 0 pull requests. `aria-auto-cycle` has not concluded successfully since run #57 on 2026-08-05 — 101 consecutive non-successful runs. Five independent breakages produced that; each finding below is one of them or a consequence measured while tracing them.

Two framing corrections carried through every finding: the absence of round-1 `primary_plan` requests is by design (`cross_review_bridge.py:209` — "round-1 has no primary envelope"), and "0 PRs" describes ARIA's own lane, not the repository, which merged 109 pull requests between 2026-09-03 and 2026-09-09.

---

## ARIA-CRITICAL-046

A budget refusal strands its lease. `_emit_dispatch_summary` is annotated `failure: DispatchFailure | None`; the two cost-reservation callsites passed a bare `str`, so `build_dispatch_result_summary` raised `AttributeError: 'str' object has no attribute 'failure_class'`. The emitter guards only `(OSError, ValueError)`, so the error escaped `invoke_claude_cli`, missed main()'s `ClaudeAuthFailure` / `ClaudeCliUnavailable` arms, and never reached the `_release_claim` that a non-zero `cli_exit` triggers.

Run 33920896040 stranded seven leases this way. Seven of the ten requests claimed after 2026-08-25 carry only the `claimed` event; the other three carry the healthy `anchor_stale+claimed+released+requeued` set. The refusal arm had never executed before, because the cost gate had never refused.

**Fixed** — both callsites build a real `DispatchFailure`; `build_dispatch_result_summary` rejects a wrong-typed `failure` as `ValueError`, which lands the contract violation inside the guard the emitter's docstring already promised.

## ARIA-CRITICAL-047

The gate metered a currency that is never billed. ARIA runs on a managed Claude Code session — `aria-agent-executor.yml:384` refuses to start when an API key is present — and `budget.record_cost_attribution` stamps every row `usd_basis=notional_api_equivalent`, describing the figure as "a comparable, not an invoice … Nothing gates on it". `cost_budget.assert_within_budget` gated on exactly that figure and never read `usd_basis` at all.

Run 33920896040: cap `$0.50` against an estimate of `$0.8416`, `attempted=7 succeeded=0 failed=7 stop=budget_exhausted`. The only two rows in the cost-attribution ledger price real planning work at `$8.27` and `$7.72` — all notional. `claude_runtime._assert_budget_before_spawn` had already survived this exact failure ("the first live drain failed 30/30 at THIS gate … the breaker tripped on configuration, not on spend") and fixed it in its own gate only.

**Fixed** — `usd_basis` splits the two billing channels. The sanctioned z.ai/GLM redirect stays USD-gated and remains the default; the subscription path is not refused on a comparable. `assert_within_subscription_budget` supplies the brake the cap stood in for, promoting `token_economy`'s two runaway conditions from recommendation to enforcement, scoped per agent+role and failing open when the ledgers are absent.

## ARIA-HIGH-048

The `delivery_closure` doctor organ returned `ok / no_implementation_requests` whenever the denominator was empty. Measured against the live store: `ok` while `implementation_requests=0, prs_opened=0, verified_prs=0, slo.met=false`. `self_improvement.scan_signals` turns only `fail` checks into `doctor_fail` signals, so the emptiest possible delivery lane produced no signal at all, and `test_phase_v12_d_delivery.py:294` asserted the false success.

**Fixed** — the organ fails when the SLO is unmet and names the gaps.

## ARIA-MEDIUM-049

`SOURCE_RANK` omitted the `self_improvement` source_kind that `open_self_improvement_missions` stamps, so every such mission fell to `_UNRANKED_SOURCE = 90` and lost every comparison.

**Fixed** — ranked below `service_hardening`, with an invariant test binding the table to `SELF_IMPROVEMENT_SOURCE_KIND`.

## ARIA-MEDIUM-050

The `aria-auto-cycle` checkout set no `fetch-depth`, so the repo twin asked git for 400 commits and received one. The published map carries `history_commits: 1`, `churn_files: 0`, `co_change_pairs: 0` while advertising `history_limit: 400`. Five other ARIA workflows already set `fetch-depth: 0`.

**Fixed.**

## ARIA-CRITICAL-051

`aria-state-maintenance.yml:125` publishes with `git add -A` and a raw `git push` — a second publisher that never runs the kernel gate. Its 2026-09-05 06:47 compaction (`0cd47ed4c`) committed fifteen zero-byte `.lock` sidecars, and every cycle publish since refuses with `state_snapshot_unclaimed_tree_entry:tools/cycles.jsonl.lock`. Last content publish: `00d97a0a9`, 2026-09-04 23:22:57.

**Open.** Two halves, both required: merge PR #1455 (`8731a13d1`, replaces `git add -A` with `aria_kernel state publish`), then remove the fifteen locks from the `aria/state` tip. The fix alone does not clear them, and once maintenance publishes through the gate the existing locks would refuse it too. Do not widen the allowlist — the sidecars are `file_lock` runtime artifacts and belong nowhere near staging.

## ARIA-HIGH-052

One crashing adapter fails the whole cycle. In `cyc-20260906T194118Z-auto` (run 34053876482, step 22) `tenant-scoping-adapter` crashed: `tool_status_counts: {crash: 1, ok: 8}`, `cycle_status_counts: {integrity_failed: 1}`, `quarantine_count: 0`, `overall_status: failed`.

Two distinct defects sit here. The adapter's own crash is one; its health ledger shows 20 × `CALIBRATE` and 1 × `QUARANTINED`, so a crash is not its steady state and this finding's evidence covers that one cycle. The second is structural and worse: `runtime_artifacts.py:941` fails the cycle on `non_ok_tools` alone, without consulting the tool's lifecycle status. `tenant-scoping-adapter.tool.json` declares `"status": "SHADOW"` — an adapter whose output is explicitly not yet trusted — and its crash was nonetheless load-bearing on the cycle verdict.

**Open.**

## ARIA-HIGH-053

A plan reaching `CHALLENGER_DRAFTED` never advances to `cross_review`, and `cross_review` has been minted zero times across all 807 requests. `plan-cyc-20260810T052441Z` reached that state on 2026-08-11T22:55:31 with an `accepted` challenger result and a bridge ledger `transition: ok, attempt 1`, then was abandoned as stalled five days later.

Two paths could have advanced it: `advance_plan_rounds` (`plan_round_controller.py:58`) has no caller outside `cli.py:4439`, and `convergence_drainer.py:1017` carries its own mirror-mint path that did not fire across four nights.

**Open.**

## ARIA-HIGH-054

A `REJECTED` challenger has no forward path. `AIR-aria-challenger-planner-00daad84a5df` returned `rejected` and the plan died `convergence_envelope_dead:challenger_plan`.

Automatic re-mint is correctly forbidden: `REMINT_ELIGIBLE_DEAD_STATES` (`agent_surface.py:206`) covers queue-mechanics deaths only, and states plainly that "ACCEPTED/REJECTED stay out — they are verdicts about the WORK". The missing piece is a round advance, not a re-mint. The sibling starvation case belongs here too: `ACCEPTED_PENDING_BRIDGE` is neither live nor re-mint-eligible and blocks its successor through `planner_request_exists`.

**Open.**

## ARIA-HIGH-055

The memory hook cannot write. `autonomy_orchestrator` passes `signer_key_fp=None` ("V31-D2 will thread the cycle key fp here") and `cycle_phases/memory.py:192` gates the write on a `SHA256:` fingerprint, so no convention row is written even at CONVERGENCE. `conventions.jsonl` has never existed; the empty knowledge graph is an independent closure, not a symptom of zero convergence.

**Open.**

## ARIA-MEDIUM-056

The self-improvement lane has no runtime consumer. `open_self_improvement_missions` is called only from `cli.py:6195` and `gateway/scheduler.py:232`, no workflow runs the gateway, `propose_self_change` has no caller outside the CLI and tests, and `scan_signals` deliberately skips the `verified_prs` SLO gap ("a count shortfall is not a defect to fix in code") that an earlier analysis assumed would fire. `aria-gateway.service` exists on the host and is `disabled` + `inactive` since the operator sweep of 2026-09-08, so the host path is switched off rather than missing.

**Open.**

## ARIA-MEDIUM-057

Minting is decoupled from drain capacity, so a backlog that cannot be drained inside the anchor lifetime dies in bulk: 528 `anchor_stale` events, all `reason: anchor_expired`, 300 of them on 2026-08-17 alone. Both windows are 72h and equal (`STALE_PLAN_MAX_AGE_HOURS`, `DEFAULT_ANCHOR_MAX_AGE_SECONDS`) — the defect is throughput, not a short anchor.

**Open.**

## ARIA-MEDIUM-058

An executor run that claims nothing because nothing is claimable concludes `success`. Run 33339827005 (2026-08-30) reported `claimed_requests: []` and `chain decision: {"dispatch": false, "reason": "drain_empty"}` while 82 requests sat pending; seven such runs occurred between 08-26 and 08-30.

**Open.**

## ARIA-MEDIUM-060

The runner habitat's memory budget outlived its machine. `actions-runner.limits.conf` opens with "WHY these numbers (7.8 GiB droplet …)" and caps the runner at `MemoryHigh=2300M`, `MemoryMax=3G`. The host measures **16.84 GiB** (`MemTotal: 17661208 kB`, 2026-09-09) plus 2 GiB swap on 4 vCPU. The runner therefore held 18% of the box while cycles throttled against `MemoryHigh` with roughly 12 GiB free — and the publish step alone was once caught at ~5.8 GiB resident, which a 3 GiB cap cannot hold at all.

Operator decision 2026-09-09 raised it to `MemoryHigh=6G` / `MemoryMax=8G`; the byte-for-byte drift probe in `provision_runner.sh` moved with it and the host now matches the repo copy exactly. The stale 7.8 GiB figure still appears in the state-maintenance workflow header, the April perf baseline and an orphan-findings narrative.

The class stays open: nothing compares a declared capacity budget against the host it is installed on, so the next resize will be just as invisible.

**Open.**

## ARIA-MEDIUM-059

The `repository_map` context block is rendered even when it carries a single path. Across the 807 published prompts it appears in 564; **247 (44%) carry one bullet** and 408 (72%) carry two or fewer. A representative block is a single `docs/reviews/*.md` path.

**Open.**
