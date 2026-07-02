from __future__ import annotations

import json
import math
import hashlib
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

from .ledger import append_declared_jsonl, load_declared_jsonl
from .runs_reader import read_runs_rows
from .tool_health import runs_path
from .tool_registry import GovernanceError, ensure_tools_dir, list_tools, utc_now
from .workspace import WorkspacePaths, default_actor

SOURCE_WEIGHTS = {
    "tool_quarantine": 90,
    "evidence_gone": 80,
    "belief_stale": 60,
    "belief_revalidation": 40,
    "migration_surface_repeat": 30,
    "discovery_incomplete": 70,
    "contradiction": 70,
    "shadow_raw_delta": 50,
    # Plan 029 §D5 — a prod incident / Sentry error is a high-signal lead worth
    # investigating promptly, below tool_quarantine (a confirmed in-repo
    # violation) but above evidence_gone.
    "runtime_signal": 85,
}

# Plan S4 (ORPHAN-MEDIUM-298) — every pressure source maps to exactly one
# drift class so the operator's genesis-policy `drift_class_weights` block
# can bias cycle targeting without touching the hardcoded SOURCE_WEIGHTS
# base. Adding a source REQUIRES adding its class here (pinned by
# test_drift_class_weights.test_every_source_has_a_drift_class).
DRIFT_CLASS_BY_SOURCE = {
    "tool_quarantine": "tool_governance",
    "runtime_signal": "runtime_signal",
    "evidence_gone": "evidence_decay",
    "discovery_incomplete": "discovery",
    "contradiction": "contradiction",
    "belief_stale": "belief_decay",
    "belief_revalidation": "belief_decay",
    "shadow_raw_delta": "adapter_shadow",
    "migration_surface_repeat": "schema_drift",
}

PRESSURE_STATES = {"active", "faded", "sleeping", "archived", "closed", "satisfied"}
TERMINAL_STATES = {"closed", "satisfied"}
DECAY_BUCKETS = (
    ("archived", 365),
    ("sleeping", 180),
    ("faded", 90),
)
DEFAULT_DECAY_THRESHOLDS = {"faded": 90, "sleeping": 180, "archived": 365}
_DECLARED_SURFACE_BY_FILENAME = {
    ("memory", "beliefs.jsonl"): "memory_beliefs",
    ("memory", "contradictions.jsonl"): "memory_contradictions",
    ("memory", "uncertainties.jsonl"): "memory_uncertainties",
    ("pressure", "pressure-log.jsonl"): "pressure_log",
    ("aria-memory", "unknowns.jsonl"): "workspace_memory_unknowns",
    ("aria-memory", "missed_signals.jsonl"): "workspace_memory_missed_signals",
    ("aria-memory", "external_feedback.jsonl"): "workspace_memory_external_feedback",
    ("aria-memory", "pressure.jsonl"): "workspace_memory_pressure",
    ("aria-memory", "pressure_state.jsonl"): "workspace_memory_pressure_state",
    ("aria-memory", "vocabulary_rejections.jsonl"): "workspace_memory_vocabulary_rejections",
    ("aria-memory", "since_migration_events.jsonl"): "workspace_memory_since_migration_events",
    ("aria-memory", "governance.jsonl"): "workspace_memory_governance",
}


def _surface_for_local_path(path: Path) -> str | None:
    return _DECLARED_SURFACE_BY_FILENAME.get((path.parent.name, path.name))


def append_jsonl(path: Path, payload: dict[str, Any]) -> dict[str, Any]:
    surface = _surface_for_local_path(path)
    if surface:
        return append_declared_jsonl(path, payload, expected_surface=surface)
    raise GovernanceError(f"pressure_append_unknown_surface:{path.as_posix()}")


def load_jsonl(path: Path) -> list[dict[str, Any]]:
    surface = _surface_for_local_path(path)
    if surface:
        return load_declared_jsonl(path, expected_surface=surface)
    raise GovernanceError(f"pressure_load_unknown_surface:{path.as_posix()}")


