"""ARIA-HIGH-363 — what a drift finding is ABOUT, independent of the line it was seen on.

WHY. The drift seeder deduped by ``finding._evidence_chain_id``, a hash over
every evidence ``ref`` and ``summary`` — and a ref carries the line number,
a summary carries the value list. The LeavesPage status filter moved to a
different source line on five nights while the drift itself
(the ``leave-filter-status`` option group against ``LeaveRequestStatus``)
never changed; each move minted a new F (F-003, F-005, F-007, F-008, F-015,
measured on the aria/state store 2026-10-06). Five open findings for one
defect means five plan candidates, and a fix that closes one leaves four for
the aging-F source to plan again.

WHAT. The subject key is the drift class plus the set of (file, declared
name) pairs of its evidence sides — the file and the drifting symbol or
contract, never the line and never the values (the values are what a fix
changes). It is derived at READ time from fields every seeded record already
carries (``claim_summary`` opens with the drift class; each evidence summary
opens with the side's declared name), so no stored finding is rewritten and
the existing duplicates share a key the moment this module reads them. The
seeder computes the key for a fresh drift with :func:`subject_key_from_evidences`
on the evidence list it mints with, so writer and reader cannot derive it two
ways.
"""
from __future__ import annotations

import hashlib
import json
import re
from typing import Any, Iterable, Mapping, Sequence

# The one origin whose records this key is defined for. Other detectors key
# their findings differently, or not at all; a key invented for them here
# would merge findings nobody proved to be the same subject.
DRIFT_ORIGIN: str = "seed:drift-scan"
# ARIA-MEDIUM-378 — a finding promoted from an adapter's output may carry the
# subject its adapter declared (`subject` on the raw finding, `subject=<…>` in
# the promoted record's facts). One defect that breaks two rules (a controller
# that injects a repository AND calls it past the bus) yields two raw findings
# and two promoted records; the shared subject makes them one subject here, so
# the slot policy plans it once and a merge that fixes it closes both.
CONSENSUS_ORIGIN: str = "ai_consensus:judgment_pipeline"
ADAPTER_SUBJECT_FACT_PREFIX: str = "subject="
SUBJECT_KEY_PREFIX: str = "subject_"
# `seed_drift_findings.mint_candidates` writes each evidence summary as
# "<declared name> values: <values>" and the claim summary as
# "<drift_class>: '<concept>' ...".
_SUMMARY_NAME_SEPARATOR = " values: "
_CLAIM_DRIFT_CLASS_RE = re.compile(r"^([A-Za-z0-9_-]+): '")


def _side(evidence: Mapping[str, Any]) -> tuple[str, str] | None:
    ref = str(evidence.get("ref") or "")
    summary = str(evidence.get("summary") or "")
    path = ref.rsplit(":", 1)[0] if re.search(r":\d+$", ref) else ref
    if not path or _SUMMARY_NAME_SEPARATOR not in summary:
        return None
    name = summary.split(_SUMMARY_NAME_SEPARATOR, 1)[0].strip()
    return (path, name) if name else None


def subject_key_from_evidences(
    *, drift_class: str, evidences: Iterable[Mapping[str, Any]],
) -> str | None:
    """The line-independent identity of one drift, or None when it has none.

    None for fewer than two readable sides: a one-sided drift is not a drift
    the seeder mints, and a key over one side would merge unrelated findings
    that happen to cite the same file.
    """
    sides = [_side(evidence) for evidence in evidences]
    if not drift_class or any(side is None for side in sides) or len(set(sides)) < 2:
        return None
    canonical = json.dumps(
        {"drift_class": drift_class, "sides": sorted(set(sides))},
        sort_keys=True, separators=(",", ":"),
    )
    return SUBJECT_KEY_PREFIX + hashlib.sha256(canonical.encode("utf-8")).hexdigest()[:16]


def adapter_subject_key(subject: str) -> str:
    """The subject key of an adapter-declared subject (``<tool>:<defect class>:<file>``)."""
    canonical = json.dumps({"adapter_subject": subject}, sort_keys=True, separators=(",", ":"))
    return SUBJECT_KEY_PREFIX + hashlib.sha256(canonical.encode("utf-8")).hexdigest()[:16]


def normalize_finding_message(message: str) -> str:
    """A finding message as identity sees it: lower case, whitespace collapsed.

    One rule for every reader that keys on a message: the feedback
    fingerprint (``feedback_store.finding_fingerprint``) and the spine's
    violation identity (:func:`adapter_violation_keys`).
    """
    return " ".join(message.lower().split())


