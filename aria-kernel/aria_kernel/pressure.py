from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from .ledger import append_jsonl, load_jsonl
from .tool_registry import ensure_tools_dir, utc_now


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
            {
                "type": "UNKNOWN",
                "severity": "high",
                "reason": "discovery completion proof is incomplete",
                "evidence": [(discovery_dir / "COMPLETION_PROOF.json").as_posix()],
            },
        )
    if int(fingerprint.get("migration_count") or 0) >= 5:
        pressures.append(
            {
                "type": "REPETITION",
                "severity": "medium",
                "reason": "repository has repeated TypeORM migration surfaces",
                "evidence": ["apps/*/src/database/migrations/*.ts"],
            },
        )
    contradictions = [
        row
        for row in load_jsonl(root / "memory" / "contradictions.jsonl")
        if row.get("status", "open") == "open"
    ]
    if contradictions:
        pressures.append(
            {
                "type": "CONTRADICTION",
                "severity": "high",
                "reason": "open memory contradictions require operator attention",
                "count": len(contradictions),
                "evidence": ["aria-tools/memory/contradictions.jsonl"],
            },
        )

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


def _read_json(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {}
    with path.open("r", encoding="utf-8") as handle:
        payload = json.load(handle)
    return payload if isinstance(payload, dict) else {}
