"""Operator-facing finding document writer for ARIA (Plan 016 Faz A2, CONTRACTS §6).

Two-layer model — this module is the OPERATOR-FACING layer:

1. Kernel ledger (existing — `feedback_store.py`):
   `aria-tools/findings.jsonl` records every adapter run's emitted findings
   plus operator feedback (TP/FP). Append-only, hash-chained, per-run scope.

2. Operator-facing committed document (this module):
   `aria-findings/F-*.json` is the human-and-CI readable record per CONTRACTS
   §6 schema (claim_type allowlist, severity floor, evidence floor, banned-
   phrase gate, traceability to originating run / pressure event).

Promotion path: `emit_finding` consumes either a kernel ledger entry, a
pressure event, or a manual operator trigger. The originating linkage is
preserved via `originating_run_id` / `originating_pressure_event_id` so the
operator-facing record can always be traced back to the kernel ledger.

Distinct from `report_ingestion`: that module imports findings produced by
external PR review agents into ARIA's belief graph. This module emits
findings ARIA's own adapters / skills / operator triggers create.
"""
from __future__ import annotations

import hashlib
import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .agent_genesis import BANNED_PHRASES
from .tool_registry import GovernanceError, append_tools_governance, ensure_tools_binding


SEVERITIES = ("HIGH", "MEDIUM", "LOW", "INFORMATIONAL")
STATUSES = ("OPEN", "IN_PROGRESS", "RESOLVED", "SUPPRESSED", "WITHDRAWN")
CERTAINTIES = ("CONFIRMED", "OBSERVED", "SUSPECTED", "UNCERTAIN", "UNKNOWN")

# Per CONTRACTS §6 claim_type allowlist with severity floor + min evidence count.
CLAIM_TYPES: dict[str, dict[str, Any]] = {
    "spine_drift": {"min_severity": "MEDIUM", "min_evidence": 2},
    "naming_drift": {"min_severity": "LOW", "min_evidence": 2},
    "convention_inconsistency": {"min_severity": "LOW", "min_evidence": 3},
    "wrong_code": {"min_severity": "MEDIUM", "min_evidence": 1},
    "absence_in_scope": {"min_severity": "INFORMATIONAL", "min_evidence": 1},
    "currency_gap": {"min_severity": "INFORMATIONAL", "min_evidence": 1},
    "duplication": {"min_severity": "LOW", "min_evidence": 3},
    "contradiction": {"min_severity": "MEDIUM", "min_evidence": 2},
    "test_disagreement": {"min_severity": "MEDIUM", "min_evidence": 1},
    "regression": {"min_severity": "HIGH", "min_evidence": 2},
}

SEVERITY_RANK = {"INFORMATIONAL": 0, "LOW": 1, "MEDIUM": 2, "HIGH": 3}
SCHEMA_VERSION = 1


def _findings_dir(repo_root: Path) -> Path:
    return Path(repo_root) / "aria-findings"


def _index_path(repo_root: Path) -> Path:
    return _findings_dir(repo_root) / "_index.json"


def _utc_now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _evidence_chain_id(evidences: list[dict[str, Any]]) -> str:
    """Stable hash over the canonical evidence tuple — used to dedupe findings."""
    canonical = json.dumps(
        [{"ref": e["ref"], "summary": e.get("summary", "")} for e in evidences],
        sort_keys=True,
        separators=(",", ":"),
    )
    return "chain_" + hashlib.sha256(canonical.encode("utf-8")).hexdigest()[:16]


def _check_banned_phrases(text: str, *, field: str) -> None:
    """Reject any banned-phrase substring (case-insensitive) per CLAUDE.md."""
    lowered = text.lower()
    for phrase in BANNED_PHRASES:
        if phrase in lowered:
            raise GovernanceError(
                f"finding {field} contains banned phrase '{phrase}': {text!r}"
            )


def _allocate_finding_id(repo_root: Path) -> str:
    """Allocate the next zero-padded sequential ID (F-001, F-002, ...)."""
    findings_dir = _findings_dir(repo_root)
    if not findings_dir.exists():
        return "F-001"
    existing = sorted(p.stem for p in findings_dir.glob("F-*.json"))
    if not existing:
        return "F-001"
    last = existing[-1]
    last_num = int(last.split("-", 1)[1])
    return f"F-{last_num + 1:03d}"


def _validate_inputs(
    *,
    claim_type: str,
    severity: str,
    status: str,
    certainty: str,
    evidences: list[dict[str, Any]],
    claim_summary: str,
    facts: list[str],
    interpretations: list[dict[str, Any]] | None,
) -> None:
    if claim_type not in CLAIM_TYPES:
        raise GovernanceError(f"unknown claim_type: {claim_type}")
    if severity not in SEVERITIES:
        raise GovernanceError(f"invalid severity: {severity}")
    if status not in STATUSES:
        raise GovernanceError(f"invalid status: {status}")
    if certainty not in CERTAINTIES:
        raise GovernanceError(f"invalid certainty: {certainty}")
    floor = CLAIM_TYPES[claim_type]["min_severity"]
    if SEVERITY_RANK.get(severity, -1) < SEVERITY_RANK.get(floor, 0):
        raise GovernanceError(
            f"severity {severity} below floor {floor} for claim_type {claim_type}"
        )
    min_ev = CLAIM_TYPES[claim_type]["min_evidence"]
    if len(evidences) < min_ev:
        raise GovernanceError(
            f"claim_type {claim_type} requires >={min_ev} evidence(s), got {len(evidences)}"
        )
    for idx, ev in enumerate(evidences):
        if "ref" not in ev:
            raise GovernanceError(f"evidence[{idx}] missing 'ref'")
    _check_banned_phrases(claim_summary, field="claim_summary")
    for fact in facts:
        _check_banned_phrases(fact, field="facts[]")
    for entry in interpretations or []:
        text = entry.get("text", "")
        if text:
            _check_banned_phrases(text, field="interpretations[].text")