# ARIA-HIGH-045 — the ONLY fields of an adapter finding that say what it is
# about. An allowlist, not a denylist: a positional field an adapter adds
# later (``line``, ``column``, an offset, a snippet, a confidence) can only
# be ignored here, so a moved violation never reads as a new one. Equal keys
# do not merge silently: they become a multiset (``#0``, ``#1``…).
_VIOLATION_IDENTITY_FIELDS: tuple[str, ...] = ("rule", "path", "message", "details", "subject")


def adapter_violation_keys(findings: Sequence[Mapping[str, Any]]) -> list[str]:
    """The location-free identities of an adapter's findings, sorted.

    ``<path>::<rule>::<12-hex digest>#<ordinal>``: the digest is over
    :data:`_VIOLATION_IDENTITY_FIELDS` (the message normalized); the ordinal
    numbers findings with an equal key in ``(line, id)`` order, so two
    identical violations in one file stay two and a third one is an
    introduction. The path and rule lead so an identity is locatable.
    """
    keyed: list[tuple[str, int, str]] = []
    for finding in findings:
        rule = str(finding.get("rule") or "")
        path = str(finding.get("path") or "")
        canonical = json.dumps(
            {
                "rule": rule,
                "path": path,
                "message": normalize_finding_message(str(finding.get("message") or "")),
                "details": finding.get("details"),
                "subject": finding.get("subject"),
            },
            sort_keys=True, separators=(",", ":"), ensure_ascii=True, default=str,
        )
        digest = hashlib.sha256(canonical.encode("utf-8")).hexdigest()[:12]
        line = finding.get("line")
        keyed.append((f"{path}::{rule}::{digest}", line if isinstance(line, int) else 0, str(finding.get("id") or "")))
    ordinals: dict[str, int] = {}
    keys: list[str] = []
    for base, _line, _id in sorted(keyed):
        ordinal = ordinals.get(base, 0)
        ordinals[base] = ordinal + 1
        keys.append(f"{base}#{ordinal}")
    return sorted(keys)


def _adapter_subject(record: Mapping[str, Any]) -> str | None:
    for fact in record.get("facts") or []:
        if isinstance(fact, str) and fact.startswith(ADAPTER_SUBJECT_FACT_PREFIX):
            subject = fact[len(ADAPTER_SUBJECT_FACT_PREFIX):].strip()
            return subject or None
    return None


def drift_class_of(record: Mapping[str, Any]) -> str | None:
    match = _CLAIM_DRIFT_CLASS_RE.match(str(record.get("claim_summary") or ""))
    return match.group(1) if match else None


def finding_subject_key(record: Mapping[str, Any]) -> str | None:
    """The subject key of a stored finding record, derived from its own fields."""
    if record.get("originating_skill") == CONSENSUS_ORIGIN:
        subject = _adapter_subject(record)
        return adapter_subject_key(subject) if subject is not None else None
    if record.get("originating_skill") != DRIFT_ORIGIN:
        return None
    drift_class = drift_class_of(record)
    evidences = record.get("evidences")
    if drift_class is None or not isinstance(evidences, list):
        return None
    return subject_key_from_evidences(drift_class=drift_class, evidences=evidences)


def subject_sides(record: Mapping[str, Any]) -> tuple[tuple[str, str], ...]:
    """ARIA-HIGH-369 — the (file, declared name) sides of a record's subject, sorted; () without a subject.

    The same pairs :func:`subject_key_from_evidences` hashes, so a plan seeded
    from them names exactly what the key identifies — never the line, never
    the values.
    """
    if finding_subject_key(record) is None:
        return ()
    return tuple(sorted({side for side in map(_side, record["evidences"]) if side is not None}))


def findings_with_subject(
    findings: Mapping[str, Mapping[str, Any]], subject_key: str,
) -> list[str]:
    """Every finding id whose record derives ``subject_key``, in id order."""
    return sorted(
        finding_id for finding_id, record in findings.items()
        if finding_subject_key(record) == subject_key
    )


__all__ = [
    "ADAPTER_SUBJECT_FACT_PREFIX",
    "CONSENSUS_ORIGIN",
    "DRIFT_ORIGIN",
    "adapter_subject_key",
    "adapter_violation_keys",
    "normalize_finding_message",
    "SUBJECT_KEY_PREFIX",
    "drift_class_of",
    "finding_subject_key",
    "findings_with_subject",
    "subject_key_from_evidences",
    "subject_sides",
]
