"""Plan 029 §D5 — runtime-signal bridge.

ARIA's evidence allowlist is closed to repo-resident sources (the CONTRACTS.md
§5 source_type categories; enforced as the ``repo_verified`` trust grade by
evidence_trust.EvidencePolicy.require_repo_verified). That is load-bearing: the
whole hallucination-resistance comes from "trust evidence, not assertions". The
cost is that a class of bugs visible ONLY at runtime — a Sentry error, a prod
incident, a telemetry anomaly — was structurally invisible: it cannot be
repo-verified, so it had no way in.

This bridge lets runtime signals in WITHOUT corrupting the trust foundation. A
runtime signal is ingested as a distinct, explicitly UNVERIFIED lead
(``trust_grade = "runtime_unverified"``) that references a code area. It is NOT
evidence and is never repo-graded; instead ``run_pressure`` turns each open
signal into operator pressure that points ARIA's normal repo-evidence machinery
at that area. The signal decides *where to look*; the repo evidence still decides
*what is true*. A finding born from investigating a runtime lead must still pass
the same evidence-verification gate as any other.

ARIA-MEDIUM-271 — a runtime observation is an append-only event bound to the
code it concerns. The bridge used to keep one JSON file per signal and
rewrite it on resolve and on quarantine; a signal that recurred after it was
resolved hashed to the same file and was dropped, and the files were no
declared state surface, so no publish ever carried them. Every lifecycle
step is now an event on one declared ledger
(``runtime-signals/events.jsonl``): ``observed`` (each sighting, refs and
text as they arrived), ``resolved`` and ``quarantined`` (closing events that
never touch the observation). :func:`fold_runtime_signals` derives a
signal's state from them, so a sighting after a close opens a new episode,
and repeated sightings while open are counted (``occurrence_count``).
"""
from __future__ import annotations

import hashlib
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .ledger import LedgerIntegrityError, load_declared_jsonl, state_transaction
from .tool_registry import GovernanceError, append_tools_governance, ensure_tools_dir


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

# Bidirectional override and isolate controls (U+202A..U+202E, U+2066..U+2069)
# reorder what an operator SEES without changing what is stored — the
# Trojan-Source class. Refused wherever a control character is.
_BIDI_CONTROLS = frozenset(chr(code) for code in (*range(0x202A, 0x202F), *range(0x2066, 0x206A)))