def _atomic_write_json(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f".{path.name}.tmp")
    tmp.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    tmp.replace(path)


def _refresh_index(repo_root: Path) -> dict[str, Any]:
    findings_dir = _findings_dir(repo_root)
    index: dict[str, Any] = {"schema_version": 1, "generated_at": _utc_now(), "findings": []}
    if not findings_dir.exists():
        _atomic_write_json(_index_path(repo_root), index)
        return index
    rows: list[dict[str, Any]] = []
    for path in sorted(findings_dir.glob("F-*.json")):
        try:
            doc = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        rows.append(
            {
                "finding_id": doc.get("finding_id"),
                "severity": doc.get("severity"),
                "status": doc.get("status"),
                "claim_type": doc.get("claim_type"),
                "claim_summary": doc.get("claim_summary"),
                "evidence_chain_id": doc.get("evidence_chain_id"),
                "created_at": doc.get("created_at"),
                "path": path.name,
            }
        )
    index["findings"] = rows
    _atomic_write_json(_index_path(repo_root), index)
    return index


def emit_finding(
    *,
    repo_root: str | Path,
    base_dir: str | Path | None = None,
    claim_type: str,
    claim_summary: str,
    severity: str,
    certainty: str = "OBSERVED",
    evidences: list[dict[str, Any]],
    facts: list[str],
    scope_files: list[str],
    originating_skill: str = "manual:operator",
    originating_run_id: str | None = None,
    originating_pressure_event_id: str | None = None,
    interpretations: list[dict[str, Any]] | None = None,
    recommendation: dict[str, Any] | None = None,
    related_specialized_agent_domains: list[str] | None = None,
) -> dict[str, Any]:
    """Emit a hash-chained operator-facing finding.

    Why: Plan 016 Faz A2 closes the operator-visibility gap. Until a finding
    can land on disk under aria-findings/ + register a finding_emitted
    governance event, ARIA cycles produce raw observations the operator
    never sees. This primitive enforces every CONTRACTS §6 invariant
    (claim_type allowlist, severity floor, evidence count, banned-phrase
    gate) at emission time so daily reports can trust the record.
    """
    repo_path = Path(repo_root).resolve()
    tools_root = ensure_tools_binding(base_dir, workspace_root=repo_path)

    _validate_inputs(
        claim_type=claim_type,
        severity=severity,
        status="OPEN",
        certainty=certainty,
        evidences=evidences,
        claim_summary=claim_summary,
        facts=facts,
        interpretations=interpretations,
    )

    finding_id = _allocate_finding_id(repo_path)
    chain_id = _evidence_chain_id(evidences)
    record: dict[str, Any] = {
        "$schema": "aria/finding/v1",
        "finding_id": finding_id,
        "severity": severity,
        "status": "OPEN",
        "claim_type": claim_type,
        "claim_summary": claim_summary,
        "certainty": certainty,
        "evidence_chain_id": chain_id,
        "evidences": evidences,
        "originating_skill": originating_skill,
        "originating_run_id": originating_run_id,
        "originating_pressure_event_id": originating_pressure_event_id,
        "scope": {"files": list(scope_files)},
        "related_specialized_agent_domains": list(related_specialized_agent_domains or []),
        "facts": list(facts),
        "interpretations": list(interpretations or []),
        "recommendation": recommendation,
        "created_at": _utc_now(),
        "closes_in_commit": None,
        "schema_version": SCHEMA_VERSION,
    }

    output_path = _findings_dir(repo_path) / f"{finding_id}.json"
    if output_path.exists():
        raise GovernanceError(f"finding {finding_id} already exists at {output_path}")
    _atomic_write_json(output_path, record)
    _refresh_index(repo_path)

    append_tools_governance(
        tools_root,
        "finding_emitted",
        {
            "finding_id": finding_id,
            "severity": severity,
            "claim_type": claim_type,
            "evidence_chain_id": chain_id,
            "originating_skill": originating_skill,
            "path": output_path.relative_to(repo_path).as_posix(),
        },
    )
    return record


def list_findings(repo_root: str | Path) -> list[dict[str, Any]]:
    repo_path = Path(repo_root).resolve()
    index = _refresh_index(repo_path)
    return list(index.get("findings", []))


def show_finding(repo_root: str | Path, finding_id: str) -> dict[str, Any]:
    repo_path = Path(repo_root).resolve()
    path = _findings_dir(repo_path) / f"{finding_id}.json"
    if not path.exists():
        raise GovernanceError(f"finding {finding_id} not found")
    return json.loads(path.read_text(encoding="utf-8"))


def find_by_evidence_chain_id(repo_root: str | Path, chain_id: str) -> dict[str, Any] | None:
    """Helper for callers (e.g. debt.py) verifying originating_finding linkage."""
    for row in list_findings(repo_root):
        if row.get("evidence_chain_id") == chain_id:
            return show_finding(repo_root, row["finding_id"])
    return None
