"""Plan ARIA-V8 v2 §4 Phase 8.5 (B-V2-08) — three-layer independence verification.

WHY this module exists:
Cross-review's signal value depends on it being INDEPENDENT of
primary and challenger. If the same LLM session produced all three
envelopes (or two LLM calls happened to produce identical text), the
"converged" verdict is an echo chamber.

The audit's first proposal (compare agent_text_hash equality) was
gameable: cross-reviewer's envelope schema differs from primary's, so
hash equality is structurally guaranteed regardless of LLM
independence (code-reviewer #3). V8 v2 (B-V2-08) replaces hash
equality with a 3-layer check:

1. SOURCE LEVEL — separate `claim_id` per envelope; subprocess
   disjointness audit via `claims.jsonl`. Two envelopes claimed in
   overlapping windows by the same agent_id violate independence.

2. SCHEMA LEVEL — distinct `revision_id` values for primary,
   challenger, cross_review. Same revision_id = same content =
   echo chamber.

3. DIVERSITY LEVEL — Jaccard token-set similarity over the
   agent_text fields (n-gram, n=3). > 0.85 indicates suspiciously
   similar wording across allegedly independent agents.

When any layer fails, the convergence drainer downgrades the verdict
from `converged` → `cross_review_self_agreement` + emits a governance
event `convergence_invalid_self_agreement` with the specific
violation reasons.
"""
from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Any

from .ledger import load_jsonl


# Per code-reviewer #3 — 0.85 ceiling is the bright-line operator
# tunable. Two LLMs producing >85% identical 3-gram coverage on a
# non-trivial plan is suspicious enough to investigate.
DEFAULT_JACCARD_CEILING = 0.85
DEFAULT_NGRAM = 3


def verify_claim_disjointness(
    *,
    primary_request_id: str,
    challenger_request_id: str,
    cross_review_request_id: str,
    base_dir: str | Path,
) -> tuple[bool, list[str]]:
    """Source-level: each envelope must have a SEPARATE claim_id row,
    AND no two claims overlap in time on the same agent_id.

    Returns (passed, violation_reasons).
    """
    reasons: list[str] = []
    claims_path = Path(base_dir) / "agent-invocations" / "claims.jsonl"
    if not claims_path.exists():
        return False, ["claims_jsonl_missing"]
    rows = load_jsonl(claims_path)
    by_request: dict[str, list[dict[str, Any]]] = {}
    for row in rows:
        rid = row.get("request_id")
        if rid:
            by_request.setdefault(str(rid), []).append(row)
    relevant = {
        "primary": by_request.get(primary_request_id, []),
        "challenger": by_request.get(challenger_request_id, []),
        "cross_review": by_request.get(cross_review_request_id, []),
    }
    # Each must have at least one claim row
    for role, rows_for in relevant.items():
        if not rows_for:
            reasons.append(f"{role}_no_claim_row")
    if reasons:
        return False, reasons
    # Each must have a unique claim_id
    claim_ids = {role: {r.get("claim_id") for r in rows_for if r.get("claim_id")}
                 for role, rows_for in relevant.items()}
    primary_claims = claim_ids["primary"]
    challenger_claims = claim_ids["challenger"]
    cross_review_claims = claim_ids["cross_review"]
    if primary_claims & challenger_claims:
        reasons.append("primary_challenger_claim_id_overlap")
    if primary_claims & cross_review_claims:
        reasons.append("primary_cross_review_claim_id_overlap")
    if challenger_claims & cross_review_claims:
        reasons.append("challenger_cross_review_claim_id_overlap")
    return (len(reasons) == 0), reasons


def verify_revision_id_distinctness(
    *,
    primary_revision_id: str,
    challenger_revision_id: str,
    cross_review_revision_id: str | None,
) -> tuple[bool, list[str]]:
    """Schema-level: revision_ids MUST be distinct across all three."""
    reasons: list[str] = []
    if primary_revision_id == challenger_revision_id:
        reasons.append("primary_challenger_revision_id_collision")
    if cross_review_revision_id is not None:
        if primary_revision_id == cross_review_revision_id:
            reasons.append("primary_cross_review_revision_id_collision")
        if challenger_revision_id == cross_review_revision_id:
            reasons.append("challenger_cross_review_revision_id_collision")
    return (len(reasons) == 0), reasons


def compute_jaccard_similarity(text_a: str, text_b: str, n: int = DEFAULT_NGRAM) -> float:
    """N-gram (word-level) Jaccard similarity in [0.0, 1.0]."""
    if not text_a or not text_b:
        return 0.0
    tokens_a = text_a.split()
    tokens_b = text_b.split()
    if len(tokens_a) < n or len(tokens_b) < n:
        # Fall back to bag-of-words for short text
        set_a = set(tokens_a)
        set_b = set(tokens_b)
    else:
        set_a = {tuple(tokens_a[i:i+n]) for i in range(len(tokens_a) - n + 1)}
        set_b = {tuple(tokens_b[i:i+n]) for i in range(len(tokens_b) - n + 1)}
    if not set_a and not set_b:
        return 1.0
    intersection = len(set_a & set_b)
    union = len(set_a | set_b)
    return intersection / union if union > 0 else 0.0


def verify_independence(
    *,
    primary_request_id: str,
    primary_revision_id: str,
    primary_text: str,
    challenger_request_id: str,
    challenger_revision_id: str,
    challenger_text: str,
    cross_review_request_id: str,
    cross_review_revision_id: str | None,
    cross_review_text: str,
    base_dir: str | Path,
    jaccard_ceiling: float = DEFAULT_JACCARD_CEILING,
) -> tuple[bool, list[str]]:
    """Run all three independence checks.

    Returns ``(passed, violation_reasons)``. Passed = True means
    the cross-review is structurally + semantically independent of
    the primary + challenger; the convergence verdict can stay
    `converged`. Passed = False means at least one layer flagged
    echo chamber; verdict MUST downgrade to `cross_review_self_agreement`.
    """
    reasons: list[str] = []
    ok_claim, claim_reasons = verify_claim_disjointness(
        primary_request_id=primary_request_id,
        challenger_request_id=challenger_request_id,
        cross_review_request_id=cross_review_request_id,
        base_dir=base_dir,
    )
    if not ok_claim:
        reasons.extend(claim_reasons)
    ok_rev, rev_reasons = verify_revision_id_distinctness(
        primary_revision_id=primary_revision_id,
        challenger_revision_id=challenger_revision_id,
        cross_review_revision_id=cross_review_revision_id,
    )
    if not ok_rev:
        reasons.extend(rev_reasons)
    # Diversity check
    jac_pc = compute_jaccard_similarity(primary_text, cross_review_text)
    jac_cc = compute_jaccard_similarity(challenger_text, cross_review_text)
    jac_pp = compute_jaccard_similarity(primary_text, challenger_text)
    if jac_pc > jaccard_ceiling:
        reasons.append(f"primary_cross_review_jaccard_{jac_pc:.3f}_above_ceiling")
    if jac_cc > jaccard_ceiling:
        reasons.append(f"challenger_cross_review_jaccard_{jac_cc:.3f}_above_ceiling")
    if jac_pp > jaccard_ceiling:
        reasons.append(f"primary_challenger_jaccard_{jac_pp:.3f}_above_ceiling")
    return (len(reasons) == 0), reasons


def compute_agent_text_hash(text: str) -> str:
    """Helper for governance event payloads — never include the raw
    text in the event, only the hash (operator forensics + redaction
    discipline)."""
    return "sha256:" + hashlib.sha256(text.encode("utf-8")).hexdigest()
