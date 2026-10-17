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
* ``provider_cooldown`` — the assignment's provider is under an active
  quota cooldown (operator decision 2026-09-12; ``aria_kernel.
  provider_cooldown``). Pre-claim: the assignment is skipped by name
  WITHOUT a claim or a spawn. Post-executor: the child cooled the
  provider under this claim (its ``except ClaudeCreditExhausted`` arm),
  so the claim is released under ``provider_quota_unavailable:
  <provider>`` rather than as a generic executor failure. The daemon
  backs off on this status (sleeps the poll interval) while the cooldown
  stands.
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
(assignment_id + target_agent + ``--claim-id``, the claim the child
runs under and keys its provider-cooldown row on); stderr redacted at
the hook boundary as defense-in-depth on top of worker_executor's own
redaction.
"""
from __future__ import annotations

import os
import subprocess
from pathlib import Path
from typing import Any

from .agent_invocations import DEFAULT_LEASE_SECONDS, executor_timeout_seconds


__all__ = [
    "DEFAULT_MAX_RETRIES",
    "STATUSES",
    "dispatch_one_pending_worker_assignment",
    "worker_ladder_for_target",
    "worker_target_profile",
]


DEFAULT_MAX_RETRIES: int = 3
LEASE_TOKEN_ENV_VAR: str = "ARIA_LEASE_TOKEN"

STATUSES: frozenset[str] = frozenset({
    "no_pending",
    "claim_failed",
    "provider_cooldown",
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


def worker_target_profile(target_agent: str, *, base_dir: str | Path,
                          worker_executor_path: Path | None = None) -> Any:
    """The runtime profile a worker assignment's target runs under (ARIA-HIGH-434).

    The ONE resolution of the target's agent file: from the CODE tree that
    holds the executor the hook spawns (`_default_worker_executor_path`),
    never from the store — the hook routes on it and the lease reaper
    reads the same ladder, so the two cannot read two different files.
    """
    from .agent_runtime_profile import read_agent_runtime_profile
    from .tool_registry import ensure_tools_dir

    path = worker_executor_path or _default_worker_executor_path(ensure_tools_dir(base_dir))
    return read_agent_runtime_profile(target_agent, repo_root=path.resolve().parents[2])


def worker_ladder_for_target(target_agent: str, *, base_dir: str | Path,
                             worker_executor_path: Path | None = None) -> tuple[str, ...]:
    """`runtime_profiles.worker_ladder` for an assignment's target: the
    providers it runs on, in order."""
    from .runtime_profiles import worker_ladder

    return worker_ladder(worker_target_profile(target_agent, base_dir=base_dir,
                                               worker_executor_path=worker_executor_path))


def _cooldown_summary(cooldown: dict[str, Any]) -> dict[str, Any]:
    """The cooldown facts a hook result and its governance rows carry.

    Keys are prefixed so they cannot collide with the row's own
    ``claim_id`` / ``assignment_id`` — the cooldown's ids name the run
    that EXHAUSTED the provider, which on the pre-claim path is a
    different run (often the planner lane's) from the assignment being
    skipped.
    """
    return {
        "provider": cooldown["provider"],
        "cooldown_model": cooldown["model"],
        "cooldown_until": cooldown["until"],
        "cooldown_recorded_at": cooldown["recorded_at"],
        "cooldown_request_id": cooldown["request_id"],
        "cooldown_claim_id": cooldown["claim_id"],
    }


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
    subprocess non-zero exit, verification failure). Programmer errors
    raise, and so does a malformed ``provider_quota_cooldown`` ledger
    row — a named ``GovernanceError`` from ``active_provider_cooldowns``
    (Step 2b): an integrity refusal that must stop the daemon rather
    than re-admit an exhausted provider or spin on the same row.

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
    from .provider_cooldown import active_provider_cooldowns, provider_cooldown_for_claim
    from .runtime_profiles import worker_ladder, worker_route
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

    # Step 2b — pre-claim provider route (operator decisions 2026-09-12 and
    # 2026-10-10). The assignment runs on the first rung of its target's
    # worker ladder (`runtime_profiles.worker_ladder`: a write-capable
    # target rides the writer ladder, anthropic then zai — ARIA-HIGH-434,
    # the Z.ai tool loop) that is neither under an active cooldown nor
    # absent on this host. While EVERY rung is out there is nothing to claim
    # FOR — a claim would spawn an exhausted provider again and hand the
    # assignment back a lease later — so it is skipped by name, no claim, no
    # lease, under the ladder head's cooldown; the daemon backs off on this
    # status. A malformed cooldown row is a ledger-integrity refusal from
    # `active_provider_cooldowns` and propagates by name: an unreadable
    # cooldown must stop the daemon, not re-admit an exhausted provider or
    # spin on the same row.
    if worker_executor_path is None:
        worker_executor_path = _default_worker_executor_path(root)
    repo_root = worker_executor_path.resolve().parents[2]
    profile = worker_target_profile(assignment_target, base_dir=root, worker_executor_path=worker_executor_path)
    if not worker_ladder(profile):
        # The operator suspended every writer (`suspended_providers`): no
        # rung exists to wait for, so the daemon stops by name before any
        # claim, like an unreadable cooldown — never a silent spin.
        raise GovernanceError(f"worker_route_unavailable:{assignment_target}:every_writer_suspended")
    cooldowns = active_provider_cooldowns(root)
    route = worker_route(profile, environ=os.environ, cooled=cooldowns)
    if route is None:
        # None means a rung is cooled and none can serve here
        # (`worker_route`): the first cooled rung's row names why.
        provider = next(key for key in worker_ladder(profile) if key in cooldowns)
        cooldown = cooldowns[provider]
    else:
        provider, routed_model = route
        cooldown = None
    if cooldown is not None:
        cooldown_summary = _cooldown_summary(cooldown)
        append_tools_governance(
            root, "worker_dispatch_provider_cooldown",
            {
                "assignment_id": assignment_id, "claim_id": None,
                "target_agent": assignment_target, "model": profile.model,
                "stage": "pre_claim", **cooldown_summary,
            },
        )
        return {
            "status": "provider_cooldown",
            "assignment_id": assignment_id, "claim_id": None,
            "exit_code": None, "decision": None,
            "governance_event_count": 1,
            "stderr_redacted": "",
            "retry_count": retry_count,
            "merge_result": None,
            "provider_cooldown": cooldown_summary,
        }

    # Step 3 — claim under the exclusive lock.
    governance_count = 0
    try:
        claim = claim_assignment(
            assignment_id=assignment_id, agent_id=agent_id, provider=provider,
            lease_seconds=lease_seconds, base_dir=root,
        )
        # claim_assignment emits dispatch_request_state_changed (1; written
        # when the row carries a pressure_event_id, which every dispatch-row
        # writer sets: create_dispatch_request, and promotion_controller,
        # which synthesises plan-promotion:<plan>:<cycle>) +
        # dispatch_claim_created (1) = 2 governance events.
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
    # via env, public identifiers via argv (the claim id included: the
    # child keys its provider-cooldown row on it, and that row is how this
    # hook tells a quota exhaustion apart from a crash below).
    argv: list[str] = [
        "python3", str(worker_executor_path),
        assignment_id, assignment_target, "--claim-id", claim_id,
        # ARIA-HIGH-434 — the model the route above chose (a public tier
        # name); the child re-checks it against the same ladder.
        "--model", routed_model,
    ]
    env: dict[str, str] = {
        **os.environ,
        "PYTHONPATH": str(repo_root / "aria-kernel"),
        LEASE_TOKEN_ENV_VAR: lease_token,
    }
    timeout_seconds = executor_timeout_seconds(lease_seconds)
    try:
        proc = subprocess.run(
            argv, capture_output=True, text=True,
            timeout=timeout_seconds, env=env, cwd=str(repo_root),
        )
        exit_code = proc.returncode
        stderr_text = proc.stderr or ""
    except subprocess.TimeoutExpired:
        # No release here, deliberately. The killed child's claim is settled
        # by reap_expired_assignment_claims under the counted lease-expiry
        # ladder (DEFAULT_MAX_LEASE_REQUEUES, then human_required). A free
        # release would requeue a deterministic hang forever: this lane's
        # retry budget (assignment_retry_count) counts only
        # verification_gate_failed, and this hook records no breaker failure.
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

    def _release(reason: str, *, stage: str) -> int:
        """Release the claim back to ``pending``; return the rows written.

        Plan 025 §E reviewer MEDIUM-001 — one audit shape for every
        release site: a release failure is never swallowed, operators
        reading governance.jsonl see the precise failure mode (claim
        still terminal-marked under a stale token vs. claim_id missing
        vs. already-released) and the stage it happened at.
        """
        try:
            release_claim_assignment(
                claim_id=claim_id, lease_token=lease_token,
                reason=reason, base_dir=root,
            )
            return 2  # released + state_changed
        except GovernanceError as exc:
            append_tools_governance(
                root, "worker_dispatch_release_claim_failed",
                {
                    "assignment_id": assignment_id,
                    "claim_id": claim_id,
                    "stage": stage,
                    "error": str(exc),
                },
            )
            return 1

    if exit_code != 0:
        # ARIA-HIGH-290 — a cooldown is written once per transition, so a
        # child that hit an exhaustion ANOTHER run had already cooled finds
        # that standing row instead of writing its own. No cooldown stood for
        # this provider when the claim was taken (step 2 refused otherwise),
        # so one standing now began while this claim ran.
        cooldown = (provider_cooldown_for_claim(root, claim_id=claim_id)
                    or active_provider_cooldowns(root).get(provider))
        if cooldown is not None:
            # The child cooled the provider under THIS claim (worker_executor's
            # `except ClaudeCreditExhausted` arm): a quota exhaustion, not a
            # crash. Released under the reason that names the provider — the
            # same word the planner lane uses — so a billing event never
            # reads as an executor failure in the ledger, and reported as
            # `provider_cooldown` so the daemon backs off at once instead of
            # discovering the cooldown at its next claim attempt.
            cooldown_summary = _cooldown_summary(cooldown)
            append_tools_governance(
                root, "worker_dispatch_provider_cooldown",
                {
                    "assignment_id": assignment_id, "claim_id": claim_id,
                    "target_agent": assignment_target, "model": routed_model,
                    "stage": "executor", "exit_code": exit_code,
                    **cooldown_summary,
                },
            )
            governance_count += 1
            governance_count += _release(
                f"provider_quota_unavailable:{cooldown['provider']}",
                stage="provider_cooldown",
            )
            return {
                "status": "provider_cooldown",
                "assignment_id": assignment_id, "claim_id": claim_id,
                "exit_code": exit_code, "decision": None,
                "governance_event_count": governance_count,
                "stderr_redacted": stderr_redacted,
                "retry_count": retry_count,
                "merge_result": None,
                "provider_cooldown": cooldown_summary,
            }
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
        governance_count += _release("worker_executor_failed", stage="executor_failed")
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
    governance_count += _release(
        "verification_failed_retry_scheduled", stage="verification_failed",
    )
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
