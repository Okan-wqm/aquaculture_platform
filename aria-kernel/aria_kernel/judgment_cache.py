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
only the join (key) → (judgment_group_id, verdict); the ground-truth ledger
stays the one owner of what was decided.

J2 (SEPT-HARVEST §2) — WHO judged and under which law is part of the key.
Besides the cited code, an entry is keyed by ``judges_hash`` (every judge
seat's agent file at the verdict's ``target_sha``: the same blob law over
``agent_resolver``'s candidate paths), ``rule_contract_hash`` (the rule's
claim as routed, stamped on the routing row) and ``calibration_gate`` (the
gate the consensus closed under). An edited judge prompt, a rewritten rule
contract or a gate switched to ``enforce`` is a miss: no cached verdict
outlives the judge, claim or law that produced it. Each half is tri-state
like the code half — unknown is a miss.
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


CACHE_KEY_FIELDS: tuple[str, ...] = (
    "finding_fingerprint", "code_hash", "judges_hash", "rule_contract_hash", "calibration_gate",
)


def _key_of(row: dict[str, Any]) -> tuple[Any, ...]:
    return tuple(row.get(name) for name in CACHE_KEY_FIELDS)


def judge_seats_code_hash(repo_root: str | Path, target_sha: str | None) -> str | None:
    """J2 — the identity of every judge seat's contract file at ``target_sha``.

    The seats are the agents ``agent_surface`` pairs with the judge roles;
    each contributes every path ``agent_resolver`` would look it up at, hashed
    by ``evidence_trust.cited_blobs_code_hash`` (an absent candidate is a
    marker, so a moved or new file is a change). ``None`` when git cannot
    answer: unknown, a miss.
    """
    from .agent_resolver import agent_md_candidates
    from .agent_surface import JUDGE_ROLES, ROLE_TARGET_PAIRING
    from .evidence_trust import cited_blobs_code_hash

    agents = sorted({agent for role in JUDGE_ROLES for agent in ROLE_TARGET_PAIRING[role]})
    refs = [path for agent in agents for path in agent_md_candidates(agent)]
    return cited_blobs_code_hash(Path(repo_root), refs, target_sha)


def _consensus_gate(row: dict[str, Any]) -> str:
    """The calibration gate a consensus row closed under. A row without a
    ``calibration_basis`` was folded with no calibration map, which
    ``generate_ai_consensus`` runs as ``measure_only`` by construction."""
    basis = row.get("calibration_basis")
    return str(basis["gate"]) if isinstance(basis, dict) else "measure_only"


def cache_lookup(
    root: Path,
    *,
    finding_fingerprint: str,
    code_hash: str | None,
    judges_hash: str | None,
    rule_contract_hash: str | None,
    calibration_gate: str,
) -> dict[str, Any] | None:
    """The newest cache row for this key, or None.

    Any unknown half (``None``) is a miss by law, never a hit.
    """
    key = (finding_fingerprint, code_hash, judges_hash, rule_contract_hash, calibration_gate)
    if any(part is None or part == "" for part in key):
        return None
    newest: dict[str, Any] | None = None
    for row in _rows(root):
        if _key_of(row) == key:
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
    cache entry keyed by the FINDING's cited blobs and the judge seats'
    contracts at the route's anchor, the rule contract the route stamped and
    the gate the consensus closed under.

    Idempotent by key: an entry is written once per key. A route whose key
    has an unknown half is not cached. Returns how many entries were added.
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
    known = {_key_of(row) for row in _rows(root)}
    judges_by_sha: dict[str, str | None] = {}
    added = 0
    for route in routing_rows:
        group = str(route.get("judgment_group_id") or "")
        fingerprint = str(route.get("finding_fingerprint") or "")
        refs = route.get("cited_refs") or []
        target_sha = route.get("target_sha")
        rule_contract_hash = route.get("rule_contract_hash")
        if group not in settled or not fingerprint or not refs or not rule_contract_hash:
            continue
        code_hash = cited_blobs_code_hash(Path(repo_root), list(refs), target_sha)
        if code_hash is None:
            continue
        sha_key = str(target_sha or "")
        if sha_key not in judges_by_sha:
            judges_by_sha[sha_key] = judge_seats_code_hash(repo_root, target_sha)
        judges_hash = judges_by_sha[sha_key]
        if judges_hash is None:
            continue
        entry = {
            "finding_fingerprint": fingerprint,
            "code_hash": code_hash,
            "judges_hash": judges_hash,
            "rule_contract_hash": str(rule_contract_hash),
            "calibration_gate": _consensus_gate(settled[group]),
        }
        if _key_of(entry) in known:
            continue
        append_declared_jsonl(
            cache_path(root),
            {
                "schema_version": 2,
                "row_type": "verdict_cache",
                "recorded_at": _now_iso(),
                **entry,
                "verdict": str(settled[group].get("verdict") or ""),
                "judgment_group_id": group,
                "target_sha": target_sha,
            },
            expected_surface=CACHE_SURFACE,
        )
        known.add(_key_of(entry))
        added += 1
    return added


def _now_iso() -> str:
    from datetime import datetime, timezone

    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


__all__ = [
    "CACHE_KEY_FIELDS",
    "CACHE_RELPATH",
    "CACHE_SURFACE",
    "cache_lookup",
    "cache_path",
    "judge_seats_code_hash",
    "record_settled_verdicts",
]
