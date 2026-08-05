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
import re
import subprocess
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .agent_genesis import BANNED_PHRASES
from .diagnostics import emit_ledger_corruption_diagnostic
from .evidence_trust import classify_evidence_ref
from .ledger import append_declared_jsonl, load_declared_jsonl
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
    # V10.5 Phase 1 (per ADR-0002) — runtime state-machine anomaly observed
    # by ARIA-Watchdog. Semantically distinct from convention_inconsistency
    # (which is naming/format drift in code surface); operational_anomaly
    # is for stall / bridge_warning_repeat / rejection_repeat / phase_asymmetry
    # patterns detected at runtime.
    "operational_anomaly": {"min_severity": "LOW", "min_evidence": 3},
}

# V10.5 Phase 1 (per ADR-0002 + AISAFETY-HIGH-008) — closed allowlist for
# originating_skill field. emit_finding rejects unknown values to prevent
# external callers (e.g. report_ingestion) from forging "aria-watchdog:*"
# prefix and bypassing topology guards in the V10.6 self-feed source.
ORIGINATING_SKILL_ALLOWLIST: frozenset[str] = frozenset({
    "manual:operator",
    "aria-watchdog:stall",
    "aria-watchdog:bridge_warning_repeat",
    "report_ingestion:external_pr",
    # V10.6 detectors registered here when F-AUTO-V10.6-EXTRA-DETECTORS lands:
    # "aria-watchdog:rejection_repeat",
    # "aria-watchdog:phase_asymmetry",
})

SEVERITY_RANK = {"INFORMATIONAL": 0, "LOW": 1, "MEDIUM": 2, "HIGH": 3}
SCHEMA_VERSION = 1
FINDING_ID_RE = re.compile(r"^F-\d{3,}$")


def _findings_dir(repo_root: Path) -> Path:
    # Resolved through the one seam so findings survive the runner —
    # see workspace.repo_state_root for why they did not.
    from .workspace import repo_state_root

    return repo_state_root(Path(repo_root)) / "aria-findings"


def _index_path(repo_root: Path) -> Path:
    return _findings_dir(repo_root) / "_index.json"


def _events_path(repo_root: Path) -> Path:
    return _findings_dir(repo_root) / "finding-events.jsonl"


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
    """Allocate the next zero-padded sequential ID from the event ledger."""
    existing: list[str] = []
    for event in load_declared_jsonl(_events_path(repo_root), expected_surface="repo_finding_events"):
        finding_id = str(event.get("finding_id") or "")
        if event.get("event") == "finding_emitted" and FINDING_ID_RE.match(finding_id):
            existing.append(finding_id)
    if not existing:
        return "F-001"
    last_num = max(int(finding_id.split("-", 1)[1]) for finding_id in existing)
    return f"F-{last_num + 1:03d}"


def _validate_originating_skill(originating_skill: str) -> None:
    """V10.5 Phase 1 (AISAFETY-HIGH-008 + ADR-0002) — closed-allowlist check.

    Rejects originating_skill values outside ORIGINATING_SKILL_ALLOWLIST so
    external callers cannot forge an "aria-watchdog:*" prefix and bypass
    V10.6 self-feed topology guards.
    """
    if originating_skill not in ORIGINATING_SKILL_ALLOWLIST:
        raise GovernanceError(
            f"originating_skill {originating_skill!r} not in "
            f"ORIGINATING_SKILL_ALLOWLIST (V10.5 ADR-0002). Allowed values: "
            f"{sorted(ORIGINATING_SKILL_ALLOWLIST)!r}"
        )


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


def _target_sha(repo_root: Path) -> str:
    completed = subprocess.run(
        ["git", "rev-parse", "HEAD"],
        cwd=repo_root,
        text=True,
        capture_output=True,
        check=False,
    )
    if completed.returncode != 0 or not completed.stdout.strip():
        raise GovernanceError("finding_evidence_target_sha_unavailable")
    return completed.stdout.strip()


def _normalize_evidences(
    repo_root: Path,
    evidences: list[dict[str, Any]],
    *,
    target_sha: str,
) -> list[dict[str, Any]]:
    normalized: list[dict[str, Any]] = []
    for ev in evidences:
        row = dict(ev)
        envelope = classify_evidence_ref(
            row.get("ref"),
            workspace_root=repo_root,
            source_hint="repo_source",
            context="finding",
            target_sha=target_sha,
        )
        if envelope.self_output_class == "aria_self_output":
            raise GovernanceError(
                f"finding evidence cannot cite ARIA self-output: {row.get('ref')!r}"
            )
        if envelope.trust_grade != "repo_verified":
            raise GovernanceError(
                "finding evidence must be repo_verified at target_sha: "
                f"ref={row.get('ref')!r} trust_grade={envelope.trust_grade!r} "
                f"errors={envelope.validation_errors!r}"
            )
        row["evidence_envelope"] = envelope.to_dict()
        normalized.append(row)
    return normalized


def _atomic_write_json(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f".{path.name}.tmp")
    tmp.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    tmp.replace(path)