def _holds_control(text: str, allowed: frozenset[str] = frozenset()) -> bool:
    """True when ``text`` holds a C0/C1 control or a bidi control other than ``allowed``."""
    return any(
        ((ord(char) < 0x20 or 0x7F <= ord(char) <= 0x9F) or char in _BIDI_CONTROLS)
        and char not in allowed
        for char in text
    )


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
    What no ref may carry whatever its shape: a control or bidi-override
    character, whitespace (prose is not a reference), a glob metacharacter,
    and a ``..`` segment or a leading ``/`` or ``~`` hidden behind a token
    prefix (``alert:/etc/passwd``).
    """
    from .canonical_path import resolve_repo_relpath
    from .evidence_trust import parse_evidence_ref
    from .evidence_validator import _is_ledger_pointer_ref, _nameable_path, agent_ref_shape_refusal

    if not isinstance(ref, str) or not ref.strip():
        raise GovernanceError("runtime_signal_ref_not_string: a code ref is a non-empty string")
    if len(ref) > MAX_CODE_REF_CHARS:
        raise GovernanceError(f"runtime_signal_ref_too_long: {ref[:80]!r}... exceeds {MAX_CODE_REF_CHARS} chars")
    if not _nameable_path(ref) or _holds_control(ref):
        raise GovernanceError(
            f"agent_evidence_path_unresolvable: {ref[:120]!r} holds a control or bidi-override character"
        )
    if any(char.isspace() for char in ref):
        raise GovernanceError(f"runtime_signal_ref_whitespace: {ref[:120]!r} is prose, not a reference")
    if _GLOB_METACHARACTERS.intersection(ref):
        raise GovernanceError(f"runtime_signal_ref_glob: {ref[:120]!r} is a pattern, not a reference")
    # Every colon-separated part is checked, so `alert:/etc/passwd` and
    # `sarif:~/x` are refused like a bare `/etc/passwd`.
    if any(part.startswith(("/", "~")) for part in ref.split(":")) or ".." in ref.replace(":", "/").split("/"):
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
    allowed = frozenset({"\n", "\r", "\t"}) if allow_newlines else frozenset()
    if _holds_control(text, allowed):
        raise GovernanceError(f"runtime_signal_{field}_control_character: {text[:80]!r}")
    return text


RUNTIME_SIGNAL_EVENTS_SURFACE = "runtime_signal_events"
RUNTIME_SIGNAL_EVENT_SCHEMA = "aria/runtime-signal-event/v1"
OBSERVED_EVENT = "observed"
RESOLVED_EVENT = "resolved"
QUARANTINED_EVENT = "quarantined"
# The status each event leaves a signal in.
_STATUS_AFTER: dict[str, str] = {OBSERVED_EVENT: "open", RESOLVED_EVENT: "resolved", QUARANTINED_EVENT: "quarantined"}
_OBSERVATION_FIELDS: tuple[str, ...] = (
    "source", "service", "summary", "code_refs", "severity", "reported_severity", "trust_grade",
)

# ARIA-MEDIUM-271 — the signals a kernel-owned producer outside the cycle
# raises, by name. The dataflow watchdog cannot write the store the cycle
# reads (it runs in its own checkout, and the cycle owns the store's
# publish), so it dispatches the cycle naming one of these and the cycle
# ingests it into its own store before it runs. A name, not text: the
# dispatch input is a closed vocabulary, and the summary stays the stable
# text the signal id is derived from.
STANDING_RUNTIME_SIGNALS: dict[str, dict[str, Any]] = {
    "dataflow_integrity_critical": {
        "source": "telemetry",
        "service": "platform-edge",
        "summary": "dataflow watchdog: critical probe failure",
        "code_refs": ["tools/watchdog/probe-runner.mjs"],
        "severity": "critical",
    },
}


def runtime_signal_events_path(tools_root: str | Path) -> Path:
    """The one ledger every runtime-signal event lands on (a literal, so the
    ledger-roster sweep sees this writer)."""
    tools_root = Path(tools_root)
    return tools_root / "runtime-signals" / "events.jsonl"


def _derive_signal_id(source: str, service: str, summary: str, code_refs: list[str]) -> str:
    digest = hashlib.sha256(
        "|".join([source, service, summary, *sorted(code_refs)]).encode("utf-8")
    ).hexdigest()[:16]
    return f"runtime-{digest}"


def fold_runtime_signals(events: list[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    """Each signal's state from its events, in ledger order.

    An ``observed`` event on a signal that is not open starts a new episode
    (``episode``; ``recorded_at`` is when that episode was first seen); one on
    an open signal counts another sighting (``occurrence_count``,
    ``last_observed_at``). A closing event sets the status and its own
    fields and leaves the observation as it was observed. A row that names no
    known event or signal is not a signal (the ledger has one writer, this
    module).
    """
    records: dict[str, dict[str, Any]] = {}
    for event in events:
        kind = event.get("event")
        signal_id = event.get("signal_id")
        if kind not in _STATUS_AFTER or not isinstance(signal_id, str):
            continue
        record = records.get(signal_id)
        if kind == OBSERVED_EVENT:
            if record is None or record["status"] != "open":
                record = {
                    "$schema": "aria/runtime-signal/v1", "schema_version": 1, "signal_id": signal_id,
                    "episode": (record["episode"] + 1) if record is not None else 1,
                    "recorded_at": event.get("recorded_at"), "occurrence_count": 0,
                }
            for field in _OBSERVATION_FIELDS:
                if field in event:
                    record[field] = event[field]
                else:
                    record.pop(field, None)
            record["status"] = "open"
            record["occurrence_count"] += 1
            record["last_observed_at"] = event.get("recorded_at")
            records[signal_id] = record
            continue
        if record is None:
            continue
        record = dict(record)
        record["status"] = _STATUS_AFTER[kind]
        if kind == RESOLVED_EVENT:
            record["resolved_at"] = event.get("recorded_at")
            record["resolution_note"] = event.get("resolution_note")
        else:
            record["quarantined_at"] = event.get("recorded_at")
            record["quarantine_reason"] = event.get("reason")
        records[signal_id] = record
    return records


def _load_events(root: Path, transaction: Any = None) -> list[dict[str, Any]]:
    path = runtime_signal_events_path(root)
    if not path.exists():
        return []
    if transaction is not None:
        return transaction.load_declared_jsonl(path, expected_surface=RUNTIME_SIGNAL_EVENTS_SURFACE)
    return load_declared_jsonl(path, expected_surface=RUNTIME_SIGNAL_EVENTS_SURFACE)


def _stamp(now: datetime | None) -> str:
    return (now or datetime.now(timezone.utc)).strftime("%Y-%m-%dT%H:%M:%SZ")


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
    """Record one sighting of an external runtime signal as an UNVERIFIED investigation lead.

    The same (source, service, summary, code_refs) is the same signal: a
    sighting while it is open counts another occurrence, a sighting after it
    was resolved or quarantined opens a new episode (ARIA-MEDIUM-271).
    Returns the signal's folded record.
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
    event: dict[str, Any] = {
        "$schema": RUNTIME_SIGNAL_EVENT_SCHEMA,
        "schema_version": 1,
        "event": OBSERVED_EVENT,
        "signal_id": signal_id,
        "source": source,
        "service": service,
        "summary": summary,
        "code_refs": code_refs,
        "severity": severity,
        # NOT evidence. An explicit, non-repo_verified grade so no downstream
        # consumer can mistake a runtime lead for confirmed repo evidence.
        "trust_grade": RUNTIME_TRUST_GRADE,
        "recorded_at": _stamp(now),
    }
    if reported_severity != severity:
        event["reported_severity"] = reported_severity
    path = runtime_signal_events_path(root)
    path.parent.mkdir(parents=True, exist_ok=True)
    with state_transaction([root / "governance.jsonl", path]) as txn:
        events = _load_events(root, txn)
        prior = fold_runtime_signals(events).get(signal_id)
        txn.append_declared_jsonl(path, event, expected_surface=RUNTIME_SIGNAL_EVENTS_SURFACE)
        if prior is None or prior["status"] != "open":
            # A new episode is disclosed; a repeat sighting of an open signal
            # is counted on its record, not announced again.
            details = {"signal_id": signal_id, "source": source, "service": service, "severity": severity}
            if prior is not None:
                details["reopened_from"] = prior["status"]
            append_tools_governance(root, "runtime_signal_ingested", details, transaction=txn)
    return fold_runtime_signals([*events, event])[signal_id]


