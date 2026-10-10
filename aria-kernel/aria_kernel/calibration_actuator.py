"""ARIA-HIGH-370 — bounded calibration auto-apply on the tool dial.

WHY. ``recommend_calibration`` has produced a recommendation every cycle and
nothing applied one: 36 rows on the runner store (2026-10-07), the same four
adapter weights recommended 36 times. The recommendations named a dial that
did not exist (``calibration_dials``); with the dial in place, an unapplied
recommendation is a measurement ARIA takes and throws away.

WHAT THE DIAL IS, AND WHAT MEASURES IT. Review of #1829 (HIGH-4): the first
version called its window check a "bet" on an outcome, while the window
counted labels and the dial scaled pressure. There is no outcome metric for
the pressure a dial scales — the source-effectiveness ledger is per pressure
SOURCE, not per tool, and has recorded 0 merges — so this module claims
none. The tool dial is the trust weight of one tool's raw findings, and the
measure is the labelled precision of those findings: a step is taken, and
undone, only on that measure, read through a Wilson interval
(:data:`WILSON_Z`, 90 %) instead of a point estimate.

RULES.

* **Fresh evidence per step.** A step needs :data:`MIN_LABELS` labels for the
  tool recorded after its previous application (all labels before the first),
  and their interval must sit on the step's side: a cut needs the upper bound
  at or below :data:`CUT_UPPER`, a raise needs the lower bound at or above
  :data:`RAISE_LOWER`. The same labels never justify two steps, so "held"
  never ratchets into another cut.
* **Hysteresis.** An applied step is undone only when fresh labels put the
  OPPOSITE bound past the line: a cut when their lower bound exceeds
  ``CUT_UPPER``, a raise when their upper bound falls below ``RAISE_LOWER``.
  At a true precision of 0.9, ten fresh labels undo a raise with probability
  below 0.002 (the point-estimate rule of the first version: 0.41).
* **Window timeout.** A window that does not reach ``MIN_LABELS`` within
  :data:`WINDOW_TIMEOUT` closes as ``held_timeout``: the weight stays and,
  by the fresh-evidence rule, no further step is taken until labels arrive.
* **Cooldown.** After an undo the dial takes no step for :data:`COOLDOWN`.
* **Bounds.** ``calibration_dials.dial_bounds``; at most
  :data:`MAX_STEP_PER_CYCLE` per step, one step per dial per cycle.
* **Security tools** (``calibration_dials.SECURITY_TOOLS``) are raise-only
  with a floor of neutral: a cut is surfaced as an operator's act.
* **Operator-owned dials.** A pressure-source recommendation is never applied;
  that table belongs to ``pressure weight-override`` and the Beta-Binomial
  source calibration (ORPHAN-HIGH-627).
* **Profile.** Nothing is written unless the active profile may commit a
  change (``ACTION_PERMISSIONS["change_committed"]``).

Everything not applied stays ``recommendation_only`` and is surfaced with its
reason.
"""
from __future__ import annotations

import hashlib
import json
import math
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Mapping

from .calibration_dials import (
    AUTO_APPLIED_PATH,
    AUTO_APPLIED_SURFACE,
    SECURITY_TOOLS,
    TOOL_DIAL,
    TOOL_DIAL_NEUTRAL,
    auto_applied_rows,
    dial_bounds,
    feedback_dial,
    moves_auto_applied_dial,
)

MAX_STEP_PER_CYCLE = 10
MIN_LABELS = 10
WILSON_Z = 1.645
CUT_UPPER = 0.5
RAISE_LOWER = 0.75
WINDOW_TIMEOUT = timedelta(days=21)
COOLDOWN = timedelta(days=14)


def wilson(tp: int, labels: int) -> tuple[float, float]:
    """The 90 % Wilson interval of tp / labels; (0, 1) without labels."""
    if labels <= 0:
        return 0.0, 1.0
    p, z2 = tp / labels, WILSON_Z * WILSON_Z
    centre = (p + z2 / (2 * labels)) / (1 + z2 / labels)
    half = WILSON_Z * math.sqrt(p * (1 - p) / labels + z2 / (4 * labels * labels)) / (1 + z2 / labels)
    return max(0.0, centre - half), min(1.0, centre + half)


