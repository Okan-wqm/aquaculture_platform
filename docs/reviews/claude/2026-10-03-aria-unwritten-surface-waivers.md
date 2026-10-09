# ARIA surface reachability — seven unwritten members waived under ids no store holds (2026-10-03)

Context: `aria-kernel/surface-reachability.unwritten.json` waives seven vocabulary members nothing
writes. Every waiver expires on 2026-10-16, and every finding id they cite (`ORPHAN-MEDIUM-688`,
`ORPHAN-HIGH-689`, `ORPHAN-MEDIUM-690`, `ORPHAN-MEDIUM-691`, `ANALYSIS-LOW-692`) is held by neither
`docs/reviews/orphan-findings.md` nor `docs/reviews/_registry/findings.jsonl`: those sequence
numbers belong to unrelated findings (`ORPHAN-HIGH-688` is the E9 gate itself). The waivers were
renewed on 2026-09-16 "pending ORPHAN tracking rows" and the rows were never written, so on
2026-10-17 (UTC; a waiver is honoured through its own day) the expiry test turns every kernel lane
red with no record anyone could work. `gap_finding`, the eighth member under the same phantom
id, is ORPHAN-MEDIUM-835 (`2026-10-03-aria-gap-finding-role.md`).

Each member is decided on evidence, by the 2026-09 surface audit's rule: either the kernel
schedules its writer or the member is deleted. No date is moved. Read on
`fix/aria-remove-gap-finding-role @ 7f5e430b7`; persisted history read on
`origin/aria/state @ f82569371` (every `*.jsonl`/`*.json` row walked for an exact-value field,
plus its compressed archives) and on the runner's live store.

Owner: claude (implementation), okan (review).

| Member                                             | Finding           | Decision                                                   |
| -------------------------------------------------- | ----------------- | ---------------------------------------------------------- |
| `agent_surface_request_role.gap_closure`           | ORPHAN-MEDIUM-836 | delete                                                     |
| `genesis_lifecycle_forward_transition.EVAL_WINDOW` | ORPHAN-HIGH-837   | keep; waiver re-pinned to this finding, expires 2026-11-20 |
| `genesis_lifecycle_forward_transition.ACTIVE`      | ORPHAN-HIGH-837   | keep; waiver re-pinned to this finding, expires 2026-11-20 |
| `plan_convergence_event_type.lock_reaped`          | ORPHAN-MEDIUM-838 | delete                                                     |
| `tool_registry_status.ARCHIVED`                    | ORPHAN-MEDIUM-839 | delete                                                     |
| `tool_registry_status.DRAFT`                       | ORPHAN-MEDIUM-839 | delete                                                     |
| `tool_registry_status.SANDBOX`                     | ORPHAN-MEDIUM-839 | delete                                                     |

## ORPHAN-MEDIUM-836

`gap_closure` is a member of `agent_surface.REQUEST_ROLES` that no kernel path mints. It carries a
0.45 executor cap beside `implementation`, which is minted (`cross_review_bridge.py`); the pair was
designed for two executors and only one was wired. The acceptance-lane gap closer
(`aria-acceptance-gap-fixer`) is an operator-driven dispatch outside the kernel.

Evidence:

- `aria-kernel/aria_kernel/agent_surface.py:30` (`gap_closure` in `REQUEST_ROLES`)
- `aria-kernel/aria_kernel/context_budget_gate.py:92` (its 0.45 cap)
- `aria-kernel/surface-reachability.unwritten.json:3` (the waiver: expires 2026-10-16,
  `finding_id` `ORPHAN-MEDIUM-688`)
- `aria-kernel/tests/test_surface_reachability.py:210` (the CLI-passthrough canary is
  `gap_closure`, the last unwritten role on the surface)

Schedule: none. Program plan rev3.1 "Şimdi" row 5 names `gap_finding` only; no open finding names a
minter. One-way door: no ledger row names role `gap_closure` (one textual hit, an agent transcript
quoting `agent_surface.py`).

