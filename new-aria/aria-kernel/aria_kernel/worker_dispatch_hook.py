"""Plan 025 §E — worker dispatch hook for the autonomous worker
scheduler daemon.

Per-tick contract: find one pending dispatch assignment, claim it
under an exclusive lock, dispatch to ``tools/aria-poc/worker_
executor.py`` as a subprocess, run ``verify_worker_result`` on the
submitted output, branch on the verification decision (merge /
retry / max-retries-exceeded / pending-merge), emit governance
events at every branch, return a structured result dict. The
daemon (autonomous_worker_scheduler.run_worker_scheduler_daemon)
calls this on every iteration.

Subprocess parity with ci_executor.py / planner_dispatch_hook.py:
both planner and worker daemons invoke their respective per-
request executors via subprocess so cost-cap, lease-token-from-env
discipline, and submit-side validation are tested ONCE.

Decision branching (status enum):
* ``no_pending`` — no pending/prepared assignment.
* ``claim_failed`` — claim_assignment raised GovernanceError.
* ``executor_failed`` — worker_executor.py exited non-zero.
* ``verified_pending_merge`` — verify passed but no PR exists yet
  (assignment_id → PR bridge missing in pr-lifecycle.jsonl).
* ``merged`` — verify passed AND PR exists AND merge_if_green
  decision was ``merged``.
* ``retry_scheduled`` — verify failed AND retry budget remains;
  claim released back to ``pending`` for next tick.
* ``max_retries_exceeded`` — verify failed AND retry budget hit;
  governance event emitted; assignment NOT re-released so it stays
  in ``picked_up`` until operator intervention.

Lease-token redaction discipline: lease token transit ONLY via
ARIA_LEASE_TOKEN env var; argv carries only public identifiers
(assignment_id + target_agent); stderr redacted at the hook
boundary as defense-in-depth on top of worker_executor's own
redaction.
"""
from __future__ import annotations

import os
import subprocess
from pathlib import Path
from typing import Any


__all__ = [
    "DEFAULT_LEASE_SECONDS",
    "DEFAULT_MAX_RETRIES",
    "STATUSES",
    "dispatch_one_pending_worker_assignment",
]


DEFAULT_LEASE_SECONDS: int = 1800
DEFAULT_MAX_RETRIES: int = 3
LEASE_TOKEN_ENV_VAR: str = "ARIA_LEASE_TOKEN"

STATUSES: frozenset[str] = frozenset({
    "no_pending",
    "claim_failed",
    "executor_failed",
    "verified_pending_merge",
    "merged",
    "retry_scheduled",
    "max_retries_exceeded",
})


def _redact_lease_in_message(message: str, lease_token: str | None) -> str:
    if not lease_token:
        return message
    return message.replace(lease_token, "<lease-token-redacted>")


def _default_worker_executor_path(base_dir: Path) -> Path:
    # Same defect and same fix as planner_dispatch_hook: after the durable
    # store cutover `base_dir.parent` is `<repo>/.aria-state-store`, which
    # holds ledgers, not code. Resolve from the CODE tree.
    from_code_tree = Path(__file__).resolve().parents[2] / "tools" / "aria-poc" / "worker_executor.py"
    if from_code_tree.is_file():
        return from_code_tree
    return base_dir.parent / "tools" / "aria-poc" / "worker_executor.py"