def run_pressure(
    *,
    cycle_id: str,
    base_dir: str | Path | None = None,
    drift_class_weights: dict[str, Any] | None = None,
) -> dict[str, Any]:
    root = ensure_tools_dir(base_dir)
    discovery_dir = root / "discovery" / cycle_id
    fingerprint = _read_json(discovery_dir / "REPO_FINGERPRINT.json")
    completion = _read_json(discovery_dir / "COMPLETION_PROOF.json")
    pressures: list[dict[str, Any]] = []

    if completion.get("complete") is not True:
        pressures.append(
            _pressure(
                cycle_id=cycle_id,
                source="discovery_incomplete",
                pressure_type="UNKNOWN",
                severity="high",
                reason="discovery completion proof is incomplete",
                evidence=[(discovery_dir / "COMPLETION_PROOF.json").as_posix()],
                occurrence_count=1,
                candidate_tools=["discovery"],
                recommended_action="rerun discovery and inspect missing fates",
            ),
        )
    migration_count = int(fingerprint.get("migration_ts_count") or fingerprint.get("migration_count") or 0)
    # Concrete, repo-verifiable evidence (L1) — discovery surfaces bounded real
    # migration paths in ``migration_evidence_paths``; a glob is not resolvable.
    migration_evidence_paths = fingerprint.get("migration_evidence_paths") or []
    if migration_count >= 5 and isinstance(migration_evidence_paths, list) and migration_evidence_paths:
        pressures.append(
            _pressure(
                cycle_id=cycle_id,
                source="migration_surface_repeat",
                pressure_type="REPETITION",
                severity="medium",
                reason="repository has repeated TypeORM migration surfaces",
                evidence=list(migration_evidence_paths),
                occurrence_count=migration_count,
                candidate_tools=["typeorm-entity-schema-adapter"],
                recommended_action="continue TypeORM schema drift checks",
            ),
        )
    beliefs = load_jsonl(root / "memory" / "beliefs.jsonl")
    latest_beliefs = _latest_by_id(beliefs, "belief_id")
    for belief in latest_beliefs:
        status = belief.get("status")
        if status == "stale":
            pressures.append(
                _pressure(
                    cycle_id=cycle_id,
                    source="belief_stale",
                    pressure_type="CONTRADICTION",
                    severity="high",
                    reason=f"belief is stale: {belief.get('belief_id')}",
                    evidence=_array_of_strings(belief.get("evidence_refs")),
                    occurrence_count=int(belief.get("needs_revalidation_cycles", 1)),
                    candidate_tools=[],
                    recommended_action="operator review stale belief",
                    belief_id=str(belief.get("belief_id")),
                ),
            )
        elif status == "needs_revalidation":
            state = belief.get("evidence_state", {}) if isinstance(belief.get("evidence_state"), dict) else {}
            source = "evidence_gone" if state.get("missing_concrete_refs") or state.get("empty_glob_refs") else "belief_revalidation"
            pressures.append(
                _pressure(
                    cycle_id=cycle_id,
                    source=source,
                    pressure_type="UNKNOWN",
                    severity="medium",
                    reason=f"belief needs revalidation: {belief.get('belief_id')}",
                    evidence=_array_of_strings(belief.get("evidence_refs")),
                    occurrence_count=int(belief.get("needs_revalidation_cycles", 1)),
                    candidate_tools=[],
                    recommended_action="validate belief evidence or withdraw belief",
                    belief_id=str(belief.get("belief_id")),
                ),
            )
    contradictions = [
        row
        for row in load_jsonl(root / "memory" / "contradictions.jsonl")
        if row.get("status", "open") == "open"
    ]
    if contradictions:
        pressures.append(
            _pressure(
                cycle_id=cycle_id,
                source="contradiction",
                pressure_type="CONTRADICTION",
                severity="high",
                reason="open memory contradictions require operator attention",
                evidence=["aria-tools/memory/contradictions.jsonl"],
                occurrence_count=len(contradictions),
                candidate_tools=[],
                recommended_action="review contradiction ledger",
            ),
        )
    # Plan 029 §D5 — runtime signals (Sentry / incident / telemetry) enter as
    # UNVERIFIED leads, not evidence. Each open signal becomes pressure pointing
    # ARIA's repo-evidence machinery at the referenced area; the recommended
    # action makes the unverified status explicit so a lead is never mistaken
    # for a confirmed finding.
    from .runtime_signal_bridge import load_open_runtime_signals
    for signal in load_open_runtime_signals(base_dir=root):
        severity = signal.get("severity") if signal.get("severity") in ("low", "medium", "high", "critical") else "high"
        pressures.append(
            _pressure(
                cycle_id=cycle_id,
                source="runtime_signal",
                pressure_type="UNKNOWN",
                severity=severity,
                reason=(
                    f"runtime signal ({signal.get('source')}) for "
                    f"{signal.get('service')}: {signal.get('summary')}"
                ),
                evidence=_array_of_strings(signal.get("code_refs")),
                occurrence_count=1,
                candidate_tools=[],
                recommended_action=(
                    "investigate the referenced code area with repo evidence; this "
                    "runtime lead is UNVERIFIED (trust_grade=runtime_unverified) — "
                    "confirm against the repo before treating it as a finding"
                ),
            ),
        )
    for run in list(read_runs_rows(runs_path(root), base_dir=root)):
        if run.get("cycle_id") != cycle_id:
            continue
        status = run.get("status")
        if status in ("evidence_error", "scope_violation") or run.get("evidence_validation", {}).get("repository_mutation_attempt"):
            pressures.append(
                _pressure(
                    cycle_id=cycle_id,
                    source="tool_quarantine",
                    pressure_type="CONTRADICTION",
                    severity="high",
                    reason=f"tool health violation: {run.get('tool_id')} {status}",
                    evidence=_array_of_strings(run.get("read_paths")),
                    occurrence_count=1,
                    candidate_tools=[str(run.get("tool_id"))],
                    recommended_action="inspect quarantine reason before next run",
                    tool_id=str(run.get("tool_id")),
                ),
            )
        delta = _raw_finding_delta(run, cycle_id, root)
        if run.get("status") == "ok" and delta > 0:
            pressures.append(
                _pressure(
                    cycle_id=cycle_id,
                    source="shadow_raw_delta",
                    pressure_type="REPETITION",
                    severity="medium",
                    reason=f"raw SHADOW findings increased for {run.get('tool_id')}: +{delta}",
                    evidence=_array_of_strings(run.get("read_paths"))[:20],
                    occurrence_count=delta,
                    candidate_tools=[str(run.get("tool_id"))],
                    recommended_action="sample and judge increased SHADOW findings before calibration",
                    tool_id=str(run.get("tool_id")),
                ),
            )

    _apply_drift_class_weights(pressures, drift_class_weights)
    _filter_candidate_tools(root, pressures)
    pressures.sort(key=lambda item: (-float(item["score"]), str(item["pressure_id"])))
    payload = {
        "schema_version": 1,
        "generated_at": utc_now(),
        "cycle_id": cycle_id,
        "pressures": pressures,
        "summary": {
            "unknown": sum(1 for item in pressures if item["type"] == "UNKNOWN"),
            "repetition": sum(1 for item in pressures if item["type"] == "REPETITION"),
            "contradiction": sum(1 for item in pressures if item["type"] == "CONTRADICTION"),
        },
    }
    output_path = root / "pressure" / f"{cycle_id}.json"
    output_path.parent.mkdir(parents=True, exist_ok=True)
    with output_path.open("w", encoding="utf-8") as handle:
        json.dump(payload, handle, indent=2, sort_keys=True)
        handle.write("\n")
    append_jsonl(root / "pressure" / "pressure-log.jsonl", payload)
    return payload


