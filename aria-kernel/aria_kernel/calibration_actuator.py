"""ARIA-HIGH-370 — bounded calibration auto-apply, with an automatic revert.

WHY. ``recommend_calibration`` has produced a recommendation every cycle
since ORPHAN-* F4.1, stamped ``recommendation_only``, and nothing applied
one: 36 rows on the runner store (2026-10-07), the same four adapter weights
recommended 36 times, no weight ever moved. The recommendations named a dial
that did not exist (``calibration_dials``); with the dial in place, an
unapplied recommendation is a measurement ARIA takes and throws away.

WHAT. :func:`apply_bounded_calibration` runs after the producer, in the same
phase. It acts only on the tool dial (``calibration_dials.TOOL_DIAL``):

1. **Judge** every application whose window has closed: the labels recorded
   for that tool since the application, once there are
   :data:`WINDOW_MIN_LABELS` of them. The application bet on the precision
   that justified it (a raise: precision stays >= ``RAISE_AT_PRECISION``; a
   cut: it stays <= ``CUT_AT_PRECISION``). A window that contradicts the bet
   reverts the dial to its previous weight; otherwise the application is
   held. Both are ledger rows with the window's counts.
2. **Apply** each recommendation whose target lies inside the declared
   bounds ``[TOOL_DIAL_MIN, TOOL_DIAL_MAX]`` and moves at most
   :data:`MAX_STEP_PER_CYCLE`, on a dial with no application still awaiting
   its window (one step per window: the same labels never ratchet a dial).
   The row records the recommendation's ledger hash, precision and sample
   count as its evidence, and the bet the revert rule judges.
3. **Surface** everything else, unapplied and ``recommendation_only``, with
   its reason: outside the bounds, a step too large, a window still open, or
   a pressure-source dial. The pressure-source table belongs to the
   operator's ``pressure weight-override`` and to the Beta-Binomial source
   calibration (ORPHAN-HIGH-627); a second automatic writer on that dial
   would fight the first, so it never applies one.

It applies nothing unless the active profile may commit a change
(``runtime_profile.ACTION_PERMISSIONS["change_committed"]``): under observe
or frozen every recommendation is surfaced and the ledger is not written.
"""
from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Any, Mapping

from .calibration import CUT_AT_PRECISION, RAISE_AT_PRECISION
from .calibration_dials import (
    AUTO_APPLIED_PATH,
    AUTO_APPLIED_SURFACE,
    TOOL_DIAL,
    TOOL_DIAL_MAX,
    TOOL_DIAL_MIN,
    TOOL_DIAL_NEUTRAL,
    auto_applied_rows,
    feedback_dial,
)

MAX_STEP_PER_CYCLE = 10
WINDOW_MIN_LABELS = 5