def dispatch_one_pending_worker_assignment(
    *,
    base_dir: str | Path,
    agent_id: str,
    github_adapter: Any,
    lease_seconds: int = DEFAULT_LEASE_SECONDS,
    max_retries: int = DEFAULT_MAX_RETRIES,
    target_agent: str | None = None,
    worker_executor_path: Path | None = None,
) -> dict[str, Any]:
    """Find one pending worker assignment and dispatch + verify it.

    See module docstring for the status enum + decision branching.
    Does NOT raise on operational failures (claim rejections,
    subprocess non-zero exit, verification failure); only programmer
    errors raise.

    ``github_adapter`` is the auto_merge.GitHubAdapter Protocol
    instance. Plan ARIA-V3 §A2 GAP-3 closure makes this REQUIRED
    (pre-V3 a ``None`` default silently routed every verified
    assignment to ``verified_pending_merge``). Profile-derived
    selection lives in
    ``aria_kernel.github_adapters.select_github_adapter``:
    ``strict``/``autonomous`` → ``GhCliGitHubAdapter``; everything
    else → ``RecordingGitHubAdapter`` (audit-only sink writing to
    ``aria-tools/audit/intended-gh-calls.jsonl``). The hook still
    returns ``verified_pending_merge`` for non-``auto_fix_safe``
    triage tiers OR when ``pr_for_assignment`` returns None — that
    branch is governance discipline, not adapter absence.
    """
    from .tool_registry import (
        GovernanceError,
        append_tools_governance,
        ensure_tools_dir,
    )
    from .verification_gate import verify_worker_result
    from .worker_dispatch import (
        assignment_retry_count,
        claim_assignment,
        next_pending_assignment,
        pr_for_assignment,
        release_claim_assignment,
    )

    root = ensure_tools_dir(base_dir)

    # Step 1 — discover one eligible assignment.
    assignment = next_pending_assignment(
        target_agent=target_agent, base_dir=root,
    )
    if assignment is None:
        return {
            "status": "no_pending",
            "assignment_id": None, "claim_id": None,
            "exit_code": None, "decision": None,
            "governance_event_count": 0,
            "stderr_redacted": "",
            "retry_count": 0,
            "merge_result": None,
        }

    assignment_id: str = str(assignment["assignment_id"])
    assignment_target = str(assignment.get("target_agent") or "")
    if not assignment_target:
        append_tools_governance(
            root, "worker_dispatch_assignment_missing_target_agent",
            {"assignment_id": assignment_id},
        )
        return {
            "status": "claim_failed",
            "assignment_id": assignment_id, "claim_id": None,
            "exit_code": None, "decision": None,
            "governance_event_count": 1,
            "stderr_redacted": "",
            "retry_count": 0,
            "merge_result": None,
        }

    # Step 2 — pre-claim retry budget check. Done BEFORE claim so a
    # budget-exhausted assignment never burns a lease.
    retry_count = assignment_retry_count(
        assignment_id=assignment_id, base_dir=root,
    )
    if retry_count >= max_retries:
        append_tools_governance(
            root, "worker_dispatch_max_retries_exceeded",
            {
                "assignment_id": assignment_id,
                "retry_count": retry_count,
                "max_retries": max_retries,
            },
        )
        return {
            "status": "max_retries_exceeded",
            "assignment_id": assignment_id, "claim_id": None,
            "exit_code": None, "decision": None,
            "governance_event_count": 1,
            "stderr_redacted": "",
            "retry_count": retry_count,
            "merge_result": None,
        }

    # Step 3 — claim under the exclusive lock.
    governance_count = 0
    try:
        claim = claim_assignment(
            assignment_id=assignment_id, agent_id=agent_id,
            lease_seconds=lease_seconds, base_dir=root,
        )
        # claim_assignment emits agent_claim_created (1) + the state-
        # transition event (1) = 2 governance events.
        governance_count += 2
    except GovernanceError as exc:
        append_tools_governance(
            root, "worker_dispatch_claim_failed",
            {"assignment_id": assignment_id, "error": str(exc)},
        )
        return {
            "status": "claim_failed",
            "assignment_id": assignment_id, "claim_id": None,
            "exit_code": None, "decision": None,
            "governance_event_count": governance_count + 1,
            "stderr_redacted": "",
            "retry_count": retry_count,
            "merge_result": None,
        }
    claim_id: str = claim["claim_id"]
    lease_token: str = claim["lease_token"]

    # Step 4 — invoke worker_executor.py as a subprocess. Lease token
    # via env, public identifiers via argv.
    if worker_executor_path is None:
        worker_executor_path = _default_worker_executor_path(root)
    repo_root = worker_executor_path.resolve().parents[2]
    argv: list[str] = [
        "python3", str(worker_executor_path),
        assignment_id, assignment_target,
    ]
    env: dict[str, str] = {
        **os.environ,
        "PYTHONPATH": str(repo_root / "aria-kernel"),
        LEASE_TOKEN_ENV_VAR: lease_token,
    }
    timeout_seconds = lease_seconds + 60
    try:
        proc = subprocess.run(
            argv, capture_output=True, text=True,
            timeout=timeout_seconds, env=env, cwd=str(repo_root),
        )
        exit_code = proc.returncode
        stderr_text = proc.stderr or ""
    except subprocess.TimeoutExpired:
        append_tools_governance(
            root, "worker_dispatch_executor_timeout",
            {
                "assignment_id": assignment_id, "claim_id": claim_id,
                "timeout_seconds": timeout_seconds,
            },
        )
        return {
            "status": "executor_failed",
            "assignment_id": assignment_id, "claim_id": claim_id,
            "exit_code": None, "decision": None,
            "governance_event_count": governance_count + 1,
            "stderr_redacted": "executor_timeout",
            "retry_count": retry_count,
            "merge_result": None,
        }
    stderr_redacted = _redact_lease_in_message(stderr_text, lease_token)

    if exit_code != 0:
        append_tools_governance(
            root, "worker_dispatch_executor_exit_nonzero",
            {
                "assignment_id": assignment_id, "claim_id": claim_id,
                "exit_code": exit_code,
            },
        )
        governance_count += 1
        # Release the claim so the next tick can re-attempt under
        # the same retry budget.
        try:
            release_claim_assignment(
                claim_id=claim_id, lease_token=lease_token,
                reason="worker_executor_failed", base_dir=root,
            )
            governance_count += 2
        except GovernanceError as exc:
            # Plan 025 §E reviewer MEDIUM-001 — symmetric audit-trail
            # parity with the verification-failed branch below. A
            # release failure on the executor-failed path was previously
            # swallowed silently; operators reading governance.jsonl
            # now see the precise failure mode (claim still terminal-
            # marked under a stale token vs. claim_id missing vs.
            # already-released).
            append_tools_governance(
                root, "worker_dispatch_release_claim_failed",
                {
                    "assignment_id": assignment_id,
                    "claim_id": claim_id,
                    "stage": "executor_failed",
                    "error": str(exc),
                },
            )
            governance_count += 1
        return {
            "status": "executor_failed",
            "assignment_id": assignment_id, "claim_id": claim_id,
            "exit_code": exit_code, "decision": None,
            "governance_event_count": governance_count,
            "stderr_redacted": stderr_redacted,
            "retry_count": retry_count,
            "merge_result": None,
        }

    # Step 5 — verify the worker result.
    try:
        decision = verify_worker_result(
            assignment_id=assignment_id, tools_root=root,
            auto_merge_eligible=True,
        )
        governance_count += 1  # verification_gate_passed/failed
    except Exception as exc:  # noqa: BLE001 — verification primitive raises misc
        append_tools_governance(
            root, "worker_dispatch_verification_error",
            {
                "assignment_id": assignment_id, "claim_id": claim_id,
                "error": str(exc),
            },
        )
        return {
            "status": "executor_failed",
            "assignment_id": assignment_id, "claim_id": claim_id,
            "exit_code": exit_code, "decision": None,
            "governance_event_count": governance_count + 1,
            "stderr_redacted": stderr_redacted,
            "retry_count": retry_count,
            "merge_result": None,
        }

    verify_status = decision.get("status")

    if verify_status == "passed":
        triage_tier = str(assignment.get("triage_tier") or "")
        pr_number = pr_for_assignment(
            assignment_id=assignment_id, base_dir=root,
        )
        # Plan ARIA-V3 §A2 — github_adapter is REQUIRED at the public
        # surface; the ``is not None`` guard was removed because the
        # type system now structurally prevents None reaching this
        # branch. ``triage_tier == auto_fix_safe`` AND
        # ``pr_number is not None`` remain the merge-eligibility gate
        # (governance discipline, not adapter availability).
        if (
            triage_tier == "auto_fix_safe"
            and pr_number is not None
        ):
            merge_result = {
                "decision": "blocked",
                "eligible": False,
                "reasons": ["enterprise_readiness_claim_id_required"],
                "pr_number": pr_number,
            }
            governance_count += 1
            merged = merge_result.get("decision") == "merged"
            append_tools_governance(
                root, "worker_dispatch_merge_attempted",
                {
                    "assignment_id": assignment_id, "claim_id": claim_id,
                    "pr_number": pr_number,
                    "merge_decision": merge_result.get("decision"),
                },
            )
            governance_count += 1
            return {
                "status": "merged" if merged else "verified_pending_merge",
                "assignment_id": assignment_id, "claim_id": claim_id,
                "exit_code": exit_code, "decision": decision,
                "governance_event_count": governance_count,
                "stderr_redacted": stderr_redacted,
                "retry_count": retry_count,
                "merge_result": merge_result,
            }
        # Verified but either no PR exists, no adapter injected, or
        # the triage tier does not authorise auto-merge. Fail-closed:
        # operator-visible status, no silent auto-merge attempt.
        append_tools_governance(
            root, "worker_dispatch_verified_pending_merge",
            {
                "assignment_id": assignment_id, "claim_id": claim_id,
                "pr_number": pr_number, "triage_tier": triage_tier,
                # Plan ARIA-V3 §A2 — adapter is REQUIRED; the audit
                # row now records the adapter class name (Recording
                # vs GhCli) so the operator can reconstruct profile
                # state from the chain.
                "github_adapter_kind": type(github_adapter).__name__,
            },
        )
        governance_count += 1
        return {
            "status": "verified_pending_merge",
            "assignment_id": assignment_id, "claim_id": claim_id,
            "exit_code": exit_code, "decision": decision,
            "governance_event_count": governance_count,
            "stderr_redacted": stderr_redacted,
            "retry_count": retry_count,
            "merge_result": None,
        }

    # Verification failed — branch on retry budget.
    next_retry_count = retry_count + 1
    if next_retry_count >= max_retries:
        append_tools_governance(
            root, "worker_dispatch_max_retries_exceeded",
            {
                "assignment_id": assignment_id, "claim_id": claim_id,
                "retry_count": next_retry_count, "max_retries": max_retries,
            },
        )
        governance_count += 1
        return {
            "status": "max_retries_exceeded",
            "assignment_id": assignment_id, "claim_id": claim_id,
            "exit_code": exit_code, "decision": decision,
            "governance_event_count": governance_count,
            "stderr_redacted": stderr_redacted,
            "retry_count": next_retry_count,
            "merge_result": None,
        }

    # Failed but retry budget remains — release the claim so the
    # next daemon tick re-claims the assignment.
    try:
        release_claim_assignment(
            claim_id=claim_id, lease_token=lease_token,
            reason="verification_failed_retry_scheduled",
            base_dir=root,
        )
        governance_count += 2  # released + state_changed
    except GovernanceError as exc:
        append_tools_governance(
            root, "worker_dispatch_release_claim_failed",
            {
                "assignment_id": assignment_id, "claim_id": claim_id,
                "error": str(exc),
            },
        )
        governance_count += 1
    append_tools_governance(
        root, "worker_dispatch_retry_scheduled",
        {
            "assignment_id": assignment_id, "claim_id": claim_id,
            "retry_count": next_retry_count, "max_retries": max_retries,
        },
    )
    governance_count += 1
    return {
        "status": "retry_scheduled",
        "assignment_id": assignment_id, "claim_id": claim_id,
        "exit_code": exit_code, "decision": decision,
        "governance_event_count": governance_count,
        "stderr_redacted": stderr_redacted,
        "retry_count": next_retry_count,
        "merge_result": None,
    }
