"""Plan 025 §E — autonomous worker scheduler daemon.

Pre-fix the kernel had `worker_dispatch.create_dispatch_request` +
`verification_gate.submit_worker_result` + `verify_worker_result` +
`auto_merge.merge_if_green` as composable primitives but no daemon
that bound them into a closed loop. The convergent_planning_bridge
docstring already named the gap that §D solved for planners; §E
solves the worker side of the same loop. Operators had to invoke
each step manually — ARIA was a semi-autonomous kernel, not a
fully-autonomous closed-loop system.

This module supplies the missing loop wrapper. State per iteration:

  1. ARIA_STOP file check (highest priority — clean exit)
  2. Runtime profile gate (frozen/observe → clean exit)
  3. Find + claim + dispatch + verify via worker_dispatch_hook
  4. Sleep poll_interval if no_pending; otherwise next iteration

Single-instance discipline: a fcntl lock on
``aria-tools/daemons/<daemon_id>.pid.lock`` ensures one worker
scheduler daemon per machine. A second daemon attempt sees
``TimeoutError`` and returns clean (``exits_clean=False,
exit_reason="daemon_already_running"``) without raising.

Termination conditions surfaced via ``exit_reason``:
  * ``aria_stop`` — operator wrote ARIA_STOP file
  * ``profile_frozen`` — runtime profile gate raised GovernanceError
  * ``max_iterations`` — operator-supplied iteration cap reached
  * ``daemon_already_running`` — single-instance lock contended

When ``invoke_worker`` is None the daemon falls back to the kernel
default ``worker_dispatch_hook.dispatch_one_pending_worker_assignment``
— matches the §D autonomous_planner_dispatcher pattern. Tests inject
their own callable via ``invoke_worker=`` to drive the loop without
touching the live subprocess.

Profile-gate reuse: the daemon enforces ``agent_claim`` action_kind
(NOT a new action_kind) so the same Plan 020 ACTION_PERMISSIONS
table in ``runtime_profile`` governs the daemon. Frozen
and observe profiles block dispatch automatically with no table
extension required. Worker dispatch is the back-half of the same
agent-claim flow (worker is the entity that claims an assignment
row → mutates worktree → submits result), so a single semantic
gate covers the whole claim→work→submit lifecycle.
"""
from __future__ import annotations

import os
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable


__all__ = [
    "DEFAULT_POLL_INTERVAL_SECONDS",
    "DEFAULT_DAEMON_ID",
    "DEFAULT_MAX_WORKERS",
    "run_worker_scheduler_daemon",
]


DEFAULT_POLL_INTERVAL_SECONDS: float = 30.0
DEFAULT_DAEMON_ID: str = "worker-scheduler"
DEFAULT_MAX_WORKERS: int = 1
DEFAULT_LEASE_SECONDS: int = 1800
_DAEMON_LOCK_TIMEOUT_SECONDS: float = 2.0
_DAEMON_AGENT_KIND: str = "agent_claim"  # piggy-back on existing profile gate


