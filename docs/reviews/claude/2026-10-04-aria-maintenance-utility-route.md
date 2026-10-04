# ARIA maintenance_utility route (2026-10-04)

Context: aria-agent-executor runs 37192561282 and 37205463513 (2026-10-04) both ended `failure`.
In each, the drain dispatched `AIR-aria-autonomy-planner-9290f4732576` (role
`maintenance_utility`, target `aria-autonomy-planner`). The child logged
`adaptive_runtime_admission_failed: provider_routing_role_unrouted:maintenance_utility`, the drain
logged `drain_child_without_summary rc=1`, and `harness_failed=1` turned the executor job red. The
quota round (`ci_executor_drain._ROLE_QUOTA_ORDER`) gives the role one slot per run and 105 such
requests are pending, so every run hits it.

Owner: claude (implementation), okan (review). Deadline 2026-10-11.

## ARIA-HIGH-344

Evidence (at `main@bb13c2e8f`):

- `aria-kernel/aria_kernel/agent_surface.py:33` — `maintenance_utility` is a `REQUEST_ROLES`
  member; `:66` — `DISPATCHABLE_ROLES` does not name it; `:149` — `ROLE_TARGET_PAIRING` has no
  entry for it.
- `aria-kernel/aria_kernel/runtime_profiles.py:292` — the routing loader requires the table's roles
  to equal `DISPATCHABLE_ROLES`, so it could neither demand nor accept a route for the role;
  `:262` — `ladder_for` refuses an unrouted role, which is the admission error the runs logged.
- `tools/aria-poc/ci_executor_drain.py:337` — the quota arc names the role (Y4, ORPHAN-705);
  `:749` — the drain spawns `ci_executor.py <request_id>`, which never consults the role set.
- `tools/aria-poc/ci_executor.py:1298` — the `SUPPORTED_ROLES` (= `DISPATCHABLE_ROLES`) check
  guards `claim_and_dispatch_one` (the operator `--consume` loop) only. That is why the request got
  through: the drain path has no role gate, and before ARIA-HIGH-290 (`fa91a1bc9`, 2026-10-03)
  admission had no per-role question either.
- `aria-kernel/tests/test_provider_routing.py:209` — the routing tests pinned
  `provider_routing_role_unrouted:maintenance_utility` as the expected refusal, and `:190` pinned
  a route for the role as an "extra" defect.

Is the role meant to be executor-drained? Yes, on five independent points:

- Two kernel minters address it to the executor lane:
  `aria-kernel/aria_kernel/autonomy_orchestrator.py:421` (the next-cycle queue projection) and
  `aria-kernel/aria_kernel/self_change_bridge.py:49` (`SELF_CHANGE_ROLE`, self-change proposals).
- `.claude/agents/aria-autonomy-planner.md` declares itself the consumer of
  `role=maintenance_utility` envelopes from `autonomy_orchestrator`: "kernel-envelope only;
  read-only; never Agent-tool dispatched". That excludes the Agent tool, not the executor.
- `tools/aria-poc/ci_executor.py` validates a self-change answer before submit (the B6 branch,
  `self_change_contract_violation`), which is code that only runs when the executor serves it.
- The drain arc names the role on purpose (Y4 / ORPHAN-705: it "queued behind 64 judge envelopes"
  and was given a quota slot), and `aria-kernel/tests/test_x1_drain_topology.py` asserts it.
- It ran: `aria/state` holds 24 accepted `maintenance_utility` results, 2026-08-05 to 2026-09-21
  (`docs/aria/reviews/2026-09-25-aria-tam-okuma/B02.md`). The routing table, introduced afterwards,
  was the first surface keyed on `DISPATCHABLE_ROLES` that the drain path reaches.

Rule: a role a request may name, a role the drain arc reaches, and a role the provider routing
table routes are one set. Minting and draining are one contract (E14), and routing covers
everything the drain can dispatch.

Fix (branch `fix/aria-route-maintenance-utility`):

- `agent_surface.DISPATCHABLE_ROLES` gains `maintenance_utility`, and `ROLE_TARGET_PAIRING` pairs it
  with `aria-autonomy-planner`, the one agent both minters address (read-only tools only).
- `runtime_profiles.json` routes it `glm_first`, like the other high-volume read-only roles
  (`change_intelligence`, `goldset_curation`, `verification`): 105 pending, read-only, and a
  self-change answer is a proposal a person adjudicates, not a write.
- The executor's standalone `_DISPATCHABLE_ROLES` mirror names it (pinned by the no-drift test).
- Tier 1: `ci_executor_drain.require_dispatchable_arc` runs at import and refuses an arc that names
  a role outside the executor's `SUPPORTED_ROLES`. With the loader's existing equality check, the
  chain is closed at load time: arc is a subset of dispatchable, and dispatchable equals routed.
- Tier 3: `aria-kernel/tests/test_drain_arc_routing_contract.py` asserts `REQUEST_ROLES` and the
  arc are subsets of `DISPATCHABLE_ROLES`, and that `ladder_for(role, target)` resolves for every
  arc role and each paired target, which is the call that refused. The pinned role-set tests move
  with it: `test_provider_routing` (the extra/unrouted examples use the removed `gap_finding`),
  `test_role_hygiene_e14`, `test_x1_drain_topology` and the V7.3 closed enum (now 16).

Decided against: changing `chain-next-cycle`. The failure did not block the chain. The decide step
runs `if: always()` and asks only `drained > 0`, the open-finding cap and the spacing brake
(`aria_kernel.cycle_rhythm.evaluate_cycle_chain`); `chain-next-cycle` runs `if: always()` on that
verdict. Run 37192561282 printed `{"dispatch": true, "reason": "chain_ready"}` with `DRAINED: 29`,
and `chain-next-cycle` succeeded and dispatched auto-cycle 37205459094. Run 37205463513 printed
`{"dispatch": false, "reason": "min_interval_not_elapsed:1.4h"}` with `DRAINED: 5`: the six-hour
rhythm brake, measured from that auto-cycle's start 1.4 h earlier. The chain already depends on
the plan turn, not on zero harness failures, and the job stays red on a harness failure as it
should. Nothing to change there.

Not done: the 105 pending `maintenance_utility` requests are not touched. Once this lands they
drain through the quota round at one per run plus surplus. Whether that rate is enough for the
backlog is a policy question for `executor.surplus_after_planning_turn` and is not changed here.