def ingest_standing_runtime_signal(
    *, name: str, base_dir: str | Path | None = None, now: datetime | None = None,
) -> dict[str, Any]:
    """Ingest the kernel-owned signal ``name`` names (:data:`STANDING_RUNTIME_SIGNALS`)."""
    spec = STANDING_RUNTIME_SIGNALS.get(name) if isinstance(name, str) else None
    if spec is None:
        raise GovernanceError(f"runtime_signal_standing_unknown: {str(name)[:64]!r}")
    return ingest_runtime_signal(
        source=spec["source"], service=spec["service"], summary=spec["summary"],
        code_refs=list(spec["code_refs"]), severity=spec["severity"], base_dir=base_dir, now=now,
    )


_SIGNAL_ID_RE = re.compile(r"^runtime-[0-9a-f]{16}$")
_SEVERITY_ORDER = {"critical": 0, "high": 1, "medium": 2, "low": 3}


def _require_signal_id(signal_id: Any) -> str:
    """``signal_id`` when it is a bridge-minted id, else a GovernanceError."""
    if not isinstance(signal_id, str) or not _SIGNAL_ID_RE.match(signal_id):
        raise GovernanceError(f"runtime_signal_id_invalid: {str(signal_id)[:80]!r}")
    return signal_id


def _ref_law_refusal(doc: dict[str, Any]) -> tuple[list[str], str | None]:
    """``(canonical_refs, None)`` when every stored ref passes the current ref law, else ``([], reason)``."""
    refs = doc.get("code_refs")
    if not isinstance(refs, list) or not refs or len(refs) > MAX_CODE_REFS:
        count = len(refs) if isinstance(refs, list) else 0
        return [], f"runtime_signal_refs_invalid: {type(refs).__name__} of {count}"
    canonical: list[str] = []
    try:
        for ref in refs:
            value = canonical_runtime_signal_ref(ref)
            if value not in canonical:
                canonical.append(value)
    except GovernanceError as exc:
        return [], str(exc)
    return canonical, None


