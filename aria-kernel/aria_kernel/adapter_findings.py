"""The adapter finding a fingerprint was computed from (ARIA-HIGH-324/325).

Judgment rows, consensus rows and gold items carry a fingerprint, never the
finding. Its rule (which contract frames a replayed judgment) and its path
(where a promoted finding is located) are read back from the ledgers the
kernel fingerprinted it into; a row counts only when the fingerprint
recomputes from the finding itself.
"""
from __future__ import annotations

from pathlib import Path
from typing import Any

from .feedback_store import finding_fingerprint, findings_path, load_jsonl, raw_findings_path
from .tool_registry import ensure_tools_dir


def adapter_findings_by_fingerprint(
    wanted: set[str],
    *,
    base_dir: str | Path | None = None,
) -> dict[str, dict[str, Any]]:
    """fingerprint -> adapter finding, for every fingerprint in ``wanted`` the
    ledgers still hold. Absent fingerprints are absent from the result; the
    caller decides what an unresolved finding means for it."""
    from .runtime_artifacts import resolve_finding_from_artifact

    root = ensure_tools_dir(base_dir)
    found: dict[str, dict[str, Any]] = {}
    for ledger in (findings_path(root), raw_findings_path(root)):
        if not (wanted - set(found)) or not ledger.exists():
            continue
        for row in load_jsonl(ledger):
            fingerprint = str(row.get("finding_fingerprint") or "")
            if fingerprint not in wanted or fingerprint in found:
                continue
            finding = row.get("finding") if isinstance(row.get("finding"), dict) else None
            if finding is None and row.get("artifact_ref"):
                finding = resolve_finding_from_artifact(row, base_dir=root)
            if isinstance(finding, dict) and finding_fingerprint(str(row.get("tool_id") or ""), finding) == fingerprint:
                found[fingerprint] = finding
    return found

