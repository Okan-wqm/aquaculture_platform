from __future__ import annotations

import json
import math
from pathlib import Path
from typing import Any

from .ledger import append_jsonl, load_jsonl
from .tool_health import runs_path
from .tool_registry import ensure_tools_dir, utc_now

SOURCE_WEIGHTS = {
    "tool_quarantine": 90,
    "evidence_gone": 80,
    "belief_stale": 60,
    "belief_revalidation": 40,
    "migration_surface_repeat": 30,
    "discovery_incomplete": 70,
    "contradiction": 70,
}


def run_pressure(
    *,
    cycle_id: str,
    base_dir: str | Path | None = None,
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
    migration_count = int(fingerprint.get("migration_count") or 0)
    if migration_count >= 5:
        pressures.append(
            _pressure(
                cycle_id=cycle_id,
                source="migration_surface_repeat",
                pressure_type="REPETITION",
                severity="medium",
                reason="repository has repeated TypeORM migration surfaces",
                evidence=["apps/*/src/database/migrations/*.ts"],
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
    for run in load_jsonl(runs_path(root)):
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


def _slug(value: str) -> str:
    return "".join(ch.lower() if ch.isalnum() else "-" for ch in value).strip("-")


def _read_json(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {}
    with path.open("r", encoding="utf-8") as handle:
        payload = json.load(handle)
    return payload if isinstance(payload, dict) else {}
