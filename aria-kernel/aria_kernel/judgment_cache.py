"""WP-J slice C — the verdict cache: same claim, same cited code, one payment.

WHY. A re-run of an adapter mints a FRESH finding id for the same finding
(``finding_fingerprint`` matches; the ``(run_id, finding_id)`` pair the
sampler's settled-test reads is new), so the identical claim over identical
code was judged — and paid — from zero, every night, forever. The operator's
funnel law: cache by code hash.

WHAT. One ledger, ``judgment-funnel/verdict-cache.jsonl``, keyed
``(finding_fingerprint, code_hash)`` where the code half is
``evidence_trust.cited_blobs_code_hash`` — the sha256 of the cited blobs at
the verdict's ``target_sha`` (the same ``git show`` blob law the trust layer
grades quotes with). A HIT means the prior verdict was pinned to byte-
identical cited code: the funnel mints nothing for the item and records
``cache_hit`` on its routing row. A blob change — or a moved anchor whose
cited bytes differ — changes the hash and the verdict is stale: miss, mint.

TRI-STATE LAW: the blob hash is ``None`` when git could not answer (no
anchor, no repo, a stalled probe). Unknown is a MISS — the cache fails
toward minting, never toward a silent verdict (G-2's spirit at the cache
boundary). The WRITE side refuses nothing: a settled consensus whose cited
refs cannot be hashed today is simply not cached.

The verdict a hit carries is the FEEDBACK row's verdict — the cache stores
only the join (fingerprint, code_hash) → (judgment_group_id, verdict); the
ground-truth ledger stays the one owner of what was decided.
"""
from __future__ import annotations

from pathlib import Path
from typing import Any

from .tool_registry import ensure_tools_dir

CACHE_SURFACE: str = "judgment_funnel_cache"
CACHE_RELPATH: tuple[str, ...] = ("judgment-funnel", "verdict-cache.jsonl")


def cache_path(base_dir: str | Path) -> Path:
    return ensure_tools_dir(base_dir).joinpath(*CACHE_RELPATH)


def _rows(root: Path) -> list[dict[str, Any]]:
    from .ledger import load_declared_jsonl

    path = cache_path(root)
    if not path.exists():
        return []
    return load_declared_jsonl(path, expected_surface=CACHE_SURFACE)


def cache_lookup(
    root: Path, *, finding_fingerprint: str, code_hash: str | None,
) -> dict[str, Any] | None:
    """The newest cache row for this (fingerprint, code_hash), or None.

    ``code_hash=None`` (unknown blob state) is a miss by law, never a hit.
    """
    if not finding_fingerprint or code_hash is None:
        return None
    newest: dict[str, Any] | None = None
    for row in _rows(root):
        if (row.get("finding_fingerprint") == finding_fingerprint
                and row.get("code_hash") == code_hash):
            if newest is None or str(row.get("recorded_at") or "") >= str(newest.get("recorded_at") or ""):
                newest = row
    return newest


def record_settled_verdicts(
    root: Path,
    *,
    routing_rows: list[dict[str, Any]],
    feedback: list[dict[str, Any]],
    repo_root: str | Path | None,
) -> int:
    """Learn the settled verdicts: route rows whose group settled get a
    cache entry keyed by the FINDING's cited blobs at the route's anchor.

    Idempotent by key: an entry for ``(fingerprint, code_hash)`` is written
    once. Returns how many entries were added.
    """
    from .evidence_trust import cited_blobs_code_hash
    from .ledger import append_declared_jsonl

    settled: dict[str, dict[str, Any]] = {}
    for row in feedback:
        if row.get("source_type") != "ai_consensus":
            continue
        group = str(row.get("judgment_group_id") or "")
        if group:
            settled[group] = row
    if not settled or repo_root is None:
        return 0
    known = {(row.get("finding_fingerprint"), row.get("code_hash")) for row in _rows(root)}
    added = 0
    for route in routing_rows:
        group = str(route.get("judgment_group_id") or "")
        fingerprint = str(route.get("finding_fingerprint") or "")
        refs = route.get("cited_refs") or []
        target_sha = route.get("target_sha")
        if group not in settled or not fingerprint or not refs:
            continue
        code_hash = cited_blobs_code_hash(Path(repo_root), list(refs), target_sha)
        if code_hash is None or (fingerprint, code_hash) in known:
            continue
        append_declared_jsonl(
            cache_path(root),
            {
                "schema_version": 1,
                "row_type": "verdict_cache",
                "recorded_at": _now_iso(),
                "finding_fingerprint": fingerprint,
                "code_hash": code_hash,
                "verdict": str(settled[group].get("verdict") or ""),
                "judgment_group_id": group,
                "target_sha": target_sha,
            },
            expected_surface=CACHE_SURFACE,
        )
        known.add((fingerprint, code_hash))
        added += 1
    return added


def _now_iso() -> str:
    from datetime import datetime, timezone

    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


__all__ = [
    "CACHE_RELPATH",
    "CACHE_SURFACE",
    "cache_lookup",
    "cache_path",
    "record_settled_verdicts",
]