def _labels(feedback: list[dict[str, Any]], tool: str, since: datetime | None) -> dict[str, Any]:
    """The tool's labels recorded after ``since`` (all of them for None); a
    row whose time does not parse is never placed after a step."""
    from .tool_registry import parse_utc_stamp

    tp = fp = 0
    for row in feedback:
        if feedback_dial(row) != (TOOL_DIAL, tool) or not moves_auto_applied_dial(row):
            continue
        stamp = parse_utc_stamp(str(row.get("recorded_at") or ""))
        if since is not None and (stamp is None or stamp <= since):
            continue
        verdict = str(row.get("verdict") or "")
        tp += verdict == "true_positive"
        fp += verdict == "false_positive"
    low, high = wilson(tp, tp + fp)
    return {"tp": tp, "fp": fp, "labels": tp + fp, "lower": round(low, 3), "upper": round(high, 3),
            "since": since.isoformat() if since is not None else None}


def _dial_state(rows: list[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    """Per tool: its open application, its last application time, its cooldown end."""
    from .tool_registry import parse_utc_stamp

    closed = {row["application_id"] for row in rows if row["event"] != "applied"}
    state: dict[str, dict[str, Any]] = {}
    for row in rows:
        entry = state.setdefault(str(row["dial"]["name"]), {"open": None, "last_applied": None, "cooldown_until": None})
        if row["event"] == "applied":
            entry["last_applied"] = parse_utc_stamp(str(row["applied_at"]))
            entry["open"] = row if row["application_id"] not in closed else None
        elif row["event"] == "reverted":
            entry["cooldown_until"] = parse_utc_stamp(str(row["cooldown_until"]))
    return state


def _undo(application: Mapping[str, Any], fresh: Mapping[str, Any]) -> bool:
    if application["direction"] == "down":
        return float(fresh["lower"]) > CUT_UPPER
    return float(fresh["upper"]) < RAISE_LOWER


def _surface(rec: Mapping[str, Any], reason: str) -> dict[str, Any]:
    return {"dial": rec.get("dial"), "name": rec.get("source"), "current_weight": rec.get("current_weight"),
            "recommended_weight": rec.get("recommended_weight"), "status": "recommendation_only", "reason": reason}


def _refusal(rec: Mapping[str, Any], entry: Mapping[str, Any], fresh: Mapping[str, Any], now: datetime,
             judged: set[str]) -> str | None:
    """None when the recommendation may apply; else why it stays advice."""
    tool = str(rec.get("source"))
    if rec.get("dial") != TOOL_DIAL:
        return "operator_owned_dial"
    current, target = int(rec["current_weight"]), int(rec["recommended_weight"])
    if tool in SECURITY_TOOLS and target < current:
        return "security_tool_cut_is_operator_act"
    if entry.get("open") is not None:
        return "window_open"
    if tool in judged:
        return "judged_this_cycle"
    if entry.get("cooldown_until") is not None and now < entry["cooldown_until"]:
        return "cooldown_after_undo"
    low, high = dial_bounds(tool)
    if not low <= target <= high:
        return "outside_declared_bounds"
    if abs(target - current) > MAX_STEP_PER_CYCLE:
        return "step_exceeds_cycle_limit"
    if fresh["labels"] < MIN_LABELS:
        return "too_few_fresh_labels"
    if (target < current and fresh["upper"] > CUT_UPPER) or (target > current and fresh["lower"] < RAISE_LOWER):
        return "interval_does_not_support_step"
    return None


def apply_bounded_calibration(
    *, recommendation: Mapping[str, Any], base_dir: str | Path | None, cycle_id: str,
    now: datetime | None = None,
) -> dict[str, Any]:
    """Judge open applications, apply the admissible recommendations, surface the rest."""
    from .feedback_store import load_feedback
    from .ledger import append_declared_jsonl
    from .runtime_profile import ACTION_PERMISSIONS, get_profile
    from .tool_registry import ensure_tools_dir

    recs = list(recommendation.get("pressure_weight_recommendations") or [])
    profile = get_profile(base_dir=base_dir)
    if profile not in ACTION_PERMISSIONS["change_committed"]:
        return {"status": "withheld_by_profile", "profile": profile, "applied": [], "judged": [],
                "surfaced": [_surface(rec, "profile_may_not_commit") for rec in recs]}
    root = ensure_tools_dir(base_dir)
    path = root.joinpath(*AUTO_APPLIED_PATH)
    path.parent.mkdir(parents=True, exist_ok=True)
    at = now or datetime.now(timezone.utc)
    stamp = at.replace(microsecond=0).isoformat()

    def append(row: dict[str, Any]) -> dict[str, Any]:
        return append_declared_jsonl(path, {"schema_version": 1, "cycle_id": cycle_id, "recorded_at": stamp, **row},
                                     expected_surface=AUTO_APPLIED_SURFACE)

    feedback = load_feedback(base_dir=root)
    judged: list[dict[str, Any]] = []
    for tool, entry in _dial_state(auto_applied_rows(root)).items():
        application = entry["open"]
        if application is None:
            continue
        fresh = _labels(feedback, tool, entry["last_applied"])
        common = {"application_id": application["application_id"], "dial": application["dial"], "window": fresh}
        if fresh["labels"] >= MIN_LABELS and _undo(application, fresh):
            judged.append(append({"event": "reverted", "weight": application["from_weight"],
                                  "cooldown_until": (at + COOLDOWN).replace(microsecond=0).isoformat(), **common}))
        elif fresh["labels"] >= MIN_LABELS:
            judged.append(append({"event": "held", "weight": application["to_weight"], **common}))
        elif entry["last_applied"] is not None and at - entry["last_applied"] >= WINDOW_TIMEOUT:
            judged.append(append({"event": "held_timeout", "weight": application["to_weight"], **common}))
    state = _dial_state(auto_applied_rows(root))
    judged_tools = {str(row["dial"]["name"]) for row in judged}
    applied: list[dict[str, Any]] = []
    surfaced: list[dict[str, Any]] = []
    for rec in recs:
        tool = str(rec.get("source"))
        entry = state.get(tool, {})
        fresh = _labels(feedback, tool, entry.get("last_applied"))
        refusal = _refusal(rec, entry, fresh, at, judged_tools)
        if refusal is not None:
            surfaced.append({**_surface(rec, refusal), "fresh_labels": fresh})
            continue
        current, target = int(rec["current_weight"]), int(rec["recommended_weight"])
        evidence = {"recommendation_ledger_hash": recommendation.get("ledger_hash"),
                    "recommendation_cycle_id": recommendation.get("cycle_id"), "fresh_labels": fresh}
        digest = hashlib.sha256(json.dumps([tool, current, target, stamp, evidence], sort_keys=True).encode())
        low, high = dial_bounds(tool)
        applied.append(append({
            "event": "applied", "application_id": "calib:" + digest.hexdigest()[:24],
            "dial": {"kind": TOOL_DIAL, "name": tool}, "from_weight": current, "to_weight": target,
            "direction": "down" if target < current else "up", "applied_at": stamp, "evidence": evidence,
            "bounds": {"min": low, "max": high, "neutral": TOOL_DIAL_NEUTRAL, "max_step_per_cycle": MAX_STEP_PER_CYCLE},
        }))
        judged_tools.add(tool)
    return {"status": "acted", "profile": profile, "applied": applied, "judged": judged, "surfaced": surfaced}


__all__ = [
    "COOLDOWN", "CUT_UPPER", "MAX_STEP_PER_CYCLE", "MIN_LABELS", "RAISE_LOWER", "WINDOW_TIMEOUT",
    "apply_bounded_calibration", "wilson",
]
