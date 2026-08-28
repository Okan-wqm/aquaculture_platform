"""Operator review record persistence (Plan 017 Phase 6.1).

Plan 016 ships finding + debt + critical observation persistence; the
review surface itself was unrecorded. Operators producing review
artifacts (e.g. the 2026-05-07 Plan 016 implementation review) had no
ledger row pinning the audit decision to the platform. This module
adds `review_record` — a small append-only ledger under
`aria-tools/reviews.jsonl` with hash-chain integrity and a
`review_recorded` governance event per record.

Schema (`aria/operator-review/v1`):

    review_id              auto-generated REV-YYYY-MM-DD-NNN
    scope                  free-text scope identifier (operator-supplied)
    summary                one-paragraph operator note
    findings_referenced[]  list of F-NNN IDs the review touches
    debts_referenced[]     list of DEBT-YYYY-MM-DD-NNN IDs the review touches
    reviewer               operator handle (operator-supplied)
    recorded_at            ISO-8601 UTC
    schema_version         1
"""
from __future__ import annotations

import json
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .ledger import append_declared_jsonl, load_jsonl
from .tool_registry import GovernanceError, append_tools_governance, ensure_tools_dir


REVIEW_ID_RE = re.compile(r"^REV-\d{4}-\d{2}-\d{2}-\d{3}$")
SCHEMA_VERSION = 1


def _reviews_path(tools_root: Path) -> Path:
    return tools_root / "reviews.jsonl"


def _allocate_review_id(tools_root: Path, *, when: datetime) -> str:
    """Date-stamped sequential ID: REV-YYYY-MM-DD-NNN.

    The ledger holds the canonical sequence; we walk it once per emit.
    """
    prefix = when.strftime("REV-%Y-%m-%d-")
    rows = load_jsonl(_reviews_path(tools_root)) if _reviews_path(tools_root).exists() else []
    seq = 0
    for row in rows:
        rid = row.get("review_id", "")
        if REVIEW_ID_RE.match(rid) and rid.startswith(prefix):
            try:
                n = int(rid.rsplit("-", 1)[1])
            except ValueError:
                continue
            if n > seq:
                seq = n
    return f"{prefix}{seq + 1:03d}"


def record_review(
    *,
    scope: str,
    summary: str,
    reviewer: str,
    findings_referenced: list[str] | None = None,
    debts_referenced: list[str] | None = None,
    base_dir: str | Path | None = None,
    now: datetime | None = None,
) -> dict[str, Any]:
    """Append a review record to aria-tools/reviews.jsonl + emit governance event.

    All three string fields are required + non-empty. The findings_referenced
    and debts_referenced lists are accepted as-supplied; existence checks
    against aria-findings/ + aria-debts/ are deliberately advisory rather
    than fail-closed (a review can legitimately cite an external scope,
    e.g. a DEBT not yet emitted on this branch).
    """
    if not isinstance(scope, str) or not scope.strip():
        raise GovernanceError("scope is required")
    if not isinstance(summary, str) or not summary.strip():
        raise GovernanceError("summary is required")
    if not isinstance(reviewer, str) or not reviewer.strip():
        raise GovernanceError("reviewer is required")

    fr = list(findings_referenced or [])
    dr = list(debts_referenced or [])
    for fid in fr:
        if not isinstance(fid, str) or not fid.strip():
            raise GovernanceError("findings_referenced entries must be non-empty strings")
    for did in dr:
        if not isinstance(did, str) or not did.strip():
            raise GovernanceError("debts_referenced entries must be non-empty strings")

    tools_root = ensure_tools_dir(base_dir)
    ts = now or datetime.now(timezone.utc)
    review_id = _allocate_review_id(tools_root, when=ts)
    row = {
        "$schema": "aria/operator-review/v1",
        "schema_version": SCHEMA_VERSION,
        "review_id": review_id,
        "scope": scope,
        "summary": summary,
        "reviewer": reviewer,
        "findings_referenced": fr,
        "debts_referenced": dr,
        "recorded_at": ts.strftime("%Y-%m-%dT%H:%M:%SZ"),
    }
    persisted = append_declared_jsonl(_reviews_path(tools_root), row, expected_surface="review_records")
    append_tools_governance(
        tools_root,
        "review_recorded",
        {
            "review_id": review_id,
            "scope": scope,
            "reviewer": reviewer,
            "findings_count": len(fr),
            "debts_count": len(dr),
        },
    )
    return persisted


def list_reviews(
    *,
    base_dir: str | Path | None = None,
    scope_substring: str | None = None,
    reviewer: str | None = None,
) -> list[dict[str, Any]]:
    """List review records, sorted by recorded_at ascending."""
    tools_root = ensure_tools_dir(base_dir)
    path = _reviews_path(tools_root)
    if not path.exists():
        return []
    rows = load_jsonl(path)
    if scope_substring is not None:
        rows = [r for r in rows if scope_substring.lower() in str(r.get("scope", "")).lower()]
    if reviewer is not None:
        rows = [r for r in rows if r.get("reviewer") == reviewer]
    rows.sort(key=lambda r: r.get("recorded_at", ""))
    return rows
