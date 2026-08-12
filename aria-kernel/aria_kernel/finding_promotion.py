"""Kapalı Döngü D3 — accepted consensus becomes a durable finding.

WHY: until this module existed, NOTHING converted an `ai_consensus`
true_positive into a committed finding — the loop was "find → judge →
forget" by construction, while confirmed false positives were remembered
forever (fingerprint suppression). This is the missing symmetric half:
a confirmed TRUE positive is promoted exactly once per fingerprint into
the operator-facing `aria-findings/` record (owner-visible, report-rendered,
plan-candidate via scan_f_findings) and never re-judged again.

Contract discipline (verified against finding.emit_finding):
* claim text is CONSTRUCTED from structured fields only — judge free text
  never reaches the banned-phrase gate;
* evidence refs are repo-file paths only, pre-checked for existence so a
  ledger/self-output ref can never poison the emission;
* severity maps lowercase→canonical and respects the claim-type floor;
* the promotion ledger (`promotions.jsonl`, hash-chain-free append like the
  sibling feedback ledgers) is the once-only memory — read by the sampler
  to stop re-judging what is already committed.
"""
from __future__ import annotations

from pathlib import Path
from typing import Any

from .feedback_store import (
    append_jsonl,
    load_feedback,
    load_jsonl,
    promotions_path,
)
from .tool_registry import ensure_tools_dir, utc_now

_SEVERITY_MAP = {
    "low": "LOW",
    "medium": "MEDIUM",
    "high": "HIGH",
    "critical": "HIGH",
    "informational": "INFORMATIONAL",
}
_SEVERITY_RANK = {"INFORMATIONAL": 0, "LOW": 1, "MEDIUM": 2, "HIGH": 3}
_CLAIM_TYPE = "wrong_code"  # min_evidence 1, floor MEDIUM (finding.CLAIM_TYPES)
_CLAIM_FLOOR = "MEDIUM"


def promoted_fingerprints(base_dir: str | Path | None = None) -> set[str]:
    """Fingerprints that already have a committed finding."""
    path = promotions_path(base_dir)
    return {
        str(row.get("finding_fingerprint"))
        for row in (load_jsonl(path) if path.exists() else [])
        if row.get("finding_fingerprint")
    }


def _severity_for(raw: str) -> str:
    mapped = _SEVERITY_MAP.get(str(raw).lower(), "MEDIUM")
    if _SEVERITY_RANK[mapped] < _SEVERITY_RANK[_CLAIM_FLOOR]:
        return _CLAIM_FLOOR
    return mapped


def _repo_file_refs(row: dict[str, Any], repo_root: Path) -> list[str]:
    """Evidence refs that resolve to real repo files (path[:line])."""
    refs: list[str] = []
    for ref in row.get("evidence_refs") or []:
        if not isinstance(ref, str) or not ref.strip():
            continue
        path_part = ref.split(":", 1)[0]
        candidate = (repo_root / path_part)
        try:
            resolved = candidate.resolve()
            resolved.relative_to(repo_root.resolve())
        except (OSError, ValueError):
            continue
        if resolved.is_file():
            refs.append(ref)
    return refs


def promote_consensus_findings(
    *,
    repo_root: str | Path,
    base_dir: str | Path | None = None,
) -> dict[str, Any]:
    """Promote every unpromoted ai_consensus true_positive; idempotent."""
    from .finding import emit_finding

    repo_path = Path(repo_root).resolve()
    root = ensure_tools_dir(base_dir)
    already = promoted_fingerprints(root)
    promoted: list[dict[str, Any]] = []
    skipped: list[dict[str, Any]] = []

    for row in load_feedback(base_dir=root):
        if row.get("source_type") != "ai_consensus":
            continue
        if row.get("verdict") != "true_positive":
            continue
        fingerprint = str(row.get("finding_fingerprint") or "")
        if not fingerprint or fingerprint in already:
            continue
        refs = _repo_file_refs(row, repo_path)
        if not refs:
            skipped.append({
                "finding_fingerprint": fingerprint,
                "reason": "no_repo_verified_evidence",
            })
            continue
        scope_files = sorted({ref.split(":", 1)[0] for ref in refs})
        confidence = row.get("confidence")
        summary = (
            f"AI consensus confirmed true positive at {scope_files[0]} "
            f"(tool {row.get('tool_id')}, finding {row.get('finding_id')}"
            + (f", confidence {confidence}" if confidence is not None else "")
            + ")"
        )
        finding = emit_finding(
            repo_root=repo_path,
            base_dir=root,
            claim_type=_CLAIM_TYPE,
            claim_summary=summary,
            severity=_severity_for(str(row.get("severity") or "medium")),
            evidences=[{"ref": ref} for ref in refs],
            facts=[
                f"finding_fingerprint={fingerprint}",
                f"judgment_group_id={row.get('judgment_group_id')}",
                f"consensus_run_id={row.get('run_id')}",
            ],
            scope_files=scope_files,
            originating_skill="ai_consensus:judgment_pipeline",
            originating_run_id=str(row.get("run_id") or "") or None,
        )
        already.add(fingerprint)
        append_jsonl(
            promotions_path(root),
            {
                "schema_version": 1,
                "recorded_at": utc_now(),
                "finding_fingerprint": fingerprint,
                "finding_id": finding.get("finding_id"),
                "tool_id": row.get("tool_id"),
                "judgment_group_id": row.get("judgment_group_id"),
            },
        )
        promoted.append({
            "finding_fingerprint": fingerprint,
            "finding_id": finding.get("finding_id"),
        })

    return {
        "schema_version": 1,
        "promoted": promoted,
        "skipped": skipped,
        "promoted_count": len(promoted),
        "skipped_count": len(skipped),
    }