Decision: delete. With it the request surface has no unwritten role left, so the CLI-passthrough
precision pin can no longer lean on a dormant canary; it now asserts that no written-role evidence
cites the CLI's `role=args.role` callsites.

Rule: every role on the request surface has a production minter, or it is removed.

## ORPHAN-HIGH-837

The genesis ladder ends `SHADOW → EVAL_WINDOW → ACTIVE`. `validate_transition` guards `ACTIVE`
hardest of all (two reviewers or validators plus a kernel-computed Bradley-Terry superiority proof),
and `ALLOWED_TRANSITIONS` admits `ACTIVE` only from `EVAL_WINDOW`. The only production recorder,
the C4-d shadow-eval bridge, records `REAL_SANDBOX` and `SHADOW` and stops; nothing records either
of the last two rungs.

Evidence:

- `aria-kernel/aria_kernel/genesis_lifecycle.py:47` (`SHADOW` admits only `EVAL_WINDOW`;
  `EVAL_WINDOW` admits only `ACTIVE`)
- `aria-kernel/aria_kernel/genesis_lifecycle.py:354` (`record_transition` computes the superiority
  proof for `ACTIVE`)
- `aria-kernel/aria_kernel/shadow_eval_bridge.py:308` (the bridge records `REAL_SANDBOX` and
  `SHADOW`)
- `aria-kernel/aria_kernel/genesis_superiority.py:61` (`compute_eval_window_superiority`, read only
  by the `ACTIVE` rung)
- `aria-kernel/surface-reachability.unwritten.json:11` (both waivers: expire 2026-10-16,
  `finding_id` `ORPHAN-HIGH-689`)
- `docs/reviews/claude/2026-09-14-aria-post-chain-plan.md:29` (row 11 schedules genesis
  `EVAL_WINDOW → ACTIVE`)

Why it is kept: the writer is scheduled. The post-chain plan's row 11 ("measured promotion", RSI
rungs 2–3) sequences it after ARIA-HIGH-125 (nightly fitness; OPEN, its notes name genesis
`EVAL_WINDOW` as a reader of what it produces) and ARIA-HIGH-122 (the adaptation loop; OPEN). That
row and ARIA-HIGH-125's title cite the phantom `ORPHAN-HIGH-689`; this finding is the record they
meant. Program plan rev2 K-11 reuses `genesis_superiority` (Bradley-Terry) and `agent_eval` real
mode in ARIA's own authoring loop. Deleting the two rungs would orphan `genesis_superiority` and the
`superiority_policy` knobs (`genesis_policy.py:758`), the measured-promotion design the plans build
on. No genesis-lifecycle ledger exists in persisted history, so nothing recorded reads either state.

Deadline: 2026-11-20, the rev3.1 calendar's Faz 1 target, the phase that carries K-11. The kernel
freeze (K-3′) admits no new capability before the chain closes, so the writer cannot land earlier.
Both waivers now cite this finding and expire on that day: by then the rungs have a writer, or the
program deletes them together with what only they read.

Rule: a lifecycle rung the kernel guards is reachable by a production path, or its writer is
scheduled under a dated finding a store holds.

## ORPHAN-MEDIUM-838

`lock_reaped` is a member of `plan_convergence.EVENT_TYPES` with a payload validator
(`stale_lock_pid`, `lock_age_seconds`, `reaped_by_pid`) and no emitter. `_reap_stale_lock` unlinks a
stale `plans/events.lock` and writes nothing. `EVENT_TYPES` is documented as a one-way door because
every row is content-hashed, so the member is a permanent entry describing an event the reducer
never folds.

Evidence:

- `aria-kernel/aria_kernel/plan_convergence.py:41` (`lock_reaped` in `EVENT_TYPES`)
- `aria-kernel/aria_kernel/plan_convergence.py:2653` (its validator arm)
- `aria-kernel/aria_kernel/plan_convergence.py:1709` (`_reap_stale_lock` records nothing)
- `aria-kernel/aria_kernel/tool_registry.py:758` (the tools-root lock reaper records `lock_reaped`
  in the governance ledger)