def _apply_drift_class_weights(
    pressures: list[dict[str, Any]],
    weights: dict[str, Any] | None,
) -> None:
    """Annotate each pressure with its drift class and, when the operator
    supplied a non-neutral weight for that class, rescale the score.

    Neutral (weights None / 1.0 / unknown class) leaves scores untouched, so
    default behaviour stays bit-identical. Rescaled scores re-cap at 100 to
    preserve the Plan 007 scoring invariant; the applied multiplier is
    recorded on the row for audit."""
    for pressure in pressures:
        drift_class = DRIFT_CLASS_BY_SOURCE.get(str(pressure.get("source")))
        if drift_class is not None:
            pressure["drift_class"] = drift_class
        if not weights or drift_class is None:
            continue
        raw = weights.get(drift_class, 1.0)
        try:
            multiplier = float(raw)
        except (TypeError, ValueError):
            continue
        if multiplier <= 0 or multiplier == 1.0:
            continue
        pressure["drift_class_weight_applied"] = multiplier
        pressure["score"] = round(min(100.0, float(pressure["score"]) * multiplier), 3)


def _filter_candidate_tools(root: Path, pressures: list[dict[str, Any]]) -> None:
    known_tool_ids = {str(tool.get("tool_id")) for tool in list_tools(base_dir=root)}
    for pressure in pressures:
        original = [
            str(tool_id)
            for tool_id in pressure.get("candidate_tools", [])
            if isinstance(tool_id, str)
        ]
        if not original:
            continue
        filtered = [tool_id for tool_id in original if tool_id in known_tool_ids]
        pressure["candidate_tools"] = filtered
        missing = sorted(set(original) - set(filtered))
        if missing and not filtered:
            append_jsonl(
                root / "memory" / "uncertainties.jsonl",
                {
                    "schema_version": 1,
                    "kind": "pressure_candidate_tools_unreachable",
                    "pressure_id": pressure.get("pressure_id"),
                    "missing_candidate_tools": missing,
                    "recorded_at": utc_now(),
                },
            )


