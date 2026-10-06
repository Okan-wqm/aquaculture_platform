"""ARIA-HIGH-363 — what a drift finding is ABOUT, independent of the line it was seen on.

WHY. The drift seeder deduped by ``finding._evidence_chain_id``, a hash over
every evidence ``ref`` and ``summary`` — and a ref carries the line number,
a summary carries the value list. The LeavesPage status filter moved from
line 346 to 358, 355, 353 and 389 across nights while the drift itself
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
from typing import Any, Iterable, Mapping

# The one origin whose records this key is defined for. Other detectors key
# their findings differently, or not at all; a key invented for them here
# would merge findings nobody proved to be the same subject.
DRIFT_ORIGIN: str = "seed:drift-scan"
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


def drift_class_of(record: Mapping[str, Any]) -> str | None:
    match = _CLAIM_DRIFT_CLASS_RE.match(str(record.get("claim_summary") or ""))
    return match.group(1) if match else None


def finding_subject_key(record: Mapping[str, Any]) -> str | None:
    """The subject key of a stored finding record, derived from its own fields."""
    if record.get("originating_skill") != DRIFT_ORIGIN:
        return None
    drift_class = drift_class_of(record)
    evidences = record.get("evidences")
    if drift_class is None or not isinstance(evidences, list):
        return None
    return subject_key_from_evidences(drift_class=drift_class, evidences=evidences)


def findings_with_subject(
    findings: Mapping[str, Mapping[str, Any]], subject_key: str,
) -> list[str]:
    """Every finding id whose record derives ``subject_key``, in id order."""
    return sorted(
        finding_id for finding_id, record in findings.items()
        if finding_subject_key(record) == subject_key
    )


__all__ = [
    "DRIFT_ORIGIN",
    "SUBJECT_KEY_PREFIX",
    "drift_class_of",
    "finding_subject_key",
    "findings_with_subject",
    "subject_key_from_evidences",
]
