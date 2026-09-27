"""The autonomy orchestrator's last exits, read as one streak — for the doctor.

WHY. Between 2026-08-21 and 2026-09-04 every autonomy orchestrator run on the
live store exited ``cycle_failed`` — four in a row (``autonomy_orchestrator_
exit`` rows in `governance.jsonl`) — and the orchestrator fails closed on a
failed cycle, so planner dispatch, the convergence drainer and every phase
behind them never ran once in two weeks. `aria-kernel doctor` had no organ
that looked: integrity verified, the artifact index verified (after
compaction), breakers were closed, the lease was free, and the report read
HEALTHY over a store that had not planned anything since 2026-08-19. Each
failed cycle also wrote its own cause into `autonomy_state.jsonl`
(``cycle_completed`` → ``details.summary``: ``failed_phases``,
``runtime_status``, ``non_ok_tools``, ``artifact_integrity``) — nothing put
the verdict and the cause on one line.

WHAT. `read_orchestrator_exit_streak` returns the last ``window`` exits
(newest first), the failed cycles those exits COVER with their recorded
cause, and the ``mission_candidate_refused`` histogram of those cycles. The
doctor's ``orchestrator`` check reads this and nothing else: two or more
exits that are ALL ``cycle_failed`` is a FAIL naming the causes; a newest
exit of ``cycle_failed`` is otherwise a WARN (one bad night is weather, a
streak is a fault); fewer than two exits with the newest clean is "ok —
insufficient_history".

WHICH CYCLES AN EXIT COVERS. One orchestrator run can complete several
cycles before it exits (``max_cycles``), and a run that dies ``cycle_failed``
reports ``cycles_completed: 0`` although its failed cycle DID write a
``cycle_completed`` row — so neither "the last ``window`` cycle rows" nor
"the exits' ``cycles_completed`` summed" is the set of cycles the windowed
exits cover; the first revision used the former and, with a three-cycle run
inside the window, either missed an older run's failed cycle or reported
one from before the window. The two ledgers share one clock: a run's cycle
rows are recorded before its exit row and after the previous run's exit, so
the covered cycles are those with ``recorded_at`` in
``(previous_exit.ts, newest_exit.ts]``, where ``previous_exit`` is the exit
just older than the window (none → every cycle up to the newest exit). The
bracket is half-open on the older side: the failed cycle and its exit share
a second (measured on the live store: ``2026-09-04T11:43:50`` for both), and
a cycle recorded in the same second as the PREVIOUS run's exit cannot happen
— a cycle takes minutes. A run that announced no exit (a profile that does
not announce, or a hard kill) folds into the next announced one; a cycle
recorded after the newest exit belongs to a run that has not exited and is
not part of any streak.

The refusal histogram counts rows whose ``cycle_id`` is one of the covered
failed cycles. `mission.adopt_task_candidates` discloses a refusal ONCE per
claim (reason, source, source_id, block tokens, owner), so the histogram
shows the refusals that first appeared during those cycles — a standing
block shows on the night it appeared, not on every night after.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Any

from .autonomy_state import autonomy_state_path
from .governance_reader import read_governance_rows_reverse
from .ledger import load_declared_jsonl
from .tool_registry import parse_utc_stamp

EXIT_KIND = "autonomy_orchestrator_exit"
REFUSAL_KIND = "mission_candidate_refused"
CYCLE_FAILED = "cycle_failed"
DEFAULT_EXIT_WINDOW = 3
# How many refusal rows to read back for the histogram. A refusal claim is
# disclosed once (single digits on the live store across three weeks), so
# this covers the window without walking the whole ledger.
_REFUSAL_READBACK = 200


@dataclass(frozen=True)
class OrchestratorExitStreak:
    window: int
    exits: tuple[dict[str, Any], ...]
    failed_cycles: tuple[dict[str, Any], ...]
    refusals_by_reason: dict[str, int] = field(default_factory=dict)
    refusals_by_owner: dict[str, int] = field(default_factory=dict)

    @property
    def all_failed(self) -> bool:
        return len(self.exits) >= 2 and all(
            exit_row["exit_reason"] == CYCLE_FAILED for exit_row in self.exits
        )

    @property
    def last_failed(self) -> bool:
        return bool(self.exits) and self.exits[0]["exit_reason"] == CYCLE_FAILED

    def to_dict(self) -> dict[str, Any]:
        return {
            "window": self.window,
            "exits": list(self.exits),
            "failed_cycles": list(self.failed_cycles),
            "refusals_by_reason": dict(self.refusals_by_reason),
            "refusals_by_owner": dict(self.refusals_by_owner),
        }


def read_orchestrator_exit_streak(
    tools_dir: str | Path, *, window: int = DEFAULT_EXIT_WINDOW,
) -> OrchestratorExitStreak:
    root = Path(tools_dir)
    # ``window + 1``: the extra, older exit is the bracket's lower bound and
    # is not itself part of the streak.
    exit_rows = read_governance_rows_reverse(
        base_dir=root, limit=window + 1, kind_filter=(EXIT_KIND,),
    )
    exits = tuple(
        {
            "recorded_at": row.get("ts"),
            "exit_reason": str((row.get("details") or {}).get("exit_reason") or ""),
            "cycles_completed": (row.get("details") or {}).get("cycles_completed"),
        }
        for row in exit_rows[:window]
    )
    newest_exit_at = _stamp(exit_rows[0].get("ts")) if exit_rows else None
    previous_exit_at = _stamp(exit_rows[window].get("ts")) if len(exit_rows) > window else None
    failed_cycles = tuple(_failed_cycles(root, newest_exit_at, previous_exit_at))
    cycle_ids = {cycle["cycle_id"] for cycle in failed_cycles}
    by_reason: dict[str, int] = {}
    by_owner: dict[str, int] = {}
    for row in read_governance_rows_reverse(
        base_dir=root, limit=_REFUSAL_READBACK, kind_filter=(REFUSAL_KIND,),
    ):
        details = row.get("details") or {}
        if details.get("cycle_id") not in cycle_ids:
            continue
        reason = str(details.get("reason") or "")
        by_reason[reason] = by_reason.get(reason, 0) + 1
        owner = details.get("owner")
        if isinstance(owner, str) and owner:
            by_owner[owner] = by_owner.get(owner, 0) + 1
    return OrchestratorExitStreak(
        window=window,
        exits=exits,
        failed_cycles=failed_cycles,
        refusals_by_reason=by_reason,
        refusals_by_owner=by_owner,
    )


def _stamp(raw: Any) -> datetime | None:
    return parse_utc_stamp(raw) if isinstance(raw, str) else None


def _failed_cycles(
    root: Path, newest_exit_at: datetime | None, previous_exit_at: datetime | None,
) -> list[dict[str, Any]]:
    """The non-ok ``cycle_completed`` rows recorded in
    ``(previous_exit_at, newest_exit_at]``, newest first, each reduced to the
    cause the orchestrator recorded for it. No exit → no covered cycles."""
    if newest_exit_at is None:
        return []
    path = autonomy_state_path(root)
    if not path.exists():
        return []
    rows = load_declared_jsonl(path, expected_surface="autonomy_state")
    causes: list[dict[str, Any]] = []
    for row in reversed(rows):
        # ARIA-HIGH-098 — a ``degraded`` cycle completed and never causes a
        # ``cycle_failed`` exit; listing it among the causes of one would
        # name a tool as the reason a night died when the night lived. The
        # doctor's ``tools`` organ is where a degraded tool is reported.
        if row.get("phase") != "cycle_completed" or row.get("status") in {"ok", "degraded"}:
            continue
        recorded_at = _stamp(row.get("recorded_at"))
        if recorded_at is None or recorded_at > newest_exit_at:
            continue
        if previous_exit_at is not None and recorded_at <= previous_exit_at:
            continue
        summary = (row.get("details") or {}).get("summary") or {}
        integrity = summary.get("artifact_integrity") or {}
        causes.append({
            "cycle_id": row.get("cycle_id"),
            "recorded_at": row.get("recorded_at"),
            "runtime_status": summary.get("runtime_status"),
            "error": summary.get("error"),
            "failed_phases": [
                {"phase": phase.get("phase"), "error": phase.get("error")}
                for phase in summary.get("failed_phases") or []
                if isinstance(phase, dict)
            ],
            "non_ok_tools": [
                {"tool_id": tool.get("tool_id"), "status": tool.get("status")}
                for tool in summary.get("non_ok_tools") or []
                if isinstance(tool, dict)
            ],
            "artifact_integrity": {
                "status": integrity.get("status"),
                "issue_count": len(integrity.get("issues") or []),
            },
        })
    return causes


__all__ = [
    "CYCLE_FAILED",
    "DEFAULT_EXIT_WINDOW",
    "EXIT_KIND",
    "OrchestratorExitStreak",
    "read_orchestrator_exit_streak",
]
