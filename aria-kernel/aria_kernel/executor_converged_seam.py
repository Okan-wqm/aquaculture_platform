"""ARIA-HIGH-368 — what the executor does with a plan it converged.

The converging CYCLE runs a post-CONVERGED block (``autonomy_orchestrator``)
whose plan-scoped parts need the plan to still be CONVERGED: the funnel's
``converged`` count, the memory hook's signed hypothesis row, and the offer to
the V9 runner (``converged_delivery.deliver_converged_plan``, ARIA-HIGH-362,
the ONLY call site of ``runner.run``). A plan the executor converged is
terminal for convergence, so no later cycle adopts it
(``resume_candidate_plan_id``) and none of that block would ever run for it;
the cycle's sweep re-offers delivery only. This module runs those three parts
here, through the same functions the cycle calls, in the cycle's order.

What it does NOT run, by construction: the specialist review. In the cycle it
runs AFTER delivery and gates only that cycle's own worker drain and
auto-merge evaluation (``specialist_verdict_blocks_cycle``); it never gated
the implementation request, and the PR the request produces passes the merge
lane's own gates.

Delivery runs only under the authority the cycle uses: the persisted runtime
profile (the cycle records its resolved profile there on every run) selects
the runner (``select_v9_implementation_runner``), and a runner that cannot
deliver is never offered the plan from here — that would count an uncounted
cycle per executor run and surface ``implementation_authority_absent`` early.
The plan stays CONVERGED for the cycle's sweep. Staging runs the plan's
BASELINE suite in this process, so the offer is made only when the suite's
worst case fits both the drain window and the job deadline.
"""
from __future__ import annotations

import math
import time
from pathlib import Path
from typing import Any, Callable

from .converged_delivery import ORIGIN_EXECUTOR

# Staging's own bounded subprocesses beside the suite: `git rev-parse HEAD`
# and the clean-tree `git status`, each at the store's git cap, plus the
# ledger work (change chain, proposal, approval, envelope mint) priced at the
# delivery's work allowance.
STAGING_GIT_CALLS: int = 2

LEFT_NO_AUTHORITY = "no_implementation_authority"
LEFT_WINDOW = "staging_does_not_fit_window"
FUNNEL_UNATTRIBUTED_KIND = "executor_convergence_funnel_unattributed"


def plan_pressure_source(*, tools_dir: Path, plan_id: str) -> str | None:
    """The pressure source the cycle minted ``plan_id`` from, or None.

    The cycle records it on the plan's FIRST ``cycle_runner_synthesized_plan``
    row (``PLAN_PRESSURE_SOURCE_DETAIL``); later rows are adoptions under
    other sources. A plan minted before that detail existed has no recorded source,
    and a guessed one would credit the pressure-source bandit with a
    convergence it did not earn.
    """
    from .autonomy_state import PLAN_MINTED_PHASE, PLAN_PRESSURE_SOURCE_DETAIL, autonomy_state_path
    from .ledger import load_declared_jsonl

    path = autonomy_state_path(tools_dir)
    if not path.exists():
        return None
    for row in load_declared_jsonl(path, expected_surface="autonomy_state"):
        details = row.get("details") if isinstance(row.get("details"), dict) else {}
        if row.get("phase") == PLAN_MINTED_PHASE and details.get("plan_id") == plan_id:
            source = details.get(PLAN_PRESSURE_SOURCE_DETAIL)
            return str(source) if isinstance(source, str) and source else None
    return None


def staging_worst_case_seconds(*, plan_id: str, tools_dir: Path) -> int:
    """How long ``stage_converged_plan_for_pr`` may run for this CONVERGED plan:
    the suite it will run as the baseline, every command at its ceiling, plus
    its git calls and its ledger work. A suite staging will refuse by name
    (an unregistered recipe) refuses before running anything."""
    from .apply_engine import _staged_validation_commands
    from .implementation_delivery import DELIVERY_WORK_ALLOWANCE_SECONDS
    from .plan_convergence import converged_plan_body
    from .state_store import GIT_TIMEOUT_SECONDS
    from .tool_registry import GovernanceError

    overhead = STAGING_GIT_CALLS * GIT_TIMEOUT_SECONDS + DELIVERY_WORK_ALLOWANCE_SECONDS
    body = converged_plan_body(plan_id=plan_id, base_dir=tools_dir)["plan_content"]
    try:
        commands, timeout_ms = _staged_validation_commands(body, base_dir=tools_dir)
    except GovernanceError:
        return int(overhead)
    return int(len(commands) * math.ceil(timeout_ms / 1000) + overhead)


def record_funnel(
    *, tools_dir: Path, plan_id: str, cycle_id: str, source: str | None, counter: str = "converged",
) -> str:
    """One funnel count (``converged`` or ``rejected``) for the plan's minting
    source; an unattributed plan is a governance row, never a guessed source."""
    from .knowledge_graph import effectiveness_writer_faults, record_pressure_source_outcome
    from .tool_registry import append_tools_governance

    if source is None:
        append_tools_governance(
            tools_dir, FUNNEL_UNATTRIBUTED_KIND,
            {"cycle_id": cycle_id, "plan_id": plan_id, "counter": counter},
            bypass_profile_gate=True,
        )
        return "unattributed"
    try:
        record_pressure_source_outcome(base_dir=tools_dir, source_type=source, **{counter: 1})
    except effectiveness_writer_faults() as exc:
        # The cycle's own handling of the same write (`_record_funnel_counter`).
        append_tools_governance(
            tools_dir, "pressure_source_outcome_failed",
            {"cycle_id": cycle_id, "source_type": source, "counters": {counter: 1},
             "error_class": type(exc).__name__, "error_message": str(exc)[:500]},
            bypass_profile_gate=True,
        )
        return "failed"
    return "recorded"