def scan_open_runtime_signals(*, base_dir: str | Path | None = None) -> dict[str, list[dict[str, Any]]]:
    """Open signals split by the CURRENT ref law, without writing anything.

    ``open``: signals whose refs all pass ``canonical_runtime_signal_ref``,
    returned with their refs canonical, most severe first. ``refused``:
    open signals that fail it — observed before the bridge enforced the law
    (a `*/*` frame, a `../` escape) — each with its reason, or the ledger
    itself when it cannot be read (its relative path as the id). A refused
    signal never reaches a reader; closing it is
    ``quarantine_refused_runtime_signals``'s job, a profile-gated write a
    cycle phase owns. This function is a pure read, so pressure, belief
    decay and the list verb stay readers under every profile.
    """
    root = ensure_tools_dir(base_dir)
    try:
        events = _load_events(root)
    except (OSError, UnicodeDecodeError, ValueError, LedgerIntegrityError) as exc:
        return {"open": [], "refused": [{
            "signal_id": runtime_signal_events_path(root).relative_to(root).as_posix(),
            "reason": f"runtime_signal_unreadable: {type(exc).__name__}",
        }]}
    rows: list[dict[str, Any]] = []
    refused: list[dict[str, Any]] = []
    for signal_id, record in sorted(fold_runtime_signals(events).items()):
        if record.get("status") != "open":
            continue
        canonical, reason = _ref_law_refusal(record)
        if reason is not None:
            refused.append({"signal_id": signal_id, "reason": reason})
            continue
        rows.append({**record, "code_refs": canonical})
    rows.sort(key=lambda r: (_SEVERITY_ORDER.get(str(r.get("severity")), 9), str(r.get("signal_id"))))
    return {"open": rows, "refused": refused}


def load_open_runtime_signals(*, base_dir: str | Path | None = None) -> list[dict[str, Any]]:
    """Open runtime signals that pass the current ref law, most severe first (a pure read)."""
    return scan_open_runtime_signals(base_dir=base_dir)["open"]


