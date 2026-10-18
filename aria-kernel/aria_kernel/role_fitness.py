"""ARIA-HIGH-125 — ARIA's own precision and recall, measured against a gold corpus.

WHY. The judges and the adapters are promoted on numbers they produce
themselves: an adapter's precision is the judges' verdicts on its findings,
and a judge's calibration is scored against agreement it may have helped
form. The goldset (``goldset``: operator verdicts and three-judge anchors,
promoted by a named curator) is the one corpus whose answers nobody in the
loop wrote, and the judge replay (``judge_replay``) already sits the judges
in front of it. Nothing scored either against it, so a promotion of ARIA's
own machinery had no measured "better" to rest on.

WHAT. :func:`measure_role_fitness` (pure, read-only) scores, per adapter with
an active goldset:

* the adapter: its version in force (``tool_health.current_emission_scope``,
  the latest ok run's fingerprints) against the goldset's labelled items —
  precision over the labelled findings it emits, recall over the true
  positives it should emit;
* each judge: its verdicts on that tool's replay groups
  (``judge_calibration.score_judges`` over ``replay:<tool>:``) — precision,
  recall and expected calibration error.

A role with nothing to be scored against is ``unmeasured:<why>``, never a
score: no active goldset, no ok run, no labelled emission, no replay verdict.
The nightly fitness report (``fitness.generate_fitness_report``) records the
measurement, named by the goldset it read (``goldset_hash``), after the judge
replay that minted that night's replay verdicts.

:func:`adapter_fitness_blocker` is the read side: the autonomous promotion
lanes (the auto-promote token and the panel lane, ``promotion_veto``) refuse
an adapter whose newest fitness report does not measure its current version
against its current goldset at or above its precision floor. The operator's
GitHub act is not gated here: a person promoting a tool is the judgment this
measurement exists to stand in for when no person is asked.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Iterable

ROLE_FITNESS_SCHEMA = "aria/role-fitness/v1"
MEASURED = "measured"
UNMEASURED_NO_GOLDSET = "unmeasured:no_active_goldset"
UNMEASURED_NO_OK_RUN = "unmeasured:no_ok_run"
UNMEASURED_NO_LABELLED_EMISSION = "unmeasured:no_labelled_emission"
UNMEASURED_NO_REPLAY_VERDICT = "unmeasured:no_replay_verdict"

# The blockers the read side names; each is the reason an autonomous lane
# refuses (``adapter_fitness_blocker``).
FITNESS_UNMEASURED = "fitness_unmeasured"
FITNESS_STALE = "fitness_stale"
FITNESS_BELOW_THRESHOLD = "fitness_below_threshold"


def goldset_hash(goldset: dict[str, Any]) -> str:
    """The identity of one promoted gold corpus: the digest of its record."""
    from .ledger import sha256_digest_of_canonical_json

    return sha256_digest_of_canonical_json(goldset)


def _gold_fingerprints(items: Iterable[Any]) -> frozenset[str]:
    return frozenset(
        str(item["finding_fingerprint"])
        for item in items
        if isinstance(item, dict) and item.get("finding_fingerprint")
    )


def _ratio(numerator: int, denominator: int) -> float | None:
    return round(numerator / denominator, 4) if denominator else None


def _adapter_row(
    tool: dict[str, Any],
    goldset: dict[str, Any],
    runs: list[dict[str, Any]],
    root: Path,
) -> dict[str, Any]:
    from .fixture_runner import tool_manifest_hash
    from .tool_health import current_emission_scope

    tool_id = str(tool["tool_id"])
    true_positives = _gold_fingerprints(goldset.get("true_positive_items") or [])
    false_positives = _gold_fingerprints(goldset.get("known_false_positive_items") or [])
    scope = current_emission_scope(tool_id, [run for run in runs if run.get("tool_id") == tool_id], base_dir=root)
    emitted = scope.fingerprints
    hits = len(emitted & true_positives)
    labelled = len(emitted & (true_positives | false_positives))
    precision = _ratio(hits, labelled)
    recall = _ratio(hits, len(true_positives))
    status = (
        UNMEASURED_NO_OK_RUN if scope.run_id is None
        else UNMEASURED_NO_LABELLED_EMISSION if precision is None or recall is None
        else MEASURED
    )
    return {
        "status": status,
        "tool_version": tool.get("version"),
        "tool_manifest_hash": tool_manifest_hash(tool),
        "goldset_hash": goldset_hash(goldset),
        "run_id": scope.run_id,
        "gold_true_positives": len(true_positives),
        "gold_known_false_positives": len(false_positives),
        "emitted": len(emitted),
        "emitted_labelled": labelled,
        "emitted_true_positives": hits,
        "precision": precision,
        "recall": recall,
    }


def _judge_rows(tool_id: str, goldset: dict[str, Any], root: Path) -> dict[str, Any]:
    from .judge_calibration import score_judges
    from .judge_replay import REPLAY_GROUP_PREFIX

    scored = score_judges(base_dir=root, judgment_group_prefix=f"{REPLAY_GROUP_PREFIX}{tool_id}:", min_samples=1)
    judges = [
        {
            "judge_id": judge["judge_id"],
            "status": MEASURED,
            "samples": judge["samples"],
            "precision": judge["precision"],
            "recall": judge["recall"],
            "ece": judge["ece_top"],
        }
        for judge in scored["judges"]
        if judge.get("samples")
    ]
    return {
        "status": MEASURED if judges else UNMEASURED_NO_REPLAY_VERDICT,
        "goldset_hash": goldset_hash(goldset),
        "judges": judges,
    }


def measure_role_fitness(
    *,
    base_dir: str | Path | None = None,
    runs: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    """Per adapter and per judge, precision and recall against the gold corpus.

    ``runs`` is the run ledger the caller already read (the fitness report
    reads it once for every dimension); without it the ledger is read here.
    """
    from .goldset import load_active_goldset
    from .runs_reader import read_runs_rows
    from .tool_health import runs_path
    from .tool_registry import ensure_tools_dir, list_tools

    root = ensure_tools_dir(base_dir)
    if runs is None:
        runs = list(read_runs_rows(runs_path(root), base_dir=root))
    adapters: dict[str, dict[str, Any]] = {}
    judges: dict[str, dict[str, Any]] = {}
    for tool in list_tools(base_dir=root):
        tool_id = str(tool.get("tool_id") or "")
        if not tool_id or tool.get("kind") != "adapter":
            continue
        goldset = load_active_goldset(tool_id=tool_id, base_dir=root)
        if not goldset:
            adapters[tool_id] = {"status": UNMEASURED_NO_GOLDSET, "tool_version": tool.get("version")}
            judges[tool_id] = {"status": UNMEASURED_NO_GOLDSET, "judges": []}
            continue
        adapters[tool_id] = _adapter_row(tool, goldset, runs, root)
        judges[tool_id] = _judge_rows(tool_id, goldset, root)
    return {"$schema": ROLE_FITNESS_SCHEMA, "adapters": adapters, "judges": judges}


def _parse_stamp(value: Any) -> datetime | None:
    try:
        moment = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except ValueError:
        return None
    return moment if moment.tzinfo is not None else moment.replace(tzinfo=timezone.utc)


def adapter_fitness_blocker(
    tool_id: str,
    *,
    base_dir: str | Path | None = None,
    now: datetime | None = None,
) -> str | None:
    """Why an autonomous lane may not promote ``tool_id`` on its measured
    fitness, or None when it may.

    The newest fitness report must measure the tool (``fitness_unmeasured``
    otherwise), be no older than the tool's freshness window and describe
    its current version, manifest and active goldset (``fitness_stale``),
    and put its precision at or above its ``precision_min``
    (``fitness_below_threshold``). Recall is reported beside it and not
    gated: no recall floor has been set for any adapter.
    """
    from .fitness import list_fitness_reports
    from .fixture_runner import tool_manifest_hash
    from .goldset import load_active_goldset
    from .tool_registry import DEFAULT_HEALTH_THRESHOLDS, effective_freshness_window_hours, get_tool

    tool = get_tool(tool_id, base_dir)
    reports = list_fitness_reports(base_dir=base_dir)
    if not reports:
        return f"{FITNESS_UNMEASURED}:no_fitness_report"
    latest = reports[-1]
    row = ((latest.get("role_fitness") or {}).get("adapters") or {}).get(tool_id) or {}
    if row.get("status") != MEASURED:
        return f"{FITNESS_UNMEASURED}:{row.get('status') or 'tool_not_in_report'}"
    recorded = _parse_stamp(latest.get("recorded_at"))
    current = now or datetime.now(timezone.utc)
    goldset = load_active_goldset(tool_id=tool_id, base_dir=base_dir)
    if (
        recorded is None
        or current - recorded > timedelta(hours=effective_freshness_window_hours(tool))
        or row.get("tool_version") != tool.get("version")
        or row.get("tool_manifest_hash") != tool_manifest_hash(tool)
        or not goldset
        or row.get("goldset_hash") != goldset_hash(goldset)
    ):
        return FITNESS_STALE
    floor = float((tool.get("health_thresholds") or {}).get("precision_min", DEFAULT_HEALTH_THRESHOLDS["precision_min"]))
    if float(row["precision"]) < floor:
        return f"{FITNESS_BELOW_THRESHOLD}:precision={row['precision']}<{floor}"
    return None


__all__ = [
    "FITNESS_BELOW_THRESHOLD",
    "FITNESS_STALE",
    "FITNESS_UNMEASURED",
    "MEASURED",
    "ROLE_FITNESS_SCHEMA",
    "UNMEASURED_NO_GOLDSET",
    "UNMEASURED_NO_LABELLED_EMISSION",
    "UNMEASURED_NO_OK_RUN",
    "UNMEASURED_NO_REPLAY_VERDICT",
    "adapter_fitness_blocker",
    "goldset_hash",
    "measure_role_fitness",
]