def run_executor_converged_seam(
    *,
    plan_id: str,
    cycle_id: str,
    convergence_result: dict[str, Any],
    tools_dir: Path,
    workspace_root: Path,
    drain_remaining: Callable[[], float] | None,
    deadline_epoch: float | None,
    now: Callable[[], float] = time.time,
    memory_hook: Any | None = None,
    runner: Any | None = None,
) -> dict[str, Any]:
    """Funnel, memory hook (and its replay), then the delivery offer — while
    the plan is CONVERGED. ``drain_remaining`` is read at the staging check,
    not before the memory work that precedes it."""
    from .autonomy_state import AutonomyStateReducer
    from .converged_delivery import deliver_converged_plan
    from .cycle_phases import select_memory_hook, select_v9_implementation_runner
    from .cycle_phases.knowledge_signer import cycle_knowledge_signer
    from .cycle_phases.memory import memory_hook_runtime_faults
    from .runtime_profile import get_profile
    from .tool_registry import append_tools_governance

    profile = get_profile(base_dir=tools_dir)
    source = plan_pressure_source(tools_dir=tools_dir, plan_id=plan_id)
    report: dict[str, Any] = {
        "profile": profile,
        "funnel": record_funnel(tools_dir=tools_dir, plan_id=plan_id, cycle_id=cycle_id, source=source),
    }
    hook = memory_hook if memory_hook is not None else select_memory_hook(profile=profile)
    v9_runner = runner if runner is not None else select_v9_implementation_runner(profile=profile)
    with cycle_knowledge_signer(
        profile=profile, cycle_id=cycle_id, workspace_root=workspace_root, base_dir=tools_dir,
    ) as signer:
        report["knowledge_signer"] = signer.receipt()
        try:
            memory = hook.record(
                cycle_id=cycle_id, plan_id=plan_id, workspace_root=workspace_root, base_dir=tools_dir,
                plan_envelope_metadata={"_pressure_source_type": source} if source else {},
                profile=profile, signer_key_fp=signer.fingerprint,
            )
            report["memory_hook"] = str(memory.get("status") or "ok")
            # The cycle's transition for the same record (`memory_hook_recorded`).
            AutonomyStateReducer.transition(
                tools_dir, cycle_id=cycle_id, phase="memory_hook_recorded",
                status=report["memory_hook"], profile=profile,
                details={"plan_id": plan_id, "convention_recorded": memory.get("convention_recorded"),
                         "knowledge_signer": signer.status, "signer_key_fp": signer.fingerprint},
            )
        except memory_hook_runtime_faults() as exc:
            # The cycle's guard (B1): a runtime fault of the memory pillar is a
            # row, never the end of the delivery that follows it.
            append_tools_governance(
                tools_dir, "memory_hook_failed",
                {"cycle_id": cycle_id, "error_class": type(exc).__name__, "error_message": str(exc)[:500]},
                bypass_profile_gate=True,
            )
            report["memory_hook"] = f"failed:{type(exc).__name__}"
        if signer.fingerprint is not None:
            # B7 — rows an earlier run disclosed as needs_signing are completed
            # under this run's signer, as the cycle's converged branch does.
            replay: dict[str, Any] = {"status": "not_attempted"}
            try:
                replay.update(hook.complete_pending_observations(
                    base_dir=tools_dir, signer_cycle_id=signer.cycle_id,
                    signer_key_fp=signer.fingerprint, report=replay,
                ))
            except Exception as exc:  # noqa: BLE001 — the cycle's own guard on the replay
                replay.update({"status": "callback_error", "error_class": type(exc).__name__})
            report["memory_completion"] = replay.get("status")
        if not v9_runner.delivers_implementation:
            report["delivery"] = {"left_for_cycle_sweep": LEFT_NO_AUTHORITY}
            return report
        worst_case = staging_worst_case_seconds(plan_id=plan_id, tools_dir=tools_dir)
        remaining = [value for value in (
            None if drain_remaining is None else drain_remaining(),
            None if deadline_epoch is None else deadline_epoch - now(),
        ) if value is not None]
        if remaining and min(remaining) < worst_case:
            report["delivery"] = {"left_for_cycle_sweep": LEFT_WINDOW, "worst_case_seconds": worst_case,
                                  "remaining_seconds": int(min(remaining))}
            return report
        report["delivery"] = deliver_converged_plan(
            runner=v9_runner,
            cycle_id=cycle_id,
            plan_id=plan_id,
            workspace_root=workspace_root,
            base_dir=tools_dir,
            cross_review_summary={
                "revision_id": convergence_result.get("convergence_id") or plan_id,
                "rounds_count": convergence_result.get("rounds_count"),
                "request_ids": list(convergence_result.get("request_ids") or []),
            },
            profile=profile,
            origin=ORIGIN_EXECUTOR,
        )
    return report


__all__ = [
    "FUNNEL_UNATTRIBUTED_KIND",
    "LEFT_NO_AUTHORITY",
    "LEFT_WINDOW",
    "STAGING_GIT_CALLS",
    "plan_pressure_source",
    "record_funnel",
    "run_executor_converged_seam",
    "staging_worst_case_seconds",
]
