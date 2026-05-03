from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from .ledger import append_jsonl, load_jsonl
from .tool_registry import ensure_tools_dir, utc_now


def update_memory(
    *,
    cycle_id: str,
    base_dir: str | Path | None = None,
) -> dict[str, Any]:
    root = ensure_tools_dir(base_dir)
    discovery_dir = root / "discovery" / cycle_id
    fingerprint = _read_json(discovery_dir / "REPO_FINGERPRINT.json")
    completion = _read_json(discovery_dir / "COMPLETION_PROOF.json")
    observation = {
        "schema_version": 1,
        "recorded_at": utc_now(),
        "cycle_id": cycle_id,
        "kind": "repo_fingerprint",
        "tracked_file_count": fingerprint.get("tracked_file_count", 0),
        "service_count": fingerprint.get("service_count", 0),
        "web_module_count": fingerprint.get("web_module_count", 0),
        "migration_count": fingerprint.get("migration_count", 0),
        "complete_discovery": completion.get("complete") is True,
        "evidence": ["package.json"] if fingerprint.get("has_package_json") else [],
    }
    append_jsonl(root / "memory" / "observations.jsonl", observation)

    beliefs_written = 0
    if fingerprint.get("has_nx"):
        append_jsonl(
            root / "memory" / "beliefs.jsonl",
            {
                "schema_version": 1,
                "recorded_at": utc_now(),
                "cycle_id": cycle_id,
                "belief_id": "repo-uses-nx",
                "claim": "repository uses Nx workspace orchestration",
                "confidence": 1.0,
                "evidence": ["nx.json"],
            },
        )
        beliefs_written += 1
    return {
        "schema_version": 1,
        "cycle_id": cycle_id,
        "observations_written": 1,
        "beliefs_written": beliefs_written,
    }


def list_memory(
    *,
    kind: str,
    base_dir: str | Path | None = None,
) -> list[dict[str, Any]]:
    if kind not in ("beliefs", "observations", "uncertainties", "contradictions", "calibration"):
        raise ValueError(f"unknown memory kind: {kind}")
    return load_jsonl(ensure_tools_dir(base_dir) / "memory" / f"{kind}.jsonl")


def _read_json(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {}
    with path.open("r", encoding="utf-8") as handle:
        payload = json.load(handle)
    return payload if isinstance(payload, dict) else {}
