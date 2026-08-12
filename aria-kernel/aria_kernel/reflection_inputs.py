"""C5/E8 — carry every producer phase's output into post-drain reflection.

`run_reflection` accepts eight producer kwargs, and the daily report renders
a section for each — but the orchestrator's five post-drain call sites passed
only `convergence_result`/`review_result`, and `defer_reflection=True` skips
the in-cycle reflection that used to carry the calibration trio. Net effect:
on the autonomy lane (the ONLY lane that will run nightly) the Pedagogy,
Skill-Genesis, Calibration, Recommendation, Proactive and Cycle-Runner
sections could NEVER render — the sections existed, their producers existed,
and no call site connected them.

WHY a module and not five inline blocks: five call sites each assembling the
same six kwargs is five chances to drift (exactly how the defect was born —
one call site gained `convergence_result`, the others never caught up). One
producer-kwargs builder, called by all five, cannot drift.
"""
from __future__ import annotations

from pathlib import Path
from typing import Any

from .pedagogy_lint import run_pedagogy_lint

__all__ = ["pedagogy_lint_snapshot", "producer_reflection_kwargs"]

# Mirrors the pedagogy_lint CLI defaults (pedagogy_lint.main). WHY warn-mode
# (strict=False): reflection is telemetry, not a gate — the strict gate lives
# in CI. A violation here must render in the daily report, not stop the night.
_AGENTS_DIR = ".claude/agents"
_ALLOWLIST = "tests/invariants/agent-pedagogy.allowlist.json"


def pedagogy_lint_snapshot(
    workspace_root: str | Path | None,
) -> dict[str, Any] | None:
    """Run the warn-mode pedagogy lint once per cycle and return its dict.

    Returns None (reflection renders the section as legitimately-skipped)
    when the workspace has no agents directory or the scan itself fails —
    a broken lint must not cost the reflection row that reports on
    everything else.
    """
    if workspace_root is None:
        return None
    root = Path(workspace_root)
    agents_dir = root / _AGENTS_DIR
    if not agents_dir.is_dir():
        return None
    allowlist = root / _ALLOWLIST
    try:
        report = run_pedagogy_lint(
            agents_dir=agents_dir,
            allowlist_path=allowlist if allowlist.is_file() else None,
            strict=False,
        )
    except (OSError, ValueError) as _exc:  # noqa: F841 — advisory telemetry
        return None
    return report.to_dict()


def producer_reflection_kwargs(
    *,
    cycle_summary: dict[str, Any],
    cycle_result: dict[str, Any] | None,
    pedagogy_lint_result: dict[str, Any] | None,
) -> dict[str, Any]:
    """The six producer kwargs for `run_reflection`, from what the
    orchestrator already holds.

    * calibration/recommendation/proactive live in `cycle_result["phases"]`
      (the enterprise cycle ran them; `defer_reflection=True` merely skipped
      the in-cycle reflection that used to carry them).
    * skill_genesis and the bounded cycle summary live on `cycle_summary`
      (written by the drainer phase and the cycle-runner phase respectively —
      including the crash path, which writes an explicit failed summary, so
      a crashed cycle still reports itself instead of vanishing).
    """
    phases = (cycle_result or {}).get("phases")
    phases = phases if isinstance(phases, dict) else {}
    return {
        "calibration_result": phases.get("judge_calibration") or None,
        "recommendation_result": phases.get("calibration_recommendation") or None,
        "proactive_result": phases.get("proactive_priority") or None,
        # C6 — the sealed CycleRow is frozen+slotted and cannot carry
        # judge_replay; the reflection row is its only honest transport.
        "judge_replay_result": phases.get("judge_replay") or None,
        "skill_genesis_result": cycle_summary.get("skill_genesis") or None,
        "cycle_runner_result": cycle_summary.get("cycle") or None,
        "pedagogy_lint_result": pedagogy_lint_result,
    }