- `aria-kernel/surface-reachability.unwritten.json:25` (the waiver: expires 2026-10-16,
  `finding_id` `ORPHAN-MEDIUM-690`)

A lock reap is not a plan event: `plans/events.jsonl` rows belong to one `plan_id`, and the
reducer has no arm for this kind. The sibling reapers (`tool_registry.py:758`, `migration.py:756`)
record a reap in the governance ledger, whose `lock_reaped` kind is a different vocabulary and
stays. Schedule: none. One-way door: no row of `tools/plans/events.jsonl`, of any other ledger, of
the compressed archives or of the live store has `event_type` `lock_reaped`, so retiring it before
the door closes on a row invalidates nothing.

Decision: delete.

Rule: a member of a content-hashed one-way-door vocabulary has a production emitter, or it is
retired before any row uses it.

## ORPHAN-MEDIUM-839

`tool_registry.TOOL_STATUSES` declares `DRAFT`, `SANDBOX` and `ARCHIVED`. No production path
produces any of them.

- `DRAFT` and `SANDBOX` could only arrive through `register_tool`'s manifest dict, which the walk
  cannot resolve, so the waiver recorded a limit of the walk rather than a dormancy claim. The
  callsites settle it: `adapter_portfolio.py:94` registers at the literal `SHADOW`; the manifest
  sync (`cycle.py:2771-2781`) registers each `tools/aria-adapters/*.tool.json` at its own status
  or at the live one, and all 11 manifests on main say `SHADOW`; `aria-kernel tool register`
  forwards operator JSON, the passthrough this gate never lets vouch. The sandbox stage the SPEC's
  birth pipeline names is a phase of the authoring loop before materialisation
  (`convergent_skill_authoring.py:473`), and program plan rev2 K-11 has detectors born `SHADOW`.
- `ARCHIVED` is read only as filters (`tool_health.py:269`, `_FORBIDDEN_ACTIVE_SOURCES`,
  `_QUARANTINE_EXITS_WITHOUT_APPROVAL`, `DEGRADATION_STANDING_STATUSES`) and as advice: the
  quarantine escalation (`tool_degradation.py:214`) tells the operator to archive a tool, and no
  kernel command archives one. Removing the status makes the escalation name only the exit the
  kernel has, `unquarantine_tool`.

Evidence:

- `aria-kernel/aria_kernel/tool_registry.py:31` (`TOOL_STATUSES`)
- `aria-kernel/aria_kernel/tool_registry.py:46` (`INITIAL_LIFECYCLE_STATES` admits `DRAFT` and
  `SANDBOX`)
- `aria-kernel/aria_kernel/adapter_portfolio.py:94` (portfolio registration at `SHADOW`)
- `aria-kernel/aria_kernel/cycle.py:2781` (manifest sync registration)
- `aria-kernel/aria_kernel/tool_degradation.py:214` (the escalation's archive advice)
- `aria-kernel/surface-reachability.unwritten.json:33` (the three waivers: expire 2026-10-16,
  `finding_id` `ORPHAN-MEDIUM-691` and `ANALYSIS-LOW-692`)

Schedule: none in the program plan (rev2, rev3.1) or any open finding. One-way door:
`origin/aria/state @ f82569371` `tools/registry.json` holds 7 `CALIBRATE`, 3 `SHADOW`,
1 `QUARANTINED`; its 11 `tool_registered_initial` governance rows are all `SHADOW`; no row anywhere
carries `DRAFT`, `SANDBOX` or `ARCHIVED` as a tool status, and the live registry matches.

Decision: delete all three. A tool is registered at `SHADOW`; the statuses left are `SHADOW`,
`ACTIVE`, `CALIBRATE` and `QUARANTINED`. A quarantined tool's one exit is release
(`unquarantine_tool`); a retirement status comes back together with the command that writes it.

Rule: every lifecycle status a tool can hold is produced by a production path, or it is removed;
an escalation names only exits the kernel can take.