def explain_pressure(
    *,
    cycle_id: str,
    pressure_id: str,
    base_dir: str | Path | None = None,
) -> dict[str, Any]:
    payload = _read_json(ensure_tools_dir(base_dir) / "pressure" / f"{cycle_id}.json")
    for pressure in payload.get("pressures", []):
        if isinstance(pressure, dict) and pressure.get("pressure_id") == pressure_id:
            return pressure
    raise ValueError(f"pressure not found: {pressure_id}")


def list_workspace_pressures(
    paths: WorkspacePaths,
    *,
    include_states: set[str] | None = None,
    now: datetime | None = None,
    decay_thresholds: dict[str, int] | None = None,
) -> list[dict[str, Any]]:
    include_states = include_states or {"active"}
    records = effective_workspace_pressures(paths, now=now, decay_thresholds=decay_thresholds)
    return [record for record in records if record.get("effective_state") in include_states]


def explain_workspace_pressure(
    paths: WorkspacePaths,
    pressure_event_id: str,
    *,
    now: datetime | None = None,
    decay_thresholds: dict[str, int] | None = None,
) -> dict[str, Any]:
    records = effective_workspace_pressures(paths, now=now, decay_thresholds=decay_thresholds)
    for record in records:
        if record.get("event_id") == pressure_event_id:
            return record
    raise ValueError(f"pressure not found: {pressure_event_id}")


def curate_workspace_pressures(
    paths: WorkspacePaths,
    *,
    since_days: int = 90,
    apply: bool = False,
    acknowledge: bool = False,
    reason: str | None = None,
    cycle_id: str | None = None,
    now: datetime | None = None,
    decay_thresholds: dict[str, int] | None = None,
) -> dict[str, Any]:
    if apply and not acknowledge:
        raise ValueError("curate_apply_requires_acknowledge")
    if apply and not reason:
        raise ValueError("curate_apply_requires_reason")
    now = now or _utcnow_dt()
    threshold = now - timedelta(days=since_days)
    records = effective_workspace_pressures(paths, now=now, decay_thresholds=decay_thresholds)
    candidates = [
        record
        for record in records
        if record.get("effective_state") in {"faded", "sleeping"}
        and _parse_ts(str(record.get("last_evidence_at") or "")) <= threshold
    ]
    written: list[dict[str, Any]] = []
    if apply:
        for record in candidates:
            written.append(
                append_pressure_state_event(
                    paths,
                    pressure=record,
                    to_state="archived",
                    reason=reason or "operator curation",
                    cycle_id=cycle_id,
                    evidence_refs=[],
                    feedback_event_ids=[],
                    details={"curation_since_days": since_days},
                    now=now,
                ),
            )
    return {
        "schema_version": 1,
        "mode": "apply" if apply else "dry_run",
        "since_days": since_days,
        "candidate_count": len(candidates),
        "candidates": candidates,
        "state_events_written": written,
    }