def run_worker_scheduler_daemon(
    *,
    base_dir: str | Path,
    github_adapter: Any,
    workspace_root: str | Path | None = None,
    max_iterations: int | None = None,
    poll_interval_seconds: float = DEFAULT_POLL_INTERVAL_SECONDS,
    daemon_id: str = DEFAULT_DAEMON_ID,
    max_workers: int = DEFAULT_MAX_WORKERS,
    lease_seconds: int = DEFAULT_LEASE_SECONDS,
    invoke_worker: Callable[..., dict[str, Any]] | None = None,
    sleep: Callable[[float], None] = time.sleep,
    aria_stop_filename: str = "ARIA_STOP",
) -> dict[str, Any]:
    """Run the autonomous worker scheduler daemon.

    See module docstring for the state machine + termination
    conditions. ``max_workers > 1`` accepted at the public surface
    for forward compatibility; the per-tick hook owns its own
    concurrency model (sequential by default; the per-assignment
    lock at ``dispatch/locks/<assignment_id>.lock`` already
    prevents two threads from claiming the same row regardless of
    pool size).
    """
    from .file_lock import with_exclusive_lock
    from .runtime_profile import enforce_profile_for_action
    from .tool_registry import (
        GovernanceError,
        append_tools_governance,
        ensure_tools_dir,
    )

    if invoke_worker is None:
        from .worker_dispatch_hook import (
            dispatch_one_pending_worker_assignment,
        )
        invoke_worker = dispatch_one_pending_worker_assignment

    root = ensure_tools_dir(base_dir)
    daemons_dir = root / "daemons"
    daemons_dir.mkdir(parents=True, exist_ok=True)
    daemon_pid_path = daemons_dir / f"{daemon_id}.pid.lock"
    aria_stop_path = root / aria_stop_filename
    daemon_agent_id = f"daemon:{daemon_id}:{os.getpid()}"

    iterations = 0
    assignments_dispatched = 0
    retries_attempted = 0
    merges_completed = 0
    exit_reason = "max_iterations"

    try:
        with with_exclusive_lock(
            daemon_pid_path, timeout_seconds=_DAEMON_LOCK_TIMEOUT_SECONDS
        ):
            append_tools_governance(
                root, "worker_scheduler_daemon_started",
                {
                    "daemon_id": daemon_id,
                    "daemon_agent_id": daemon_agent_id,
                    "poll_interval_seconds": poll_interval_seconds,
                    "max_iterations": max_iterations,
                    "max_workers": max_workers,
                    "started_at": datetime.now(timezone.utc).isoformat()
                    .replace("+00:00", "Z"),
                },
            )

            while True:
                # ARIA_STOP precedes the profile gate so a frozen
                # profile under ARIA_STOP exits with the more
                # specific aria_stop reason (matches cycle.py
                # ordering: STOP overrides every other terminal
                # path).
                if aria_stop_path.exists():
                    exit_reason = "aria_stop"
                    break

                try:
                    enforce_profile_for_action(
                        _DAEMON_AGENT_KIND, base_dir=root,
                    )
                except GovernanceError:
                    exit_reason = "profile_frozen"
                    break

                iterations += 1
                append_tools_governance(
                    root, "worker_scheduler_iteration_started",
                    {"iteration_n": iterations, "daemon_id": daemon_id},
                )

                # Plan ARIA-V3 §A2 — pass the adapter through to the
                # worker hook so dispatch_one_pending_worker_assignment's
                # required github_adapter parameter is satisfied for
                # every iteration. The fake invoke_worker test fixtures
                # use **kwargs and ignore unknown kwargs cleanly.
                result = invoke_worker(
                    base_dir=root,
                    agent_id=daemon_agent_id,
                    lease_seconds=lease_seconds,
                    github_adapter=github_adapter,
                )
                status = result.get("status")

                if status == "no_pending":
                    append_tools_governance(
                        root, "worker_scheduler_iteration_completed",
                        {
                            "iteration_n": iterations,
                            "daemon_id": daemon_id,
                            "status": "idle",
                        },
                    )
                    if (
                        max_iterations is not None
                        and iterations >= max_iterations
                    ):
                        break
                    sleep(poll_interval_seconds)
                    continue

                # Counter rollups.
                if status in {"merged", "verified_pending_merge", "executor_failed", "claim_failed"}:
                    if status == "merged":
                        merges_completed += 1
                    assignments_dispatched += 1
                if status == "retry_scheduled":
                    assignments_dispatched += 1
                    retries_attempted += 1
                if status == "max_retries_exceeded":
                    assignments_dispatched += 1

                append_tools_governance(
                    root, "worker_scheduler_iteration_completed",
                    {
                        "iteration_n": iterations,
                        "daemon_id": daemon_id,
                        "status": status,
                        "assignment_id": result.get("assignment_id"),
                        "claim_id": result.get("claim_id"),
                        "exit_code": result.get("exit_code"),
                        "retry_count": result.get("retry_count"),
                    },
                )

                if (
                    max_iterations is not None
                    and iterations >= max_iterations
                ):
                    break

            append_tools_governance(
                root, "worker_scheduler_daemon_exit",
                {
                    "daemon_id": daemon_id,
                    "iterations": iterations,
                    "assignments_dispatched": assignments_dispatched,
                    "retries_attempted": retries_attempted,
                    "merges_completed": merges_completed,
                    "exit_reason": exit_reason,
                },
            )

            return {
                "iterations": iterations,
                "assignments_dispatched": assignments_dispatched,
                "retries_attempted": retries_attempted,
                "merges_completed": merges_completed,
                "exits_clean": True,
                "exit_reason": exit_reason,
            }
    except TimeoutError:
        append_tools_governance(
            root, "worker_scheduler_daemon_lock_contended",
            {
                "daemon_id": daemon_id,
                "lock_path": str(daemon_pid_path),
            },
        )
        return {
            "iterations": 0,
            "assignments_dispatched": 0,
            "retries_attempted": 0,
            "merges_completed": 0,
            "exits_clean": False,
            "exit_reason": "daemon_already_running",
        }
