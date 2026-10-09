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

# The record is written from text an outside party can author: Sentry accepts
# events from anyone holding the public DSN, and a log line carries whatever a
# request put in it. These bounds hold at THE door every producer uses — the
# CLI verb, the MCP tool, the SARIF and pack ingesters, the gateway and the
# importer all call ingest_runtime_signal — so no producer can skip them.
MAX_SERVICE_CHARS = 128
MAX_SUMMARY_CHARS = 2000
MAX_CODE_REFS = 32
MAX_CODE_REF_CHARS = 1024

# Sources whose CONTENT an outside party writes. Their reported severity is a
# claim by that party, so it is capped: a forged Sentry `fatal` must not
# become a `critical` lead that outranks every repo-verified pressure. The
# reported value is kept on the record beside the bounded one.
UNTRUSTED_CONTENT_SOURCES = frozenset({"sentry", "prod_log"})
UNTRUSTED_SEVERITY_CEILING = "high"
_SEVERITY_RANK = {"low": 0, "medium": 1, "high": 2, "critical": 3}

# A glob metacharacter names no file in this repository (no tracked path holds
# one) and turns a ref into a pattern for every matcher that reads it — one
# `*/*` frame would touch every belief. Refused at the door.
_GLOB_METACHARACTERS = frozenset("*?[")


def canonical_runtime_signal_ref(ref: Any) -> str:
    """The stored form of one runtime-signal code ref, or a GovernanceError naming why it is refused.

    The ref's PATH shape is decided by the one agent evidence law,
    :func:`evidence_validator.agent_ref_shape_refusal` — absolute paths, ``..``
    escapes, control characters, over-long components and ARIA's own output are
    refused under the codes that law gives them, and an accepted path is stored
    in its canonical repo-relative spelling with its ``:line`` kept. A ref the
    law finds malformed is not a path at all (``alert:HighCpu``,
    ``sarif:semgrep``): it is kept verbatim, and pressure routes it to the
    provenance channel no agent cites (``pressure_evidence.split_citable_refs``).
    Three things no ref may carry whatever its shape: whitespace (prose is not a
    reference), a glob metacharacter, and a ``..`` segment or leading ``/``
    hidden behind a token prefix.
    """
    from .canonical_path import resolve_repo_relpath
    from .evidence_trust import parse_evidence_ref
    from .evidence_validator import _is_ledger_pointer_ref, _nameable_path, agent_ref_shape_refusal

    if not isinstance(ref, str) or not ref.strip():
        raise GovernanceError("runtime_signal_ref_not_string: a code ref is a non-empty string")
    if len(ref) > MAX_CODE_REF_CHARS:
        raise GovernanceError(f"runtime_signal_ref_too_long: {ref[:80]!r}... exceeds {MAX_CODE_REF_CHARS} chars")
    if not _nameable_path(ref):
        raise GovernanceError(f"agent_evidence_path_unresolvable: {ref[:120]!r} holds a control character")
    if any(char.isspace() for char in ref):
        raise GovernanceError(f"runtime_signal_ref_whitespace: {ref[:120]!r} is prose, not a reference")
    if _GLOB_METACHARACTERS.intersection(ref):
        raise GovernanceError(f"runtime_signal_ref_glob: {ref[:120]!r} is a pattern, not a reference")
    if ref.startswith(("/", "~")) or ".." in ref.replace(":", "/").split("/"):
        raise GovernanceError(f"agent_evidence_path_escapes_workspace: {ref[:120]!r}")
    if _is_ledger_pointer_ref(ref):
        raise GovernanceError(f"runtime_signal_ref_ledger_pointer: {ref[:120]!r} names a kernel record, not a code area")
    refusal = agent_ref_shape_refusal(ref)
    if refusal == "agent_evidence_ref_malformed":
        return ref
    if refusal is not None:
        raise GovernanceError(f"{refusal}: {ref[:120]!r}")
    parsed = parse_evidence_ref(ref)
    if parsed is None:  # unreachable: the law accepted the grammar above
        raise GovernanceError(f"agent_evidence_ref_malformed: {ref[:120]!r}")
    path, line = parsed
    canonical = resolve_repo_relpath(path)
    return canonical if line is None else f"{canonical}:{line}"


def _bounded_text(field: str, value: Any, limit: int, *, allow_newlines: bool) -> str:
    if not isinstance(value, str) or not value.strip():
        raise GovernanceError(f"{field} is required")
    text = value.strip()
    if len(text) > limit:
        raise GovernanceError(f"runtime_signal_{field}_too_long: {len(text)} chars exceeds {limit}")
    allowed = {"\n", "\r", "\t"} if allow_newlines else set()
    if any((ord(char) < 0x20 or 0x7F <= ord(char) <= 0x9F) and char not in allowed for char in text):
        raise GovernanceError(f"runtime_signal_{field}_control_character: {text[:80]!r}")
    return text


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
    service = _bounded_text("service", service, MAX_SERVICE_CHARS, allow_newlines=False)
    summary = _bounded_text("summary", summary, MAX_SUMMARY_CHARS, allow_newlines=True)
    if not isinstance(code_refs, list) or not code_refs:
        raise GovernanceError("code_refs must be a non-empty list of strings (the lead's referenced code area)")
    if len(code_refs) > MAX_CODE_REFS:
        raise GovernanceError(f"runtime_signal_too_many_refs: {len(code_refs)} exceeds {MAX_CODE_REFS}")
    canonical_refs: list[str] = []
    for ref in code_refs:
        canonical = canonical_runtime_signal_ref(ref)
        if canonical not in canonical_refs:
            canonical_refs.append(canonical)
    code_refs = canonical_refs
    reported_severity = severity
    if (
        source in UNTRUSTED_CONTENT_SOURCES
        and _SEVERITY_RANK[severity] > _SEVERITY_RANK[UNTRUSTED_SEVERITY_CEILING]
    ):
        severity = UNTRUSTED_SEVERITY_CEILING

    root = ensure_tools_dir(base_dir)
    signal_id = _derive_signal_id(source, service, summary, code_refs)
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
        "service": service,
        "summary": summary,
        "code_refs": code_refs,
        "severity": severity,
        # NOT evidence. An explicit, non-repo_verified grade so no downstream
        # consumer can mistake a runtime lead for confirmed repo evidence.
        "trust_grade": RUNTIME_TRUST_GRADE,
        "status": "open",
        "recorded_at": ts,
    }
    if reported_severity != severity:
        record["reported_severity"] = reported_severity
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(record, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    append_tools_governance(
        root,
        "runtime_signal_ingested",
        {"signal_id": signal_id, "source": source, "service": service, "severity": severity},
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