def close_pressures_from_signals(
    paths: WorkspacePaths,
    *,
    cycle_id: str | None = None,
    now: datetime | None = None,
    decay_thresholds: dict[str, int] | None = None,
) -> list[dict[str, Any]]:
    feedback = load_jsonl(paths.ledgers["external_feedback"])
    signals_by_gap: dict[str, list[dict[str, Any]]] = {}
    for row in feedback:
        if row.get("kind") != "closed_signal":
            continue
        gap = str(row.get("capability_gap_key") or "")
        if gap:
            signals_by_gap.setdefault(gap, []).append(row)

    records = effective_workspace_pressures(paths, now=now, decay_thresholds=decay_thresholds)
    emitted: list[dict[str, Any]] = []
    for gap, signals in sorted(signals_by_gap.items()):
        signal_ids = sorted({str(row.get("event_id")) for row in signals if row.get("event_id")})
        evidence_refs = sorted(
            {
                str(ref)
                for row in signals
                for ref in row.get("evidence_refs", [])
                if isinstance(ref, str) and ref.strip()
            },
        )
        if len(signal_ids) < 3 or len(evidence_refs) < 2:
            continue
        for record in records:
            if record.get("capability_gap_key") != gap:
                continue
            if record.get("effective_state") not in {"active", "faded", "sleeping"}:
                continue
            emitted.append(
                append_pressure_state_event(
                    paths,
                    pressure=record,
                    to_state="closed",
                    reason="closed_signal_threshold_met",
                    cycle_id=cycle_id,
                    evidence_refs=evidence_refs,
                    feedback_event_ids=signal_ids,
                    details={"closed_signal_count": len(signal_ids), "distinct_evidence_ref_count": len(evidence_refs)},
                    now=now,
                ),
            )
    return emitted


def effective_workspace_pressures(
    paths: WorkspacePaths,
    *,
    now: datetime | None = None,
    decay_thresholds: dict[str, int] | None = None,
) -> list[dict[str, Any]]:
    now = now or _utcnow_dt()
    thresholds = decay_thresholds or DEFAULT_DECAY_THRESHOLDS
    pressures = load_jsonl(paths.ledgers["pressure"])
    feedback_by_id = _feedback_by_id(paths)
    trusted_gap_keys, ref_statuses = _phase2_effective_context(paths)
    states_by_pressure: dict[str, list[dict[str, Any]]] = {}
    for row in load_jsonl(paths.ledgers["pressure_state"]):
        pressure_event_id = str(row.get("pressure_event_id") or "")
        if pressure_event_id:
            states_by_pressure.setdefault(pressure_event_id, []).append(row)

    records: list[dict[str, Any]] = []
    for pressure in pressures:
        pressure_id = str(pressure.get("event_id") or pressure.get("pressure_id") or "")
        history = sorted(states_by_pressure.get(pressure_id, []), key=lambda row: str(row.get("ts") or ""))
        last_evidence_at, timestamp_missing = _last_evidence_at(pressure, feedback_by_id)
        decay_state = _decayed_state(last_evidence_at, now, thresholds)
        effective_state = decay_state
        if history:
            explicit_state = str(history[-1].get("to_state") or "")
            if explicit_state in TERMINAL_STATES or explicit_state in {"sleeping", "archived"}:
                effective_state = explicit_state
            elif explicit_state == "active":
                effective_state = decay_state
            elif explicit_state == "faded":
                effective_state = "faded" if decay_state == "active" else decay_state
        record = dict(pressure)
        record["effective_state"] = effective_state
        record["decay_state"] = decay_state
        record["last_evidence_at"] = _format_dt(last_evidence_at)
        record["state_history"] = history
        record["state_details"] = {"timestamp_missing": timestamp_missing, "decay_thresholds": dict(thresholds)}
        record["trusted_effective"] = record.get("capability_gap_key") in trusted_gap_keys
        record["ref_stale"] = _pressure_ref_stale(record, ref_statuses)
        record["effective_magnitude"] = _effective_magnitude(record, ref_statuses)
        records.append(record)
    records.sort(key=lambda row: (str(row.get("effective_state")), str(row.get("event_id") or row.get("pressure_id"))))
    return records


