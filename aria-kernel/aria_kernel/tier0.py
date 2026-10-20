"""WP-J slice A — tier-0: the mechanical, zero-LLM gate before any paid seat.

THE SEAM (slice C calls, slice A owns). ``rule_contract`` already names
this module as the minter of ``CLAIM_NOT_FALSIFIABLE`` (MEASURE mode first:
a governance row per refusal, never yet an enforcement). Slice C's judgment
funnel calls ``tier0_gate`` for every sampled finding BEFORE any mint and
early-stops on a reject; the full law (verbatim quotes through
``evidence_trust.quote_matches_at``, fingerprint dedup, static premise
checks, per-family observables for the lint-rules ``*`` and doc-staleness
families, excerpt-skip named-stale rejection) lands with slice A. This
module is the callable seam with the one check the operator's protocol
names first — every cited ref resolves at the target SHA — so the funnel's
early stop is real from day one; slice A extends it in place, the funnel's
consumption does not change.

TRI-STATE LAW (the ``evidence_trust._git_blob_matches`` rule): a probe that
could not run is NOT a verdict. No anchor, no repository, or a git that
does not answer means the item PASSES with a note — unknown is never green,
but it is also never a refusal; the paid tiers still verify.
"""
from __future__ import annotations

from pathlib import Path
from typing import Any

TIER0_PASS = "pass"
TIER0_REJECT = "reject"

# Named refusals. Every reject carries one of these, verbatim, onto the
# governance row and the routing row — an unnamed rejection is
# indistinguishable from a dropped one.
REJECT_CITED_PATH_ABSENT = "cited_path_absent_at_target_sha"
REJECT_EVIDENCE_REF_ABSENT = "evidence_ref_absent_at_target_sha"

# The note a pass carries when nothing could be checked (tri-state law).
NOTE_NO_ANCHOR = "tier0_unverified_no_anchor"
NOTE_GIT_UNAVAILABLE = "tier0_unverified_git_unavailable"


def tier0_gate(
    item: dict[str, Any],
    contract: Any,
    repo_root: str | Path | None,
    target_sha: str | None,
    *,
    probe: Any = None,
) -> dict[str, Any]:
    """Pure mechanical verdict for one sampled finding. Zero LLM calls.

    Returns ``{"status": "pass"|"reject", "reason": str|None, "note": str|None}``.
    A reject means the claim's own citations do not resolve at the tree the
    judges would be anchored to — the funnel refuses to pay for judging a
    finding about a tree that does not carry its evidence.
    """
    if not isinstance(repo_root, (str, Path)) or not str(repo_root).strip():
        return {"status": TIER0_PASS, "reason": None, "note": NOTE_NO_ANCHOR}
    if not isinstance(target_sha, str) or not target_sha.strip():
        return {"status": TIER0_PASS, "reason": None, "note": NOTE_NO_ANCHOR}

    from .evidence_probe import GitProbeSession
    from .evidence_trust import parse_evidence_ref

    session = probe if probe is not None else GitProbeSession()
    refs: list[tuple[str, str]] = []
    path = str(item.get("path") or "").strip()
    if path:
        refs.append(("path", path))
    for entry in item.get("evidence") or []:
        if isinstance(entry, str) and entry.strip():
            refs.append(("evidence", entry.strip()))

    for kind, ref in refs:
        parsed = parse_evidence_ref(ref)
        rel = parsed[0] if parsed is not None else ref
        outcome = session.run(["git", "show", f"{target_sha}:{rel}"], cwd=Path(repo_root))
        if not outcome.answered:
            # One silent git is no verdict for the whole batch (tri-state).
            return {"status": TIER0_PASS, "reason": None, "note": NOTE_GIT_UNAVAILABLE}
        if outcome.returncode != 0:
            return {
                "status": TIER0_REJECT,
                "reason": (REJECT_CITED_PATH_ABSENT if kind == "path"
                           else REJECT_EVIDENCE_REF_ABSENT),
                "note": f"{rel}@{target_sha[:12]}",
            }
    return {"status": TIER0_PASS, "reason": None, "note": None}


__all__ = [
    "NOTE_GIT_UNAVAILABLE",
    "NOTE_NO_ANCHOR",
    "REJECT_CITED_PATH_ABSENT",
    "REJECT_EVIDENCE_REF_ABSENT",
    "TIER0_PASS",
    "TIER0_REJECT",
    "tier0_gate",
]