def _refresh_index(
    repo_root: Path,
    *,
    on_corruption: str = "advisory",
) -> dict[str, Any]:
    """Rebuild the finding index from the canonical event ledger only."""
    if on_corruption not in {"strict", "advisory"}:
        raise GovernanceError(
            f"refresh_index_invalid_on_corruption_mode: "
            f"{on_corruption!r} (must be 'strict' or 'advisory')"
        )
    rows: list[dict[str, Any]] = []
    replayed = _replay_findings(repo_root)
    event_rows = load_declared_jsonl(_events_path(repo_root), expected_surface="repo_finding_events")
    source_tip = event_rows[-1].get("ledger_hash") if event_rows else None
    for finding_id in sorted(replayed):
        doc = replayed[finding_id]
        rows.append(
            {
                "finding_id": doc.get("finding_id"),
                "severity": doc.get("severity"),
                "status": doc.get("status"),
                "claim_type": doc.get("claim_type"),
                "claim_summary": doc.get("claim_summary"),
                "evidence_chain_id": doc.get("evidence_chain_id"),
                "created_at": doc.get("created_at"),
                "path": f"{finding_id}.json",
                "source_event_id": doc.get("source_event_id"),
                "source_ledger_hash": doc.get("source_ledger_hash"),
            }
        )
    index: dict[str, Any] = {
        "schema_version": 2,
        "generated_at": _utc_now(),
        "source_ledger": _events_path(repo_root).relative_to(repo_root).as_posix(),
        "source_ledger_tip_hash": source_tip,
        "findings": rows,
    }
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

    Plan 026R §A.4 — frozen-profile gate at function entry. Pre-§A.4
    finding emission was a Plan 020 legacy mutator that frozen profile
    did NOT cover; an incident-response operator who froze the kernel
    could still have findings written into the audit trail. Now blocked
    under frozen via the ``finding`` surface_kind in
    PLAN_020_WRITE_SURFACES.
    """
    from .runtime_profile import enforce_profile_for_write
    from .file_lock import with_exclusive_lock
    enforce_profile_for_write("finding", base_dir=base_dir)
    repo_path = Path(repo_root).resolve()
    tools_root = ensure_tools_binding(base_dir, workspace_root=repo_path)

    # V10.5 Phase 1 (AISAFETY-HIGH-008 + ADR-0002) — originating_skill allowlist.
    _validate_originating_skill(originating_skill)

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

    target_sha = _target_sha(repo_path)
    evidences = _normalize_evidences(repo_path, evidences, target_sha=target_sha)
    findings_dir = _findings_dir(repo_path)
    findings_dir.mkdir(parents=True, exist_ok=True)
    alloc_lock_path = findings_dir / ".alloc.lock"
    chain_id = _evidence_chain_id(evidences)
    with with_exclusive_lock(alloc_lock_path, timeout_seconds=5.0):
        finding_id = _allocate_finding_id(repo_path)
        record = {
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
        event = append_declared_jsonl(
            _events_path(repo_path),
            {
                "schema_version": 1,
                "event": "finding_emitted",
                "event_id": f"finding:{finding_id}:emitted",
                "finding_id": finding_id,
                "target_sha": target_sha,
                "record": record,
            },
            expected_surface="repo_finding_events",
        )
        record["source_event_id"] = event.get("event_id")
        record["source_ledger_hash"] = event.get("ledger_hash")
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
    return [
        {
            "finding_id": doc.get("finding_id"),
            "severity": doc.get("severity"),
            "status": doc.get("status"),
            "claim_type": doc.get("claim_type"),
            "claim_summary": doc.get("claim_summary"),
            "evidence_chain_id": doc.get("evidence_chain_id"),
            "created_at": doc.get("created_at"),
            "path": f"{doc.get('finding_id')}.json",
            "source_ledger_hash": doc.get("source_ledger_hash"),
        }
        for doc in _replay_findings(repo_path).values()
    ]


def show_finding(repo_root: str | Path, finding_id: str) -> dict[str, Any]:
    repo_path = Path(repo_root).resolve()
    if not FINDING_ID_RE.match(finding_id):
        raise GovernanceError(f"finding_id format invalid: {finding_id!r}")
    record = _replay_findings(repo_path).get(finding_id)
    if record is None:
        raise GovernanceError(f"finding {finding_id} not found")
    return record


def find_by_evidence_chain_id(repo_root: str | Path, chain_id: str) -> dict[str, Any] | None:
    """Helper for callers (e.g. debt.py) verifying originating_finding linkage."""
    for row in list_findings(repo_root):
        if row.get("evidence_chain_id") == chain_id:
            return show_finding(repo_root, row["finding_id"])
    return None


def _replay_findings(repo_root: Path) -> dict[str, dict[str, Any]]:
    path = _events_path(repo_root)
    rows = load_declared_jsonl(path, expected_surface="repo_finding_events")
    findings: dict[str, dict[str, Any]] = {}
    for event in rows:
        if event.get("event") != "finding_emitted":
            continue
        finding_id = str(event.get("finding_id") or "")
        if not FINDING_ID_RE.match(finding_id):
            raise GovernanceError(f"finding event has invalid finding_id: {finding_id!r}")
        record = event.get("record")
        if not isinstance(record, dict):
            raise GovernanceError(f"finding event {event.get('event_id')!r} missing record")
        source_ledger_hash = event.get("ledger_hash")
        if not isinstance(source_ledger_hash, str) or not source_ledger_hash:
            raise GovernanceError(f"finding event {event.get('event_id')!r} missing ledger_hash")
        doc = dict(record)
        doc["source_event_id"] = event.get("event_id")
        doc["source_ledger_hash"] = source_ledger_hash
        findings[finding_id] = doc
    return findings