def append_pressure_state_event(
    paths: WorkspacePaths,
    *,
    pressure: dict[str, Any],
    to_state: str,
    reason: str,
    cycle_id: str | None = None,
    evidence_refs: list[str] | None = None,
    feedback_event_ids: list[str] | None = None,
    details: dict[str, Any] | None = None,
    now: datetime | None = None,
    decay_thresholds: dict[str, int] | None = None,
) -> dict[str, Any]:
    if to_state not in PRESSURE_STATES:
        raise ValueError(f"unsupported pressure state: {to_state}")
    pressure_event_id = str(pressure.get("event_id") or pressure.get("pressure_event_id") or pressure.get("pressure_id") or "")
    existing = effective_workspace_pressures(paths, now=now, decay_thresholds=decay_thresholds)
    by_id = {str(row.get("event_id") or row.get("pressure_id")): row for row in existing}
    current = by_id.get(pressure_event_id, pressure)
    from_state = _explicit_pressure_state(current)
    payload = {
        "$schema": "aria/pressure-state-event/v1",
        "event_id": _stable_state_event_id(
            pressure_event_id=pressure_event_id,
            from_state=from_state,
            to_state=to_state,
            reason=reason,
            evidence_refs=evidence_refs or [],
            feedback_event_ids=feedback_event_ids or [],
        ),
        "pressure_event_id": pressure_event_id,
        "capability_gap_key": pressure.get("capability_gap_key"),
        "from_state": from_state,
        "to_state": to_state,
        "reason": reason,
        "cycle_id": cycle_id,
        "ts": _format_dt(now or _utcnow_dt()),
        "actor": default_actor(),
        "evidence_refs": sorted(evidence_refs or []),
        "feedback_event_ids": sorted(feedback_event_ids or []),
        "details": details or {},
        "schema_version": 1,
    }
    existing_state_rows = load_jsonl(paths.ledgers["pressure_state"])
    if any(
        row.get("pressure_event_id") == payload["pressure_event_id"]
        and row.get("to_state") == payload["to_state"]
        and row.get("reason") == payload["reason"]
        and sorted(row.get("feedback_event_ids") or []) == payload["feedback_event_ids"]
        and sorted(row.get("evidence_refs") or []) == payload["evidence_refs"]
        for row in existing_state_rows
    ):
        return payload
    return append_jsonl(paths.ledgers["pressure_state"], payload)


def _pressure(
    *,
    cycle_id: str,
    source: str,
    pressure_type: str,
    severity: str,
    reason: str,
    evidence: list[str],
    occurrence_count: int,
    candidate_tools: list[str],
    recommended_action: str,
    belief_id: str | None = None,
    tool_id: str | None = None,
) -> dict[str, Any]:
    recency_decay = 1.0
    base_weight = SOURCE_WEIGHTS[source]
    count = max(1, occurrence_count)
    raw_score = base_weight * recency_decay * (1 + math.log10(count))
    score = round(min(100.0, raw_score), 3)
    pressure_id_parts = [source, belief_id or tool_id or pressure_type.lower()]
    return {
        "schema_version": 1,
        "pressure_id": "pressure:" + ":".join(_slug(part) for part in pressure_id_parts if part),
        "cycle_id": cycle_id,
        "type": pressure_type,
        "source": source,
        "severity": severity,
        "score": score,
        "score_components": {
            "source_weight": base_weight,
            "recency_decay": recency_decay,
            "occurrence_count": count,
            "formula": "min(100, source_weight * recency_decay * (1 + log10(occurrence_count)))",
        },
        "reason": reason,
        "evidence": evidence,
        "candidate_tools": candidate_tools,
        "recommended_action": recommended_action,
        "belief_id": belief_id,
        "tool_id": tool_id,
        "blocked_by": [],
    }


