"""G-1 — the operator's success threshold, expressed so ARIA can measure it.

The operator's words, 2026-08-19: *"eşik şu anki repoda sistemlerin hepsinin
kusursuz organize bağlanması ve kusursuz hizmet vermesi; güvenli,
performanslı, multi-tenant, üretimde olan bir yazılımın endüstriyel şekilde
hatasız olması, üstün kod kalitesi."*

Until now ARIA had no answer to "am I good enough yet". Every bar in the
system was either a process count (30 observe cycles, N clean nights) or a
quality floor scoped to ONE tool (`precision >= 0.85` per adapter). The
acceptance harness even computes a false-positive rate and then gates on
something else. So ARIA could run forever, improving its own throughput,
without anyone — including ARIA — being able to say whether the PRODUCT
was better.

This module is the missing instrument, and it is deliberately thin:

* the CHARTER is data (`aria-config/product_fitness_charter.json`), in the
  shape the repo already uses for operator-owned thresholds
  (`.github/manifests/aria-state-watchdog.json`). Changing what "good"
  means is an operator edit, not a code change;
* every dimension is measured by a gate that ALREADY VOTES on main. A
  dimension may not invent a measurement — if the repository does not
  already check it, the honest verdict is `unknown`, never `green`;
* `unknown` is never `green`. A night that could not read the lanes is a
  night that proves nothing, and the streak resets. That rule is what
  keeps this from becoming a scoreboard ARIA can win by looking away.
"""
from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Protocol

CHARTER_RELATIVE_PATH = ("aria-config", "product_fitness_charter.json")

# A workflow conclusion GitHub reports for a lane that did not fail: the
# same non-blocking vocabulary the merge gate uses, so one definition of
# "did not fail" serves both.
_PASSING_CONCLUSIONS = frozenset({"success", "skipped", "neutral"})


class ChecksReader(Protocol):
    def runs_for_commit(self, sha: str) -> list[dict[str, Any]]: ...


@dataclass(frozen=True)
class DimensionVerdict:
    dimension_id: str
    status: str          # "green" | "red" | "unknown"
    detail: str

    def as_dict(self) -> dict[str, Any]:
        return {"dimension_id": self.dimension_id, "status": self.status, "detail": self.detail}


@dataclass(frozen=True)
class FitnessVerdict:
    status: str          # "green" | "red" | "unknown"
    dimensions: list[DimensionVerdict]
    statement: str

    def as_dict(self) -> dict[str, Any]:
        return {
            "status": self.status,
            "statement": self.statement,
            "dimensions": [d.as_dict() for d in self.dimensions],
        }


def load_charter(workspace_root: str | Path) -> dict[str, Any]:
    path = Path(workspace_root).joinpath(*CHARTER_RELATIVE_PATH)
    if not path.exists():
        raise FileNotFoundError(f"product fitness charter not found: {path}")
    charter = json.loads(path.read_text(encoding="utf-8"))
    if not charter.get("dimensions"):
        raise ValueError("product fitness charter declares no dimensions")
    return charter


def _verdict_for_workflows(
    wanted: list[str], runs: list[dict[str, Any]],
) -> tuple[str, str]:
    """green only when every named lane ran and none failed."""
    by_name: dict[str, str] = {}
    for row in runs:
        name = str(row.get("name") or "")
        if name not in wanted:
            continue
        conclusion = str(row.get("conclusion") or "")
        status = str(row.get("status") or "")
        if status != "completed":
            by_name.setdefault(name, "running")
            continue
        # Latest row wins: `runs_for_commit` returns newest first, so an
        # earlier (re-run) failure must not outvote a later success.
        by_name.setdefault(name, conclusion or "unknown")
    missing = [name for name in wanted if name not in by_name]
    if missing:
        return "unknown", f"lane did not report: {', '.join(sorted(missing))}"
    failed = [
        name for name, conclusion in by_name.items()
        if conclusion not in _PASSING_CONCLUSIONS
    ]
    if failed:
        return "red", f"failing: {', '.join(sorted(failed))}"
    return "green", f"all {len(wanted)} lane(s) passed"


def evaluate_fitness(
    *,
    workspace_root: str | Path,
    head_sha: str,
    reader: ChecksReader,
) -> FitnessVerdict:
    """Judge the product against the charter at one commit.

    Reads ONLY what already votes on main. A dimension whose lanes did not
    report is `unknown` — a distinction the whole instrument rests on,
    because a system that scores itself green when it cannot see is worse
    than one with no score at all.
    """
    charter = load_charter(workspace_root)
    try:
        runs = reader.runs_for_commit(head_sha)
    except Exception as exc:  # noqa: BLE001 — an unreadable lane is unknown, not green
        runs = []
        read_error = f"checks unreadable: {type(exc).__name__}"
    else:
        read_error = ""

    verdicts: list[DimensionVerdict] = []
    for dimension in charter["dimensions"]:
        dimension_id = str(dimension.get("id") or "")
        measured_by = str(dimension.get("measured_by") or "")
        if read_error:
            verdicts.append(DimensionVerdict(dimension_id, "unknown", read_error))
            continue
        if measured_by != "workflow_conclusions":
            # An unimplemented measurement is unknown BY NAME. The charter
            # may declare a dimension before the instrument exists; it may
            # never be counted as satisfied for that reason.
            verdicts.append(DimensionVerdict(
                dimension_id, "unknown", f"no instrument for measured_by={measured_by!r}",
            ))
            continue
        status, detail = _verdict_for_workflows(
            [str(name) for name in dimension.get("workflows") or []], runs,
        )
        verdicts.append(DimensionVerdict(dimension_id, status, detail))

    if any(v.status == "red" for v in verdicts):
        overall = "red"
    elif any(v.status == "unknown" for v in verdicts):
        overall = "unknown"
    else:
        overall = "green"
    return FitnessVerdict(
        status=overall, dimensions=verdicts,
        statement=str(charter.get("statement") or ""),
    )


def streak_from_history(
    rows: list[dict[str, Any]], *, required: int,
) -> dict[str, Any]:
    """Consecutive green nights, newest row last.

    `unknown` breaks the streak exactly like `red`: the threshold is
    "proven good for N nights", and a night that proved nothing did not
    prove good.
    """
    streak = 0
    for row in reversed(rows):
        if str(row.get("status")) != "green":
            break
        streak += 1
    return {
        "consecutive_green_nights": streak,
        "required": required,
        "threshold_met": streak >= required,
    }
