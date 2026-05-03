from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from .ledger import append_jsonl, load_jsonl
from .feedback_store import load_feedback
from .tool_registry import GovernanceError, ensure_tools_dir, utc_now

SELF_OUTPUT_PREFIXES = ("aria-tools/", "agent-workspace/", ".aria-poc/")
MEMORY_KINDS = ("beliefs", "observations", "uncertainties", "contradictions", "calibration")


def update_memory(
    *,
    cycle_id: str,
    base_dir: str | Path | None = None,
) -> dict[str, Any]:
    root = ensure_tools_dir(base_dir)
    discovery_dir = root / "discovery" / cycle_id
    fingerprint = _read_json(discovery_dir / "REPO_FINGERPRINT.json")
    completion = _read_json(discovery_dir / "COMPLETION_PROOF.json")
    diff = _read_json(root / "cycle-diff" / f"{cycle_id}.json")
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
        "cycle_diff": diff.get("summary", {}),
        "evidence": ["package.json"] if fingerprint.get("has_package_json") else [],
    }
    append_jsonl(root / "memory" / "observations.jsonl", observation)

    beliefs_written = 0
    if fingerprint.get("has_nx"):
        _record_belief(
            root,
            cycle_id=cycle_id,
            belief_id="repo-uses-nx",
            claim="repository uses Nx workspace orchestration",
            evidence_refs=["nx.json"],
            confidence=1.0,
        )
        beliefs_written += 1
    if fingerprint.get("has_package_json"):
        _record_belief(
            root,
            cycle_id=cycle_id,
            belief_id="repo-has-node-package-manifest",
            claim="repository exposes Node workspace metadata through package.json",
            evidence_refs=["package.json"],
            confidence=1.0,
        )
        beliefs_written += 1
    if int(fingerprint.get("migration_count") or 0) >= 5:
        _record_belief(
            root,
            cycle_id=cycle_id,
            belief_id="repo-has-recurring-typeorm-migration-surface",
            claim="repository has a recurring TypeORM migration surface that merits drift checks",
            evidence_refs=["apps/*/src/database/migrations/*.ts"],
            confidence=0.85,
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
    if kind not in MEMORY_KINDS:
        raise ValueError(f"unknown memory kind: {kind}")
    rows = load_jsonl(ensure_tools_dir(base_dir) / "memory" / f"{kind}.jsonl")
    if kind == "beliefs":
        return latest_beliefs(rows)
    return rows


def latest_beliefs(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    latest: dict[str, dict[str, Any]] = {}
    for row in rows:
        belief_id = str(row.get("belief_id") or "")
        if belief_id:
            latest[belief_id] = _normalize_belief(row)
    return sorted(latest.values(), key=lambda row: str(row.get("belief_id")))


def validate_repo_evidence(evidence_refs: list[str]) -> None:
    if not evidence_refs:
        raise GovernanceError("memory belief requires at least one repo evidence reference")
    for raw_ref in evidence_refs:
        ref = str(raw_ref).replace("\\", "/")
        while ref.startswith("./"):
            ref = ref[2:]
        if not ref.strip():
            raise GovernanceError("memory belief evidence reference must not be empty")
        if ref.startswith(SELF_OUTPUT_PREFIXES):
            raise GovernanceError("memory belief cannot use ARIA self-output as evidence")


def _record_belief(
    root: Path,
    *,
    cycle_id: str,
    belief_id: str,
    claim: str,
    evidence_refs: list[str],
    confidence: float,
    source_tool_ids: list[str] | None = None,
) -> dict[str, Any]:
    validate_repo_evidence(evidence_refs)
    existing = {
        str(row.get("belief_id")): row
        for row in latest_beliefs(load_jsonl(root / "memory" / "beliefs.jsonl"))
    }.get(belief_id)
    contradictions = _open_contradictions_for(root, belief_id)
    feedback_adjustment = _feedback_adjustment(root, belief_id)
    support_count = int((existing or {}).get("support_count", 0)) + 1
    contradiction_count = len(contradictions)
    previous_confidence = float((existing or {}).get("confidence", confidence))
    next_confidence = _bounded_confidence(
        max(previous_confidence, confidence)
        + min(0.05, support_count * 0.005)
        + feedback_adjustment
        - contradiction_count * 0.15,
    )
    status = "supported"
    if contradiction_count:
        status = "contradicted"
    if next_confidence < 0.5:
        status = "needs_revalidation"
    row = {
        "schema_version": 1,
        "recorded_at": utc_now(),
        "updated_at": utc_now(),
        "belief_id": belief_id,
        "claim": claim,
        "confidence": next_confidence,
        "status": status,
        "evidence_refs": sorted(set(evidence_refs)),
        "first_seen_cycle": (existing or {}).get("first_seen_cycle", cycle_id),
        "last_seen_cycle": cycle_id,
        "support_count": support_count,
        "contradiction_count": contradiction_count,
        "source_tool_ids": sorted(set(source_tool_ids or (existing or {}).get("source_tool_ids", []))),
    }
    append_jsonl(root / "memory" / "beliefs.jsonl", row)
    return row


def _normalize_belief(row: dict[str, Any]) -> dict[str, Any]:
    normalized = dict(row)
    if "evidence_refs" not in normalized and "evidence" in normalized:
        evidence = normalized.get("evidence")
        normalized["evidence_refs"] = evidence if isinstance(evidence, list) else []
    normalized.setdefault("status", "supported")
    normalized.setdefault("first_seen_cycle", normalized.get("cycle_id"))
    normalized.setdefault("last_seen_cycle", normalized.get("cycle_id"))
    normalized.setdefault("support_count", 1)
    normalized.setdefault("contradiction_count", 0)
    normalized.setdefault("source_tool_ids", [])
    return normalized


def _open_contradictions_for(root: Path, belief_id: str) -> list[dict[str, Any]]:
    return [
        row
        for row in load_jsonl(root / "memory" / "contradictions.jsonl")
        if row.get("status", "open") == "open" and row.get("belief_id") == belief_id
    ]


def _feedback_adjustment(root: Path, belief_id: str) -> float:
    adjustment = 0.0
    for feedback in load_feedback(base_dir=root):
        note = str(feedback.get("note", ""))
        if belief_id not in note:
            continue
        if feedback.get("verdict") == "true_positive":
            adjustment += 0.05
        elif feedback.get("verdict") == "false_positive":
            adjustment -= 0.2 if feedback.get("severity") == "critical" else 0.1
    return adjustment


def _bounded_confidence(value: float) -> float:
    return round(min(1.0, max(0.0, value)), 3)


def _read_json(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {}
    with path.open("r", encoding="utf-8") as handle:
        payload = json.load(handle)
    return payload if isinstance(payload, dict) else {}