def _feedback_by_id(paths: WorkspacePaths) -> dict[str, dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for name in ("unknowns", "missed_signals", "external_feedback"):
        rows.extend(load_jsonl(paths.ledgers[name]))
    return {str(row.get("event_id")): row for row in rows if row.get("event_id")}


def _phase2_effective_context(paths: WorkspacePaths) -> tuple[set[str], dict[str, str]]:
    try:
        from .trust import ref_status_by_feedback_id, trusted_gap_keys

        return trusted_gap_keys(paths), ref_status_by_feedback_id(paths)
    except Exception:
        return set(), {}


def _pressure_ref_stale(pressure: dict[str, Any], ref_statuses: dict[str, str]) -> str:
    statuses = [
        ref_statuses[event_id]
        for event_id in pressure.get("feedback_event_ids", [])
        if isinstance(event_id, str) and event_id in ref_statuses
    ]
    if not statuses:
        return "unknown"
    if any(status == "fresh" for status in statuses):
        return "fresh"
    if all(status in {"stale", "missing"} for status in statuses):
        return "stale"
    if any(status in {"stale", "missing"} for status in statuses):
        return "partial_stale"
    return "unknown"


def _effective_magnitude(pressure: dict[str, Any], ref_statuses: dict[str, str]) -> float:
    base = float(pressure.get("magnitude") or 0)
    event_ids = [event_id for event_id in pressure.get("feedback_event_ids", []) if isinstance(event_id, str)]
    if event_ids:
        weights = [0.5 if ref_statuses.get(event_id) in {"stale", "missing"} else 1.0 for event_id in event_ids]
        base *= sum(weights) / len(weights)
    return round(base * (2.0 if pressure.get("trusted_effective") else 1.0), 3)


def _last_evidence_at(pressure: dict[str, Any], feedback_by_id: dict[str, dict[str, Any]]) -> tuple[datetime, bool]:
    timestamps = [
        _parse_ts(str(feedback_by_id[event_id].get("created_at") or ""))
        for event_id in pressure.get("feedback_event_ids", [])
        if isinstance(event_id, str) and event_id in feedback_by_id
    ]
    timestamps = [ts for ts in timestamps if ts != _epoch()]
    if timestamps:
        return max(timestamps), False
    for key in ("detected_at", "created_at"):
        value = pressure.get(key)
        if isinstance(value, str) and value.strip():
            return _parse_ts(value), False
    return _epoch(), True


def _decayed_state(last_evidence_at: datetime, now: datetime, thresholds: dict[str, int] | None = None) -> str:
    thresholds = thresholds or DEFAULT_DECAY_THRESHOLDS
    age_days = (now - last_evidence_at).days
    buckets = sorted(
        ((state, int(days)) for state, days in thresholds.items() if state in {"faded", "sleeping", "archived"}),
        key=lambda item: item[1],
        reverse=True,
    )
    for state, threshold in buckets:
        if age_days >= threshold:
            return state
    return "active"


def _explicit_pressure_state(record: dict[str, Any]) -> str:
    history = record.get("state_history")
    if isinstance(history, list) and history:
        latest = history[-1]
        if isinstance(latest, dict) and isinstance(latest.get("to_state"), str):
            return latest["to_state"]
    explicit = record.get("to_state")
    if isinstance(explicit, str) and explicit in PRESSURE_STATES:
        return explicit
    return "active"


def _stable_state_event_id(
    *,
    pressure_event_id: str,
    from_state: str,
    to_state: str,
    reason: str,
    evidence_refs: list[str],
    feedback_event_ids: list[str],
) -> str:
    identity = {
        "pressure_event_id": pressure_event_id,
        "from_state": from_state,
        "to_state": to_state,
        "reason": reason,
        "evidence_refs": sorted(evidence_refs),
        "feedback_event_ids": sorted(feedback_event_ids),
    }
    digest = hashlib.sha256(json.dumps(identity, sort_keys=True, separators=(",", ":")).encode("utf-8")).hexdigest()
    return f"PSE-{_slug(pressure_event_id)[:48]}-{digest[:16]}"


def _parse_ts(value: str) -> datetime:
    if not value:
        return _epoch()
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return _epoch()
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def _format_dt(value: datetime) -> str:
    return value.astimezone(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def _utcnow_dt() -> datetime:
    return datetime.now(timezone.utc)


def _epoch() -> datetime:
    return datetime(1970, 1, 1, tzinfo=timezone.utc)


def _latest_by_id(rows: list[dict[str, Any]], key: str) -> list[dict[str, Any]]:
    latest: dict[str, dict[str, Any]] = {}
    for row in rows:
        value = row.get(key)
        if isinstance(value, str) and value:
            latest[value] = row
    return list(latest.values())


def _array_of_strings(value: Any) -> list[str]:
    if not isinstance(value, list):
        return []
    return [str(item) for item in value if isinstance(item, str) and item.strip()]


def _raw_finding_delta(run: dict[str, Any], cycle_id: str, root: Path) -> int:
    tool_id = run.get("tool_id")
    previous = [
        row
        for row in list(read_runs_rows(runs_path(root), base_dir=root))
        if row.get("tool_id") == tool_id and row.get("cycle_id") != cycle_id and str(row.get("cycle_id")) < cycle_id
    ]
    if not previous:
        return 0
    current_raw = int(run.get("runner", {}).get("raw_findings_count") or 0)
    previous_raw = int(previous[-1].get("runner", {}).get("raw_findings_count") or 0)
    return current_raw - previous_raw


def _slug(value: str) -> str:
    return "".join(ch.lower() if ch.isalnum() else "-" for ch in value).strip("-")


def _read_json(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {}
    with path.open("r", encoding="utf-8") as handle:
        payload = json.load(handle)
    return payload if isinstance(payload, dict) else {}
