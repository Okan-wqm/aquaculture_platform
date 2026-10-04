# Executor drain: plan progress waits behind the judge backlog (2026-10-04)

Context: the first live end-to-end run. The cycle that ingested operator request
OP-F007-20261004-1 triggered aria-agent-executor run 37192561282 at 09:33Z. Measured on
`main @ 68cea8524`.

Owner: claude (implementation), okan (review). Deadline: 2026-10-11.

## ARIA-HIGH-341 — a finished planning turn keeps draining the backlog

Run 37192561282 drained the plan's only planning-lane request, the F-007 challenger
(`AIR-aria-challenger-planner-0b1f0349123f`, plan `plan-cyc-20261004T073028Z-auto`), which was
accepted at 10:03Z. The run then kept draining old `evidence_judgment` requests from a backlog of
about 1,600 pending rows, at about 6 minutes each. At 11:00Z it was still running. The cap is 30
requests per run (`MAX_REQUESTS_PER_RUN`, `.github/workflows/aria-agent-executor.yml:600`) and the
window is 21,000 s (`ARIA_DRAIN_BUDGET_SECONDS`, `:647`).

The executor, the auto-cycle and the burn-in share one self-hosted runner and the concurrency group
`aria-selfhosted-workspace` (`.github/workflows/aria-agent-executor.yml:73-74`). The plan's next
turn (cycle, then cross_review, then cycle, then CONVERGED, then implementation) waits for the
runner, so it waited hours behind backlog work that advances no plan. Cancelling the run is
unsafe: the challenger's result is published only at the end of the job, and the drain has no
graceful stop.

Root cause: the drain loop (`tools/aria-poc/ci_executor_drain.py`) has no idea of plan progress.
After the quota round (`:659`, one guaranteed slot per waiting role, ORPHAN-705 Y4), the fallback
(`:941`) spends the remaining run cap in arc order (`_ROLE_QUOTA_ORDER`, `:319`). Its only stops
are the queue, the cap (`:891`), the window, the job deadline, the circuit streak and the operator
pause. Nothing ends a run whose plan-advancing work is done, so a run that served a plan's turn
always runs on to the cap or the window. The rhythm brake
(`aria-kernel/aria_kernel/cycle_rhythm.py:76`) already chains the next cycle for any run with
`drained > 0`; it is the drain that never ends.

Severity HIGH: it blocks the first live run. Each plan turn costs a full drain window of backlog
work, so a plan that needs four executor-to-cycle turns needs four windows.

Evidence:

- `tools/aria-poc/ci_executor_drain.py:319` (`_ROLE_QUOTA_ORDER`: the arc, planning core first)
- `tools/aria-poc/ci_executor_drain.py:659` (quota round: one slot per waiting role)
- `tools/aria-poc/ci_executor_drain.py:941` (fallback spends the surplus in arc order, no stop)
- `tools/aria-poc/ci_executor_drain.py:891` (the run cap is the only count-based stop)
- `.github/workflows/aria-agent-executor.yml:73-74` (one concurrency group for cycle and executor)
- `.github/workflows/aria-agent-executor.yml:600` and `:647` (30 requests, 21,000 s window)
- `aria-kernel/aria_kernel/cycle_rhythm.py:76` (the chain declines only an empty drain)

Rule: Once a drain has succeeded on a planning-lane request and none is left pending, it finishes
its quota round and stops by name (`stop=planning_turn_complete`), so the plan's next cycle gets the
runner. The planning lane is derived from the kernel's own constants (`PLANNER_BRIDGE_ROLES` plus
the completeness critic). The quota round still gives every waiting role one slot, so judges are
not starved (ORPHAN-HIGH-786). Any backlog surplus after the turn is a validated policy field,
`executor.surplus_after_planning_turn`, with a default of 0. A run that drains no planning-lane
request is unchanged.
