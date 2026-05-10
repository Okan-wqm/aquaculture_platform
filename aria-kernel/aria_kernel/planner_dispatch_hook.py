"""Plan 025 §D — Claude Code invocation hook for the autonomous
planner dispatcher daemon.

Per-tick contract: find one pending planner request, claim it, dispatch
to ``tools/aria-poc/ci_executor.py`` as a subprocess, capture exit
code + redacted stderr, emit governance events, return a structured
result dict. The daemon (autonomous_planner_dispatcher.run_planner_
dispatch_daemon) calls this on every iteration.

Subprocess parity with the §B-fixed ci_executor.py main() — both the
GHA workflow path and the autonomous daemon path reach the SAME
per-request executor so cost-cap, envelope-load (agent-invocations
list --request-id), mock vs live branch, lease-token-from-env
discipline, and submit-result wiring are tested once. Forking the
path into an in-process invoke_claude_code() helper would split
governance event coverage between two surfaces and re-open the
silent-swallow vector closed at §B.

Lease-token discipline (Plan 019 Phase 8.B):
* Lease token transit ONLY via the ARIA_LEASE_TOKEN env var.
* argv NEVER carries the raw token; the executor reads the token from
  os.environ at submit time via --lease-token-from-env.
* Stderr is redacted at the daemon boundary as defense-in-depth even
  though ci_executor already redacts at its own boundary.

Subagent-type SSoT: the daemon reads ``target_agent`` from the
request row returned by ``next_pending_request``. The role→target
pairing was enforced at request creation time by
``agent_contract.ROLE_TARGET_PAIRING``; re-deriving in the daemon
would duplicate the rule and split the SSoT.
"""
from __future__ import annotations

import os
import subprocess
from pathlib import Path
from typing import Any


__all__ = [
    "DEFAULT_PLANNER_ROLES",
    "DEFAULT_LEASE_SECONDS",
    "dispatch_one_pending_planner_request",
]


DEFAULT_PLANNER_ROLES: tuple[str, ...] = ("primary_plan", "challenger_plan")
DEFAULT_LEASE_SECONDS: int = 1800
LEASE_TOKEN_ENV_VAR: str = "ARIA_LEASE_TOKEN"


def _redact_lease_in_message(message: str, lease_token: str | None) -> str:
    """Mirror of tools/aria-poc/ci_executor._redact_lease_in_message.

    Inlined here so the daemon does not need to add tools/aria-poc to
    PYTHONPATH at runtime; the import discipline keeps the kernel
    package's runtime dependency surface aria-kernel-only.
    """
    if not lease_token:
        return message
    return message.replace(lease_token, "<lease-token-redacted>")


def _default_ci_executor_path(base_dir: Path) -> Path:
    """Resolve the ci_executor.py path from base_dir.

    base_dir is the aria-tools directory inside the repo; the repo
    root is its parent; ci_executor.py lives at
    <repo>/tools/aria-poc/ci_executor.py. Operators can override via
    the explicit ``ci_executor_path`` argument when running outside a
    standard checkout.
    """
    return base_dir.parent / "tools" / "aria-poc" / "ci_executor.py"


