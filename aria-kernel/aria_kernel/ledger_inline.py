"""Inline-row byte discipline for hash-chained ledger writers.

ARIA-HIGH-017 bounded ``runs.jsonl``; ARIA-HIGH-034 found the same
unbounded shape in ``fixture-runs.jsonl`` (a 1.46 MB row — 1 323 checked
sources + 2 996 evidence envelopes serialised inline) and made the append
primitive refuse oversized rows outright (``ledger.LEDGER_ROW_MAX_BYTES``).

A ledger row is an append-only, hash-chained INDEX, not a payload store.
Derived diagnostic fields that grow with the repository (evidence
validation inventories above all) must therefore be bounded at the
writer. This module is the one implementation every writer shares:
structural keys stay inline and queryable, unbounded lists keep a sample
plus a total/digest marker, and the full value is replaced by a digest
stub that names where (or how) it can be recovered.

The helpers are pure: same input, same output, no I/O.
"""

from __future__ import annotations

import hashlib
import json
from typing import Any

# Per-field inline budget. Well under ``ledger.LEDGER_ROW_MAX_BYTES`` so a row
# carrying several bounded fields plus the chain hashes still clears the
# primitive's cap with wide margin.
INLINE_ROW_FIELD_MAX_BYTES = 128 * 1024

# The keys consumers read from every validation object (readiness, pressure,
# reflection, governance, fixture verdicts) stay inline even when the bulk
# spills — the row remains queryable exactly as before.
EVIDENCE_VALIDATION_STRUCTURAL_KEYS = (
    "repository_mutation_attempt",
    "valid",
    "errors",
    "evidence_sources",
)

EVIDENCE_VALIDATION_LIST_SAMPLES = {
    "evidence_sources": 100,
    "errors": 20,
}


def _serialize(value: Any) -> bytes:
    return json.dumps(value, ensure_ascii=False, default=str).encode("utf-8")


def spill_oversized_inline(field: str, value: Any, *, recovery: str) -> Any:
    """Return ``value`` unchanged under the cap, else a digest stub.

    ``recovery`` names where the full value lives or how it is rebuilt —
    the stub is only honest when the reader can act on it.
    """
    serialized = _serialize(value)
    size = len(serialized)
    if size <= INLINE_ROW_FIELD_MAX_BYTES:
        return value
    digest = hashlib.sha256(serialized).hexdigest()
    return {
        "spilled": True,
        "sha256": f"sha256:{digest}",
        "size_bytes": size,
        "total_marker": "see:size_bytes",
        "recovery": f"{field} exceeded the inline row cap; {recovery}",
    }


def spill_evidence_validation(validation: dict[str, Any], *, recovery: str) -> dict[str, Any]:
    """Bound an ``evidence_validation`` object for inline storage.

    Under the cap the object is returned as-is. Over it: structural keys are
    kept (lists sampled with a total + digest marker) and the whole object is
    represented once more as a digest stub under ``spilled_bulk``.
    """
    if len(_serialize(validation)) <= INLINE_ROW_FIELD_MAX_BYTES:
        return validation
    kept: dict[str, Any] = {}
    for key in EVIDENCE_VALIDATION_STRUCTURAL_KEYS:
        if key not in validation:
            continue
        value = validation[key]
        sample = EVIDENCE_VALIDATION_LIST_SAMPLES.get(key)
        if sample is not None and isinstance(value, list) and len(value) > sample:
            kept[key] = value[:sample]
            kept[f"{key}_spilled"] = {
                "spilled_sample": True,
                "total": len(value),
                "sha256": "sha256:" + hashlib.sha256(_serialize(value)).hexdigest(),
            }
        else:
            kept[key] = value
    return {
        **kept,
        "spilled_bulk": spill_oversized_inline(
            "evidence_validation", validation, recovery=recovery,
        ),
    }
