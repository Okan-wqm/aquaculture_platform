"""ARIA-HIGH-370 — the dials calibration feedback can move, and their current values.

WHY. ``calibration._pressure_weight_recommendations`` keyed every labelled
feedback row by ``metadata.pressure_source`` falling back to ``tool_id`` and
read the row's "current weight" from the pressure-source table with a
default of 50. No producer writes ``metadata.pressure_source`` (measured on
the runner store 2026-10-07: 0 of 245 labelled rows), so every key was an
adapter tool id that is not a pressure source, every ``current_weight`` was
the phantom default 50, and ``record_weight_override`` refuses an unknown
source: 36 recommendation rows over 36 cycles named four adapters
(``tenant-scoping-adapter`` precision 0.19 on 58 labels, 50 → 40) and nothing
could ever apply one. The recommendations were not empty; they pointed at a
dial that did not exist.

WHAT. A labelled row judges one finding of one adapter, and the only path by
which an adapter's findings reach the pressure table is the
``shadow_raw_delta`` pressure that carries its ``tool_id``. That is the dial
the label measures: :data:`TOOL_DIAL`, one weight per tool, neutral at
:data:`TOOL_DIAL_NEUTRAL`, scaling that tool's raw-delta pressures
(``pressure.run_pressure``). :func:`feedback_dial` is the one reading of a
row, shared by the recommendation producer and the Beta-Binomial source
calibration (ORPHAN-HIGH-627) so the two cannot disagree about attribution;
:func:`tool_pressure_weights` folds the actuator's ledger
(``calibration_actuator``) into the current value of each tool dial.
"""
from __future__ import annotations

from pathlib import Path
from typing import Any, Mapping

TOOL_DIAL = "tool_pressure_weight"
SOURCE_DIAL = "pressure_source"
TOOL_DIAL_NEUTRAL = 50
#: Declared bounds of the tool dial: a tool's raw-delta pressure moves
#: between 0.4x and 1.6x of the shadow_raw_delta weight, never off the table
#: and never above a confirmed in-repo violation (tool_quarantine, 90).
TOOL_DIAL_MIN = 20
TOOL_DIAL_MAX = 80
AUTO_APPLIED_PATH = ("calibration", "auto-applied.jsonl")
AUTO_APPLIED_SURFACE = "calibration_auto_applied"


def feedback_dial(row: Mapping[str, Any]) -> tuple[str, str] | None:
    """(dial kind, name) a labelled row measures, or None when it names neither."""
    from .pressure import SOURCE_WEIGHTS

    source = (row.get("metadata") or {}).get("pressure_source")
    if isinstance(source, str) and source in SOURCE_WEIGHTS:
        return SOURCE_DIAL, source
    tool = row.get("tool_id")
    if isinstance(tool, str) and tool.strip():
        return TOOL_DIAL, tool.strip()
    return None


def auto_applied_rows(base_dir: str | Path | None) -> list[dict[str, Any]]:
    from .ledger import load_declared_jsonl
    from .tool_registry import ensure_tools_dir_readonly

    root = ensure_tools_dir_readonly(base_dir)
    path = root.joinpath(*AUTO_APPLIED_PATH) if root is not None else None
    if path is None or not path.is_file():
        return []
    return load_declared_jsonl(path, expected_surface=AUTO_APPLIED_SURFACE)


def tool_pressure_weights(base_dir: str | Path | None) -> dict[str, int]:
    """Current weight of every tool dial an application moved; absent = neutral."""
    weights: dict[str, int] = {}
    for row in auto_applied_rows(base_dir):
        if row["event"] == "applied":
            weights[str(row["dial"]["name"])] = int(row["to_weight"])
        elif row["event"] == "reverted":
            weights[str(row["dial"]["name"])] = int(row["weight"])
    return weights


__all__ = [
    "AUTO_APPLIED_PATH", "AUTO_APPLIED_SURFACE", "SOURCE_DIAL", "TOOL_DIAL", "TOOL_DIAL_MAX",
    "TOOL_DIAL_MIN", "TOOL_DIAL_NEUTRAL", "auto_applied_rows", "feedback_dial", "tool_pressure_weights",
]
