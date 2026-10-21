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
row and :func:`feedback_counts_by_dial` the one tp/fp count over rows, both
shared by the recommendation producer and the Beta-Binomial source
calibration (ORPHAN-HIGH-627) so the two cannot disagree about attribution
or about how many labels a dial has;
:func:`tool_pressure_weights` folds the actuator's ledger
(``calibration_actuator``) into the current value of each tool dial.
"""
from __future__ import annotations

from pathlib import Path
from typing import Any, Iterable, Mapping

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


def feedback_counts_by_dial(
    feedback_rows: Iterable[Mapping[str, Any]],
) -> dict[tuple[str, str], dict[str, int]]:
    """tp/fp per dial, from the labelled feedback rows.

    The one count both views of the ledger use (the recommendation pass and
    the Beta-Binomial source calibration): sharing only :func:`feedback_dial`
    left each view its own copy of the verdict reading and the buckets, free
    to drift apart on how many labels a dial has. Insertion order is first
    sighting, so a caller that wants a stable order sorts.
    """
    by_dial: dict[tuple[str, str], dict[str, int]] = {}
    for row in feedback_rows:
        dial = feedback_dial(row)
        if dial is None:
            continue
        verdict = str(row.get("verdict") or row.get("kind") or "")
        bucket = by_dial.setdefault(dial, {"tp": 0, "fp": 0})
        if verdict == "true_positive":
            bucket["tp"] += 1
        elif verdict == "false_positive":
            bucket["fp"] += 1
    return by_dial


#: The judge id the gold-set replay seeds its ground-truth anchors under
#: (``judge_replay.replay_judges_on_goldset``).
GOLDSET_REPLAY_JUDGE_ID = "goldset-replay"


def moves_auto_applied_dial(row: Mapping[str, Any]) -> bool:
    """May this labelled row move a dial the actuator AUTO-APPLIES?

    Review of #1896 (HIGH). One ``judge replay --tool-id tool-x`` moved the
    actuator's fresh labels from {0, 0} to {tp 2, fp 1, labels 3}: the
    replay's seeded anchors and its judges' verdicts were counted as new
    evidence about the tool, although a replay re-asks questions whose
    answers are already known — it measures the JUDGES, never the adapter.
    The cycle phase's replay had the same effect before the verb existed.

    The rule, decided once here for every auto-applied dial:
      * only a verdict about a FINDING moves a dial — a belief verdict
        (``judgment_subject == "belief"``) is about the belief, not the tool;
      * nothing from a replay moves a dial — no ``replay:`` judgment group,
        no ``goldset-replay`` seed;
      * only GROUND TRUTH moves a dial: a human label, or an ai_consensus
        row that is an anchor (``feedback_store.is_ground_truth_row``). A
        single ``ai_judge`` verdict, or a 2-judge consensus nobody tried to
        refute, is an opinion, and an auto-applied dial is the last place to
        let an opinion act without a person.
    """
    from .feedback_store import JUDGMENT_SUBJECT_FINDING, is_ground_truth_row, judgment_subject_of
    from .judge_replay import REPLAY_GROUP_PREFIX

    # A verdict about a BELIEF (an operator settling a belief escalation,
    # recorded with the source tool's id) says nothing about the adapter's
    # precision; the adapter-precision lanes already exclude it.
    if judgment_subject_of(dict(row)) != JUDGMENT_SUBJECT_FINDING:
        return False
    group = row.get("judgment_group_id")
    if isinstance(group, str) and group.startswith(REPLAY_GROUP_PREFIX):
        return False
    if row.get("judge_id") == GOLDSET_REPLAY_JUDGE_ID:
        return False
    return is_ground_truth_row(dict(row))


def auto_applied_rows(base_dir: str | Path | None) -> list[dict[str, Any]]:
    from .ledger import load_declared_jsonl
    from .tool_registry import ensure_tools_dir_readonly

    root = ensure_tools_dir_readonly(base_dir)
    path = root.joinpath(*AUTO_APPLIED_PATH) if root is not None else None
    if path is None or not path.is_file():
        return []
    return load_declared_jsonl(path, expected_surface=AUTO_APPLIED_SURFACE)


def security_classes(base_dir: str | Path | None) -> dict[str, bool]:
    """tool_id -> security class, for every row of the live tool registry.

    Review of #1829 (HIGH-4) — a security adapter's dial (its findings guard
    tenant isolation, authorization, the agent harness's security boundary
    or the tenant-schema invariant) is RAISE-ONLY with a floor of neutral: a
    precise security adapter may gain attention, and making one quieter is
    an operator's act (``pressure weight-override`` territory), never the
    actuator's. ARIA-LOW-533 — which adapters those are was a hand-kept id
    list here, pinned only by id words; it is now each adapter's declared
    ``security_class`` (its manifest, carried into the registry row by the
    manifest sync), read by ``tool_registry.is_security_class``.
    """
    from .tool_registry import is_security_class, list_tools

    return {str(row.get("tool_id")): is_security_class(row) for row in list_tools(base_dir=base_dir)}


def is_raise_only(tool: str, classes: Mapping[str, bool]) -> bool:
    """May the actuator never lower this tool's dial? True for a security
    class tool and for a tool with no registry row to declare otherwise."""
    return classes.get(tool, True)


def dial_bounds(tool: str, classes: Mapping[str, bool]) -> tuple[int, int]:
    """(min, max) of a tool's dial; a raise-only tool's floor is neutral."""
    return (TOOL_DIAL_NEUTRAL if is_raise_only(tool, classes) else TOOL_DIAL_MIN), TOOL_DIAL_MAX


def clamp_dial(tool: str, weight: int, classes: Mapping[str, bool]) -> int:
    low, high = dial_bounds(tool, classes)
    return max(low, min(high, int(weight)))


def tool_pressure_weights(base_dir: str | Path | None) -> dict[str, int]:
    """Current weight of every tool dial an application moved; absent = neutral.

    Clamped on READ as well as on write (review of #1829, M): the ledger is a
    file, and a stray ``to_weight`` of 1000 must not become 20x pressure."""
    rows = auto_applied_rows(base_dir)
    if not rows:
        return {}
    classes = security_classes(base_dir)
    weights: dict[str, int] = {}
    for row in rows:
        tool = str(row["dial"]["name"])
        if row["event"] == "applied":
            weights[tool] = clamp_dial(tool, row["to_weight"], classes)
        elif row["event"] == "reverted":
            weights[tool] = clamp_dial(tool, row["weight"], classes)
    return weights


__all__ = [
    "AUTO_APPLIED_PATH", "AUTO_APPLIED_SURFACE", "SOURCE_DIAL", "clamp_dial", "dial_bounds", "is_raise_only",
    "security_classes", "TOOL_DIAL", "TOOL_DIAL_MAX",
    "TOOL_DIAL_MIN", "TOOL_DIAL_NEUTRAL", "auto_applied_rows", "feedback_counts_by_dial", "feedback_dial",
    "tool_pressure_weights",
    "GOLDSET_REPLAY_JUDGE_ID", "moves_auto_applied_dial",
]