def quarantine_refused_runtime_signals(
    *,
    base_dir: str | Path | None = None,
    now: datetime | None = None,
) -> dict[str, Any]:
    """Close every open signal the current ref law refuses with a ``quarantined`` event.

    The cycle phase that consumes signals (belief decay) calls this before it
    reads them. With nothing refused it is a pure read and returns at once,
    under every profile. Otherwise the profile gate decides first: a profile
    that may not write governance gets ``status=withheld_by_profile`` with the
    refused signals listed and nothing written (the readers already withhold
    them). In one transaction over the governance and event ledgers: re-fold
    (a concurrent resolve wins — only a still-open, still-refused signal is
    closed), append the closing event and its governance row. The
    observation itself is never rewritten.
    """
    from .runtime_profile import enforce_profile_for_write

    root = ensure_tools_dir(base_dir)
    refused = scan_open_runtime_signals(base_dir=root)["refused"]
    if not refused:
        return {"status": "nothing_refused", "quarantined": [], "unreadable": []}
    try:
        enforce_profile_for_write("tool_governance", base_dir=root)
    except GovernanceError as exc:
        if not str(exc).startswith("profile_violation"):
            raise
        return {"status": "withheld_by_profile", "reason": str(exc)[:200], "refused": refused,
                "quarantined": [], "unreadable": []}
    stamp = _stamp(now)
    quarantined: list[dict[str, Any]] = []
    # A ledger that cannot be read names no signal to close; it is reported
    # on every run until an operator repairs it.
    unreadable = [candidate for candidate in refused if not _SIGNAL_ID_RE.match(str(candidate["signal_id"]))]
    candidates = [candidate for candidate in refused if candidate not in unreadable]
    path = runtime_signal_events_path(root)
    if candidates:
        with state_transaction([root / "governance.jsonl", path]) as txn:
            current = fold_runtime_signals(_load_events(root, txn))
            for candidate in candidates:
                record = current.get(candidate["signal_id"])
                if record is None or record.get("status") != "open":
                    continue
                _, reason = _ref_law_refusal(record)
                if reason is None:
                    continue
                txn.append_declared_jsonl(path, {
                    "$schema": RUNTIME_SIGNAL_EVENT_SCHEMA, "schema_version": 1, "event": QUARANTINED_EVENT,
                    "signal_id": candidate["signal_id"], "reason": reason, "recorded_at": stamp,
                }, expected_surface=RUNTIME_SIGNAL_EVENTS_SURFACE)
                append_tools_governance(
                    root, "runtime_signal_quarantined",
                    {"signal_id": candidate["signal_id"], "reason": reason[:200]}, transaction=txn,
                )
                quarantined.append({"signal_id": candidate["signal_id"], "reason": reason})
    return {"status": "applied", "quarantined": quarantined, "unreadable": unreadable}


def resolve_runtime_signal(
    *,
    signal_id: str,
    resolution_note: str,
    base_dir: str | Path | None = None,
    now: datetime | None = None,
) -> dict[str, Any]:
    """Close a runtime signal once investigated, so it stops driving pressure.

    Appends a ``resolved`` event; the observation is never rewritten, and a
    later sighting of the same signal opens a new episode. Re-folded inside
    the same transaction as the append, so a concurrent quarantine or resolve
    is read before this one is written.
    """
    if not isinstance(resolution_note, str) or not resolution_note.strip():
        raise GovernanceError("resolution_note is required")
    signal_id = _require_signal_id(signal_id)
    root = ensure_tools_dir(base_dir)
    path = runtime_signal_events_path(root)
    path.parent.mkdir(parents=True, exist_ok=True)
    with state_transaction([root / "governance.jsonl", path]) as txn:
        events = _load_events(root, txn)
        record = fold_runtime_signals(events).get(signal_id)
        if record is None:
            raise GovernanceError(f"runtime signal not found: {signal_id}")
        if record["status"] == "resolved":
            return record
        event = {
            "$schema": RUNTIME_SIGNAL_EVENT_SCHEMA, "schema_version": 1, "event": RESOLVED_EVENT,
            "signal_id": signal_id, "resolution_note": resolution_note, "recorded_at": _stamp(now),
        }
        txn.append_declared_jsonl(path, event, expected_surface=RUNTIME_SIGNAL_EVENTS_SURFACE)
        append_tools_governance(root, "runtime_signal_resolved", {"signal_id": signal_id}, transaction=txn)
    return fold_runtime_signals([*events, event])[signal_id]