def dispatch_one_pending_planner_request(
    *,
    base_dir: str | Path,
    agent_id: str,
    lease_seconds: int = DEFAULT_LEASE_SECONDS,
    planner_roles: tuple[str, ...] = DEFAULT_PLANNER_ROLES,
    ci_executor_path: Path | None = None,
) -> dict[str, Any]:
    """Find one pending planner request, claim it, dispatch the
    Claude Code CLI via ci_executor.py subprocess.

    Returns aggregate dict with ``status`` ∈
    ``{no_pending, claim_failed, executor_failed, dispatched}``,
    plus ``request_id``, ``claim_id``, ``exit_code``,
    ``governance_event_count``, ``stderr_redacted``.

    Does NOT raise on operational failures (claim rejections,
    subprocess non-zero exit, subprocess timeout); only programmer
    errors raise (e.g. base_dir missing). The daemon's loop treats
    every dict return as one tick.

    Does NOT acquire any daemon-level lock. The kernel primitives
    claim_request and submit_claim_result already carry their own
    §A.1 / §H-1 locks; the daemon's outer single-instance lock
    guards the loop, not this hook.

    Does NOT set CLAUDE_CODE_MOCK. The operator controls mock vs
    live mode via the env var at daemon launch time; this hook
    inherits the parent process env unchanged.
    """
    # Local imports keep kernel cold-start light. The daemon module
    # already imports this hook lazily from inside its own loop; the
    # sub-imports below run only on the first dispatch tick.
    from .agent_invocations import claim_request, next_pending_request
    from .tool_registry import (
        GovernanceError,
        append_tools_governance,
        ensure_tools_dir,
    )

    root = ensure_tools_dir(base_dir)

    # Step 1 — find one pending request whose role is in planner_roles.
    # Role iteration order = priority order (primary_plan first by
    # default; operator can re-order via the planner_roles kwarg).
    request: dict[str, Any] | None = None
    for role in planner_roles:
        request = next_pending_request(role=role, base_dir=root)
        if request is not None:
            break
    if request is None:
        return {
            "status": "no_pending",
            "request_id": None,
            "claim_id": None,
            "exit_code": None,
            "governance_event_count": 0,
            "stderr_redacted": "",
        }

    request_id: str = request["request_id"]
    target_agent: str = str(request.get("target_agent", ""))
    if not target_agent:
        # Programmer-error: every request row should carry target_agent
        # (enforced at create_agent_invocation_request). Surface as a
        # claim_failed governance event so the operator can repair the
        # row instead of silently retrying.
        append_tools_governance(
            root, "planner_dispatch_request_missing_target_agent",
            {"request_id": request_id, "role": request.get("role")},
        )
        return {
            "status": "claim_failed",
            "request_id": request_id,
            "claim_id": None,
            "exit_code": None,
            "governance_event_count": 1,
            "stderr_redacted": "",
        }

    # Step 2 — claim the request via the kernel primitive (in-process,
    # already lock-bound by Plan 024 §H-1). claim_request emits its
    # own agent_claim_created governance event on success; we count
    # that toward governance_event_count so the daemon's structured
    # log aligns with the ledger.
    governance_count = 0
    try:
        claim = claim_request(
            request_id=request_id,
            agent_id=agent_id,
            lease_seconds=lease_seconds,
            base_dir=root,
        )
        governance_count += 1  # agent_claim_created
    except GovernanceError as exc:
        append_tools_governance(
            root, "planner_dispatch_claim_failed",
            {"request_id": request_id, "error": str(exc)},
        )
        return {
            "status": "claim_failed",
            "request_id": request_id,
            "claim_id": None,
            "exit_code": None,
            "governance_event_count": 1,
            "stderr_redacted": "",
        }

    claim_id: str = claim["claim_id"]
    lease_token: str = claim["lease_token"]

    # Step 3 — invoke ci_executor.py as a subprocess. Lease token via
    # env var; argv carries only public identifiers.
    if ci_executor_path is None:
        ci_executor_path = _default_ci_executor_path(root)
    repo_root = root.parent
    argv: list[str] = [
        "python3",
        str(ci_executor_path),
        request_id,
        target_agent,
    ]
    env: dict[str, str] = {
        **os.environ,
        "PYTHONPATH": str(repo_root / "aria-kernel"),
        LEASE_TOKEN_ENV_VAR: lease_token,
    }
    timeout_seconds = lease_seconds + 60
    try:
        proc = subprocess.run(
            argv,
            capture_output=True,
            text=True,
            timeout=timeout_seconds,
            env=env,
            cwd=str(repo_root),
        )
        exit_code = proc.returncode
        stderr_text = proc.stderr or ""
    except subprocess.TimeoutExpired:
        append_tools_governance(
            root, "planner_dispatch_executor_timeout",
            {
                "request_id": request_id, "claim_id": claim_id,
                "target_agent": target_agent,
                "timeout_seconds": timeout_seconds,
            },
        )
        return {
            "status": "executor_failed",
            "request_id": request_id,
            "claim_id": claim_id,
            "exit_code": None,
            "governance_event_count": governance_count + 1,
            "stderr_redacted": "executor_timeout",
        }

    # Step 4 — redact lease token from stderr at the daemon boundary
    # (defense in depth: ci_executor already redacts at its own
    # boundary, but the daemon does not trust subprocess stderr
    # untouched).
    stderr_redacted = _redact_lease_in_message(stderr_text, lease_token)

    # Step 5 — emit terminal governance events. The exit-code-suffixed
    # event lets operators alert on planner_dispatch_executor_exit_*
    # without parsing payloads; the dispatched event records the
    # full per-tick context.
    append_tools_governance(
        root, f"planner_dispatch_executor_exit_{exit_code}",
        {
            "request_id": request_id, "claim_id": claim_id,
            "target_agent": target_agent, "exit_code": exit_code,
        },
    )
    governance_count += 1
    append_tools_governance(
        root, "planner_dispatch_dispatched",
        {
            "request_id": request_id, "claim_id": claim_id,
            "target_agent": target_agent, "exit_code": exit_code,
        },
    )
    governance_count += 1

    status = "dispatched" if exit_code == 0 else "executor_failed"
    return {
        "status": status,
        "request_id": request_id,
        "claim_id": claim_id,
        "exit_code": exit_code,
        "governance_event_count": governance_count,
        "stderr_redacted": stderr_redacted,
    }
