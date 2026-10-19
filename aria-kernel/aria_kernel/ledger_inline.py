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

from typing import Any

from .ledger import canonical_json, sha256_digest_of_canonical_json

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


def spill_oversized_inline(field: str, value: Any, *, recovery: str) -> Any:
    """Return ``value`` unchanged under the cap, else a digest stub.

    ``recovery`` names where the full value lives or how it is rebuilt —
    the stub is only honest when the reader can act on it. The size is
    counted, and the digest taken, in ``ledger.canonical_json``, the
    spelling the ledger writes the row in (ARIA-HIGH-617): a UTF-8 count
    let a non-ASCII value take up to three times the budget on the row, and
    a second encoding gave one row two digest spellings.
    """
    size = len(canonical_json(value))
    if size <= INLINE_ROW_FIELD_MAX_BYTES:
        return value
    return {
        "spilled": True,
        "sha256": sha256_digest_of_canonical_json(value),
        "size_bytes": size,
        "total_marker": "see:size_bytes",
        "recovery": f"{field} exceeded the inline row cap; {recovery}",
    }


# Why a sampled list's marker exists: the list did not fit its inline budget.
SAMPLED_LIST_REASON_CODE = "inline_row_list_budget"


def sample_inline_list(
    key: str,
    values: list[Any],
    *,
    limit: int | None,
    json_pointer: str | None,
    recovery: str,
    max_bytes: int = INLINE_ROW_FIELD_MAX_BYTES,
) -> dict[str, Any]:
    """The row fields that stand in for list ``key``: whole, or a bounded sample with a marker.

    The one spelling of a sampled row list (evidence_validation's lists here,
    a run row's read set and scope violations in ``tool_health``). The list is
    stored whole when it has at most ``limit`` entries (``None``: no count
    limit) and its row spelling fits ``max_bytes``. Otherwise the row keeps the
    longest prefix of at most ``limit`` entries that fits ``max_bytes``, so the
    sample is bounded by construction whatever the entries hold (ARIA-HIGH-617:
    twenty 60,000-character entries were within a count limit and made a
    1.2 MB row). An entry is never cut, since a cut path names another file; an
    entry larger than the budget ends the sample. Bytes are counted in
    ``ledger.canonical_json``, the spelling the ledger writes a row in: a
    non-ASCII character is two to four bytes in UTF-8 but a six- or
    twelve-byte escape on the row, so a UTF-8 count would not bound the row.

    ``<key>_spilled`` then records what the No Silent Loss contract
    (docs/aria/runtime-artifact-contract.md) asks of a truncation: the reason
    code, the total, how many entries were kept, the whole list's digest, a
    verification status, and where the whole list lives. The digest is
    ``ledger.sha256_digest_of_canonical_json``, the spelling
    ``runs_reader.read_paths_reference`` names a read set with, so a row never
    carries two digest spellings. ``json_pointer`` addresses the whole list
    inside the row's artifact (``artifact_backed``); without one only the count
    and digest survive (``digest_only``), and ``recovery`` must say so.
    """
    if (limit is None or len(values) <= limit) and len(canonical_json(values)) <= max_bytes:
        return {key: values}
    sample = bounded_prefix(values, limit=limit, max_bytes=max_bytes)
    marker: dict[str, Any] = {
        "spilled_sample": True,
        "reason_code": SAMPLED_LIST_REASON_CODE,
        "total": len(values),
        "sampled": len(sample),
        "sha256": sha256_digest_of_canonical_json(values),
        "verification_status": "artifact_backed" if json_pointer is not None else "digest_only",
        "recovery": recovery,
    }
    if json_pointer is not None:
        marker["json_pointer"] = json_pointer
    return {key: sample, f"{key}_spilled": marker}


def bounded_prefix(values: list[Any], *, limit: int | None, max_bytes: int) -> list[Any]:
    """The longest prefix of ``values``, at most ``limit`` entries, whose row spelling fits ``max_bytes``.

    The one bound on a list a ledger row carries (``sample_inline_list``'s
    sample, the paths a pressure cites of a tool run). An entry is never cut,
    since a cut path names another file, and an entry larger than the budget
    ends the prefix. Bytes are counted in ``ledger.canonical_json``, the
    spelling the ledger writes a row in. ``limit`` ``None``: no count limit.
    """
    prefix: list[Any] = []
    used = len("[]")
    for value in values if limit is None else values[:limit]:
        cost = len(canonical_json(value)) + (len(",") if prefix else 0)
        if used + cost > max_bytes:
            break
        prefix.append(value)
        used += cost
    return prefix


def spill_evidence_validation(validation: dict[str, Any], *, recovery: str) -> dict[str, Any]:
    """Bound an ``evidence_validation`` object for inline storage.

    Under the cap the object is returned as-is. Over it: structural keys are
    kept (lists sampled with a total + digest marker) and the whole object is
    represented once more as a digest stub under ``spilled_bulk``.
    """
    if len(canonical_json(validation)) <= INLINE_ROW_FIELD_MAX_BYTES:
        return validation
    kept: dict[str, Any] = {}
    for key in EVIDENCE_VALIDATION_STRUCTURAL_KEYS:
        if key not in validation:
            continue
        value = validation[key]
        sample = EVIDENCE_VALIDATION_LIST_SAMPLES.get(key)
        if sample is not None and isinstance(value, list):
            kept.update(sample_inline_list(key, value, limit=sample, json_pointer=None, recovery=recovery))
        else:
            kept[key] = value
    return {
        **kept,
        "spilled_bulk": spill_oversized_inline(
            "evidence_validation", validation, recovery=recovery,
        ),
    }
