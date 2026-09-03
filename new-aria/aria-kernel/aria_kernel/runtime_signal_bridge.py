"""Plan 029 §D5 — runtime-signal bridge.

ARIA's evidence allowlist is closed to repo-resident sources (code_reference,
external_authoritative_source, test_demand, git_history, trusted_config,
trusted_prior_doc). That is load-bearing: the whole hallucination-resistance
comes from "trust evidence, not assertions". The cost is that a class of bugs
visible ONLY at runtime — a Sentry error, a prod incident, a telemetry anomaly —
was structurally invisible: it cannot be repo-verified, so it had no way in.

This bridge lets runtime signals in WITHOUT corrupting the trust foundation. A
runtime signal is ingested as a distinct, explicitly UNVERIFIED lead
(``trust_grade = "runtime_unverified"``) that references a code area. It is NOT
evidence and is never repo-graded; instead ``run_pressure`` turns each open
signal into operator pressure that points ARIA's normal repo-evidence machinery
at that area. The signal decides *where to look*; the repo evidence still decides
*what is true*. A finding born from investigating a runtime lead must still pass
the same evidence-verification gate as any other.
"""
from __future__ import annotations

import hashlib
import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .tool_registry import GovernanceError, append_tools_governance, ensure_tools_dir, utc_now


RUNTIME_SIGNAL_SOURCES = {"sentry", "incident", "prod_log", "telemetry", "operator", "external_scanner"}
RUNTIME_SEVERITIES = {"low", "medium", "high", "critical"}
RUNTIME_TRUST_GRADE = "runtime_unverified"


def _signals_dir(tools_root: Path) -> Path:
    return tools_root / "runtime-signals"


def _signal_path(tools_root: Path, signal_id: str) -> Path:
    return _signals_dir(tools_root) / f"{signal_id}.json"


def _derive_signal_id(source: str, service: str, summary: str, code_refs: list[str]) -> str:
    digest = hashlib.sha256(
        "|".join([source, service, summary, *sorted(code_refs)]).encode("utf-8")
    ).hexdigest()[:16]
    return f"runtime-{digest}"


def ingest_runtime_signal(
    *,
    source: str,
    service: str,
    summary: str,
    code_refs: list[str],
    severity: str = "high",
    base_dir: str | Path | None = None,
    now: datetime | None = None,
) -> dict[str, Any]:
    """Record an external runtime signal as an UNVERIFIED investigation lead.

    Idempotent: a signal with the same (source, service, summary, code_refs)
    returns the existing open record rather than duplicating it.
    """
    if source not in RUNTIME_SIGNAL_SOURCES:
        raise GovernanceError(f"unknown runtime signal source: {source!r}")
    if severity not in RUNTIME_SEVERITIES:
        raise GovernanceError(f"unknown severity: {severity!r}")
    if not isinstance(service, str) or not service.strip():
        raise GovernanceError("service is required")
    if not isinstance(summary, str) or not summary.strip():
        raise GovernanceError("summary is required")
    if not isinstance(code_refs, list) or not code_refs or not all(isinstance(r, str) and r.strip() for r in code_refs):
        raise GovernanceError("code_refs must be a non-empty list of strings (the lead's referenced code area)")

    root = ensure_tools_dir(base_dir)
    signal_id = _derive_signal_id(source, service.strip(), summary.strip(), code_refs)
    path = _signal_path(root, signal_id)
    if path.exists():
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            pass  # overwrite a corrupt record

    ts = (now or datetime.now(timezone.utc)).strftime("%Y-%m-%dT%H:%M:%SZ")
    record = {
        "$schema": "aria/runtime-signal/v1",
        "schema_version": 1,
        "signal_id": signal_id,
        "source": source,
        "service": service.strip(),
        "summary": summary.strip(),
        "code_refs": code_refs,
        "severity": severity,
        # NOT evidence. An explicit, non-repo_verified grade so no downstream
        # consumer can mistake a runtime lead for confirmed repo evidence.
        "trust_grade": RUNTIME_TRUST_GRADE,
        "status": "open",
        "recorded_at": ts,
    }
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(record, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    append_tools_governance(
        root,
        "runtime_signal_ingested",
        {"signal_id": signal_id, "source": source, "service": service.strip(), "severity": severity},
    )
    return record


def load_open_runtime_signals(*, base_dir: str | Path | None = None) -> list[dict[str, Any]]:
    """Open (unresolved) runtime signals, most severe first."""
    root = ensure_tools_dir(base_dir)
    directory = _signals_dir(root)
    if not directory.exists():
        return []
    order = {"critical": 0, "high": 1, "medium": 2, "low": 3}
    rows: list[dict[str, Any]] = []
    for path in directory.glob("*.json"):
        try:
            doc = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        if doc.get("status") == "open":
            rows.append(doc)
    rows.sort(key=lambda r: (order.get(str(r.get("severity")), 9), str(r.get("signal_id"))))
    return rows


def resolve_runtime_signal(
    *,
    signal_id: str,
    resolution_note: str,
    base_dir: str | Path | None = None,
    now: datetime | None = None,
) -> dict[str, Any]:
    """Close a runtime signal once investigated, so it stops driving pressure."""
    if not isinstance(resolution_note, str) or not resolution_note.strip():
        raise GovernanceError("resolution_note is required")
    root = ensure_tools_dir(base_dir)
    path = _signal_path(root, signal_id)
    if not path.exists():
        raise GovernanceError(f"runtime signal not found: {signal_id}")
    record = json.loads(path.read_text(encoding="utf-8"))
    if record.get("status") == "resolved":
        return record
    record["status"] = "resolved"
    record["resolved_at"] = (now or datetime.now(timezone.utc)).strftime("%Y-%m-%dT%H:%M:%SZ")
    record["resolution_note"] = resolution_note
    path.write_text(json.dumps(record, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    append_tools_governance(root, "runtime_signal_resolved", {"signal_id": signal_id})
    return record
