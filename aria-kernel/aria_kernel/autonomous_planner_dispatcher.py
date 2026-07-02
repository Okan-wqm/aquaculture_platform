"""Plan 025 §D — autonomous planner dispatcher daemon.

The pre-fix kernel had every planner-request primitive
(``next_pending_request`` / ``claim_request`` / ``submit_claim_result``)
but no daemon that bound them into a closed loop. The convergent
planning bridge docstring even named the gap: "external orchestrator
(Claude Code session) to claim". Operators had to invoke
each step manually — ARIA was a semi-autonomous kernel with
composable primitives, not a fully-autonomous closed-loop system.

This module supplies the missing loop wrapper. State per iteration:

  1. ARIA_STOP file check (highest priority — clean exit)
  2. Runtime profile gate (frozen/observe → clean exit)
  3. Find + claim + dispatch via planner_dispatch_hook
  4. Sleep poll_interval if no pending; otherwise next iteration

Single-instance discipline: a fcntl lock on
``aria-tools/daemons/<daemon_id>.pid.lock`` ensures one daemon per
machine. A second daemon attempt sees ``TimeoutError`` and returns
clean (``exits_clean=False, exit_reason="daemon_already_running"``)
without raising.

Termination conditions surfaced via ``exit_reason``:
  * ``aria_stop`` — operator wrote ARIA_STOP file
  * ``profile_frozen`` — runtime profile gate raised GovernanceError
  * ``max_iterations`` — operator-supplied iteration cap reached
  * ``daemon_already_running`` — single-instance lock contended

The default ``invoke_planner`` is the planner_dispatch_hook;
operators can inject a different callable (with the same shape) for
testing or for routing different planner request types to different
executors. The hook signature is:

    invoke_planner(*, base_dir, agent_id, planner_roles) -> dict

returning the same aggregate the hook returns.

Profile-gate reuse: the daemon enforces ``agent_claim`` action_kind
(NOT a new action_kind) so the same Plan 020
``ACTION_PERMISSIONS`` table at runtime_profile.py:107-112
governs the daemon. Frozen and observe profiles block dispatch
automatically with no table extension required.
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
    "DEFAULT_PLANNER_ROLES",
    "run_planner_dispatch_daemon",
]


DEFAULT_POLL_INTERVAL_SECONDS: float = 30.0
DEFAULT_DAEMON_ID: str = "planner-dispatch"
DEFAULT_PLANNER_ROLES: tuple[str, ...] = (
    "primary_plan",
    "challenger_plan",
    # Plan ARIA-V5 §2 V5.1 Phase 5.1 — cross_review role added so the
    # planner_dispatch_daemon also claims primary↔challenger cross-
    # review envelopes minted by ``convergence_drainer``. Pre-V5
    # cross_review envelopes existed but were never claimed by the
    # autonomy planner daemon — only operator-driven CLI flows
    # consumed them.
    "cross_review",
)
_DAEMON_LOCK_TIMEOUT_SECONDS: float = 2.0
_DAEMON_AGENT_KIND: str = "agent_claim"  # piggy-back on existing profile gate


def run_planner_dispatch_daemon(
    *,
    base_dir: str | Path,
    workspace_root: str | Path | None = None,
    max_iterations: int | None = None,
    poll_interval_seconds: float = DEFAULT_POLL_INTERVAL_SECONDS,
    daemon_id: str = DEFAULT_DAEMON_ID,
    roles: tuple[str, ...] = DEFAULT_PLANNER_ROLES,
    invoke_planner: Callable[..., dict[str, Any]] | None = None,
    sleep: Callable[[float], None] = time.sleep,
    aria_stop_filename: str = "ARIA_STOP",
    lease_seconds: int = 1800,
) -> dict[str, Any]:
    """Run the autonomous planner-dispatch daemon.

    See module docstring for the state machine + termination
    conditions. ``workspace_root`` is currently unused at the daemon
    layer (the per-tick hook does not need it because ci_executor.py
    derives its own repo root via Path.cwd()) but is part of the
    public surface so the CLI can pass it through for future hooks
    that DO need it.
    """
    from .file_lock import with_exclusive_lock
    from .runtime_profile import enforce_profile_for_action
    from .tool_registry import (
        GovernanceError,
        append_tools_governance,
        ensure_tools_dir,
    )

    if invoke_planner is None:
        # Default hook = subprocess-parity ci_executor.py invocation
        # (see planner_dispatch_hook.py). Operators / tests can inject
        # a different callable with the same shape for routing or
        # mock-mode purposes.
        from .planner_dispatch_hook import dispatch_one_pending_planner_request
        invoke_planner = dispatch_one_pending_planner_request

    root = ensure_tools_dir(base_dir)
    daemons_dir = root / "daemons"
    daemons_dir.mkdir(parents=True, exist_ok=True)
    daemon_pid_path = daemons_dir / f"{daemon_id}.pid.lock"
    aria_stop_path = root / aria_stop_filename
    daemon_agent_id = f"daemon:{daemon_id}:{os.getpid()}"

    iterations = 0
    claims_dispatched = 0
    exit_reason = "max_iterations"

    try:
        with with_exclusive_lock(
            daemon_pid_path, timeout_seconds=_DAEMON_LOCK_TIMEOUT_SECONDS
        ):
            append_tools_governance(
                root, "planner_dispatch_daemon_started",
                {
                    "daemon_id": daemon_id,
                    "daemon_agent_id": daemon_agent_id,
                    "roles": list(roles),
                    "poll_interval_seconds": poll_interval_seconds,
                    "max_iterations": max_iterations,
                    "started_at": datetime.now(timezone.utc).isoformat()
                    .replace("+00:00", "Z"),
                },
            )

            while True:
                # ARIA_STOP precedes the profile gate so a frozen
                # profile under ARIA_STOP exits with the more
                # specific aria_stop reason (matches cycle.py:244
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
                    root, "planner_dispatch_iteration_started",
                    {"iteration_n": iterations, "daemon_id": daemon_id},
                )

                result = invoke_planner(
                    base_dir=root,
                    agent_id=daemon_agent_id,
                    planner_roles=roles,
                    lease_seconds=lease_seconds,
                )
                status = result.get("status")

                if status == "no_pending":
                    append_tools_governance(
                        root, "planner_dispatch_iteration_completed",
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

                if status == "dispatched":
                    claims_dispatched += 1

                append_tools_governance(
                    root, "planner_dispatch_iteration_completed",
                    {
                        "iteration_n": iterations,
                        "daemon_id": daemon_id,
                        "status": status,
                        "request_id": result.get("request_id"),
                        "claim_id": result.get("claim_id"),
                        "exit_code": result.get("exit_code"),
                    },
                )

                if (
                    max_iterations is not None
                    and iterations >= max_iterations
                ):
                    break

            append_tools_governance(
                root, "planner_dispatch_daemon_exit",
                {
                    "daemon_id": daemon_id,
                    "iterations": iterations,
                    "claims_dispatched": claims_dispatched,
                    "exit_reason": exit_reason,
                },
            )

            return {
                "iterations": iterations,
                "claims_dispatched": claims_dispatched,
                "exits_clean": True,
                "exit_reason": exit_reason,
            }
    except TimeoutError:
        # Single-instance lock contended — second daemon process saw
        # the first instance's lock. Clean exit (NOT raise) so
        # operators can run the same command repeatedly without
        # surfacing failures.
        append_tools_governance(
            root, "planner_dispatch_daemon_lock_contended",
            {
                "daemon_id": daemon_id,
                "lock_path": str(daemon_pid_path),
            },
        )
        return {
            "iterations": 0,
            "claims_dispatched": 0,
            "exits_clean": False,
            "exit_reason": "daemon_already_running",
        }