def _open_applications(rows: list[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    """application_id → the applied row no held / reverted row has judged yet."""
    judged = {row["application_id"] for row in rows if row["event"] in ("held", "reverted")}
    return {row["application_id"]: row for row in rows if row["event"] == "applied" and row["application_id"] not in judged}


def _window(feedback: list[dict[str, Any]], tool: str, since: str) -> dict[str, Any]:
    """The labels of ``tool`` recorded after ``since``; a row whose time does
    not parse is not in any window (it cannot be placed after the change)."""
    from .tool_registry import parse_utc_stamp

    start = parse_utc_stamp(since)
    tp = fp = 0
    for row in feedback:
        stamp = parse_utc_stamp(str(row.get("recorded_at") or ""))
        if feedback_dial(row) == (TOOL_DIAL, tool) and start is not None and stamp is not None and stamp > start:
            verdict = str(row.get("verdict") or "")
            tp += verdict == "true_positive"
            fp += verdict == "false_positive"
    labels = tp + fp
    return {"tp": tp, "fp": fp, "labels": labels, "since": since,
            "precision": round(tp / labels, 3) if labels else None}


def _contradicts(application: Mapping[str, Any], precision: float) -> bool:
    bet = application["bet"]
    return precision < bet["threshold"] if bet["direction"] == "up" else precision > bet["threshold"]


def _surface(rec: Mapping[str, Any], reason: str) -> dict[str, Any]:
    return {"dial": rec.get("dial"), "name": rec.get("source"), "current_weight": rec.get("current_weight"),
            "recommended_weight": rec.get("recommended_weight"), "status": "recommendation_only", "reason": reason}


def _admissible(rec: Mapping[str, Any], open_dials: set[str], judged_dials: set[str]) -> str | None:
    """None when the recommendation may apply; else why it stays advice."""
    if rec.get("dial") != TOOL_DIAL:
        return "operator_owned_dial"
    if str(rec["source"]) in open_dials:
        return "window_open"
    if str(rec["source"]) in judged_dials:
        # The recommendation read the dial before this cycle's judgement
        # moved or confirmed it: one change per dial per cycle.
        return "judged_this_cycle"
    current, target = int(rec["current_weight"]), int(rec["recommended_weight"])
    if not TOOL_DIAL_MIN <= target <= TOOL_DIAL_MAX:
        return "outside_declared_bounds"
    if abs(target - current) > MAX_STEP_PER_CYCLE:
        return "step_exceeds_cycle_limit"
    return None


def apply_bounded_calibration(
    *, recommendation: Mapping[str, Any], base_dir: str | Path | None, cycle_id: str,
) -> dict[str, Any]:
    """Judge open applications, apply the admissible recommendations, surface the rest."""
    from .feedback_store import load_feedback
    from .ledger import append_declared_jsonl
    from .runtime_profile import ACTION_PERMISSIONS, get_profile
    from .tool_registry import ensure_tools_dir, utc_now

    recs = list(recommendation.get("pressure_weight_recommendations") or [])
    profile = get_profile(base_dir=base_dir)
    if profile not in ACTION_PERMISSIONS["change_committed"]:
        return {"status": "withheld_by_profile", "profile": profile, "applied": [], "judged": [],
                "surfaced": [_surface(rec, "profile_may_not_commit") for rec in recs]}
    root = ensure_tools_dir(base_dir)
    path = root.joinpath(*AUTO_APPLIED_PATH)
    path.parent.mkdir(parents=True, exist_ok=True)
    now = utc_now()

    def append(row: dict[str, Any]) -> dict[str, Any]:
        return append_declared_jsonl(path, {"schema_version": 1, "cycle_id": cycle_id, "recorded_at": now, **row},
                                     expected_surface=AUTO_APPLIED_SURFACE)

    feedback = load_feedback(base_dir=root)
    judged: list[dict[str, Any]] = []
    for application in _open_applications(auto_applied_rows(root)).values():
        window = _window(feedback, str(application["dial"]["name"]), str(application["applied_at"]))
        if window["labels"] < WINDOW_MIN_LABELS:
            continue
        reverted = _contradicts(application, float(window["precision"]))
        judged.append(append({
            "event": "reverted" if reverted else "held", "application_id": application["application_id"],
            "dial": application["dial"], "weight": application["from_weight" if reverted else "to_weight"],
            "window": window,
        }))
    open_dials = {str(row["dial"]["name"]) for row in _open_applications(auto_applied_rows(root)).values()}
    applied: list[dict[str, Any]] = []
    surfaced: list[dict[str, Any]] = []
    for rec in recs:
        refusal = _admissible(rec, open_dials, {str(row["dial"]["name"]) for row in judged})
        if refusal is not None:
            surfaced.append(_surface(rec, refusal))
            continue
        current, target = int(rec["current_weight"]), int(rec["recommended_weight"])
        direction = "up" if target > current else "down"
        evidence = {"recommendation_ledger_hash": recommendation.get("ledger_hash"),
                    "recommendation_cycle_id": recommendation.get("cycle_id"),
                    "feedback_precision": rec["feedback_precision"], "sample_count": rec["sample_count"]}
        digest = hashlib.sha256(json.dumps([rec["source"], current, target, evidence], sort_keys=True).encode())
        applied.append(append({
            "event": "applied", "application_id": "calib:" + digest.hexdigest()[:24],
            "dial": {"kind": TOOL_DIAL, "name": str(rec["source"])}, "from_weight": current, "to_weight": target,
            "applied_at": now, "evidence": evidence,
            "bet": {"metric": "feedback_precision", "direction": direction,
                    "threshold": RAISE_AT_PRECISION if direction == "up" else CUT_AT_PRECISION,
                    "window_min_labels": WINDOW_MIN_LABELS},
            "bounds": {"min": TOOL_DIAL_MIN, "max": TOOL_DIAL_MAX, "neutral": TOOL_DIAL_NEUTRAL,
                       "max_step_per_cycle": MAX_STEP_PER_CYCLE},
        }))
        open_dials.add(str(rec["source"]))
    return {"status": "acted", "profile": profile, "applied": applied, "judged": judged, "surfaced": surfaced}


__all__ = ["MAX_STEP_PER_CYCLE", "WINDOW_MIN_LABELS", "apply_bounded_calibration"]
