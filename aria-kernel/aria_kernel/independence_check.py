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

ORPHAN-HIGH-336 — all three layers were non-functional in production:

  * Layer 1 was fed ``request_ids[0..2]`` positionally, but the drainer
    appended challenger → cross_review → completeness_critic → primary,
    so from round 1 the wrong three roles were compared. It also only
    compared ``claim_id`` sets, despite the docstring promising an
    ``agent_id`` check — and every claim gets a fresh claim_id, so one
    agent could hold all three roles and pass.
  * Layer 2 received ids the caller synthesized (``<plan>-r1`` /
    ``<plan>-c1`` / ``None``), which are always distinct.
  * Layer 3 received three hardcoded placeholder strings whose maximum
    pairwise Jaccard measured 0.25 against a 0.85 ceiling.

The fix is the input type. :class:`RoundDispatch` refuses to be
constructed without a real request id, carries the role explicitly so
positional confusion is unrepresentable, and distinguishes "text
unavailable" (a violation) from "text present and dissimilar" (a pass) —
because ``compute_jaccard_similarity`` scores an absent text as 0.0,
i.e. maximally diverse.
"""
from __future__ import annotations

import hashlib
import json
from collections.abc import Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .ledger import load_jsonl


# Per code-reviewer #3 — 0.85 ceiling is the bright-line operator
# tunable. Two LLMs producing >85% identical 3-gram coverage on a
# non-trivial plan is suspicious enough to investigate.
DEFAULT_JACCARD_CEILING = 0.85
DEFAULT_NGRAM = 3

PRIMARY_ROLE = "primary_plan"
CHALLENGER_ROLE = "challenger_plan"
CROSS_REVIEW_ROLE = "cross_review"


class IndependenceInputError(ValueError):
    """Raised when a dispatch record cannot support an independence claim.

    ORPHAN-HIGH-336 — this exists so a caller CANNOT hand the checker a
    placeholder. The drainer used to pass literal strings such as
    ``"(challenger plan text)"`` and synthesized ids such as
    ``f"{plan_id}-c1"``, which made two of the three layers mathematically
    incapable of firing. Refusing the construction is what turns that from
    a silent pass into a visible failure.
    """


@dataclass(frozen=True)
class RoundDispatch:
    """One role's actual dispatch in one convergence round.

    Replaces the positional ``request_ids[0..2]`` lookup the drainer used,
    which mis-mapped roles from round 1 onward because the append order
    (challenger, cross_review, completeness_critic, primary) did not match
    the read order (primary, challenger, cross_review).

    ``agent_text`` is ``None`` when the role's output could not be
    retrieved. That is deliberately distinct from an empty string: an
    unavailable text must fail the diversity comparison rather than score
    as maximally diverse.
    """

    role: str
    request_id: str | None
    revision_id: str | None
    agent_text: str | None

    def __post_init__(self) -> None:
        if not self.role or not self.role.strip():
            raise IndependenceInputError("round_dispatch_role_required")
        if self.request_id is not None and not self.request_id.strip():
            raise IndependenceInputError(
                f"round_dispatch_request_id_blank:{self.role}"
            )
        if self.revision_id is not None and not self.revision_id.strip():
            raise IndependenceInputError(
                f"round_dispatch_revision_id_blank:{self.role}"
            )

    @property
    def has_text(self) -> bool:
        return bool(self.agent_text and self.agent_text.strip())

    @property
    def was_dispatched(self) -> bool:
        """True when an agent claimed this role through the queue.

        ``request_id is None`` is legitimate for a kernel-seeded primary
        plan on round 1: nothing was dispatched, so there is no claim to
        check. It is NOT legitimate for a challenger or a reviewer, and
        :func:`verify_principal_disjointness` enforces a floor on how many
        roles must be genuinely dispatched.
        """
        return bool(self.request_id and self.request_id.strip())


def verify_principal_disjointness(
    *,
    dispatches: "Sequence[RoundDispatch]",
    base_dir: str | Path,
    min_dispatched: int = 2,
) -> tuple[bool, list[str]]:
    """N-party source-level independence over dispatched roles.

    ORPHAN-HIGH-336 — generalises the old three-argument claim check. The
    property is pairwise: no two roles may share a ``claim_id`` (the
    receipt) or an ``agent_id`` (the principal). The principal check is
    the one that matters and the one that was missing — every claim gets a
    fresh claim_id, so a single agent could hold every role and pass.

    Roles with no ``request_id`` are skipped because nothing was
    dispatched for them; ``min_dispatched`` is the floor that stops that
    skip from emptying the check.
    """
    reasons: list[str] = []
    dispatched = [d for d in dispatches if d.was_dispatched]
    if len(dispatched) < min_dispatched:
        reasons.append(
            f"insufficient_dispatched_roles:{len(dispatched)}<{min_dispatched}"
        )
        return False, reasons
    claims_path = Path(base_dir) / "agent-invocations" / "claims.jsonl"
    if not claims_path.exists():
        return False, ["claims_jsonl_missing"]
    rows = load_jsonl(claims_path)
    by_request: dict[str, list[dict[str, Any]]] = {}
    for row in rows:
        rid = row.get("request_id")
        if rid:
            by_request.setdefault(str(rid), []).append(row)
    claim_ids: dict[str, set[str]] = {}
    agent_ids: dict[str, set[str]] = {}
    for dispatch in dispatched:
        rows_for = by_request.get(str(dispatch.request_id), [])
        if not rows_for:
            reasons.append(f"{dispatch.role}_no_claim_row")
            continue
        claim_ids[dispatch.role] = {
            str(r.get("claim_id")) for r in rows_for if r.get("claim_id")
        }
        found_agents = {str(r.get("agent_id")) for r in rows_for if r.get("agent_id")}
        if not found_agents:
            reasons.append(f"{dispatch.role}_claim_missing_agent_id")
        agent_ids[dispatch.role] = found_agents
    if reasons:
        return False, reasons
    # Pair in the caller's order, not alphabetically: the reason strings
    # are read by operators and asserted by invariants, so
    # "primary_challenger_..." must not silently become
    # "challenger_primary_...".
    roles = [d.role for d in dispatched if d.role in claim_ids]
    for i, left in enumerate(roles):
        for right in roles[i + 1:]:
            if claim_ids[left] & claim_ids[right]:
                reasons.append(f"{left}_{right}_claim_id_overlap")
            shared_agents = agent_ids[left] & agent_ids[right]
            if shared_agents:
                reasons.append(
                    f"{left}_{right}_same_agent_id:{','.join(sorted(shared_agents))}"
                )
    return (len(reasons) == 0), reasons


def verify_claim_disjointness(
    *,
    primary_request_id: str,
    challenger_request_id: str,
    cross_review_request_id: str,
    base_dir: str | Path,
) -> tuple[bool, list[str]]:
    """Source-level: distinct claims AND distinct executing principals.

    ORPHAN-HIGH-336 — the docstring here always promised that "no two
    claims overlap in time on the same agent_id", but the implementation
    only compared ``claim_id`` sets. Every claim gets a fresh claim_id, so
    a SINGLE agent could claim all three envelopes and pass: the identity
    that actually matters for independence is the principal, not the
    receipt. That is the echo chamber this module exists to detect.

    Three properties are now checked:
      1. every role has at least one claim row (no claim = no work),
      2. no two roles share a ``claim_id``,
      3. no two roles share an ``agent_id`` — the principal-level check.

    Returns (passed, violation_reasons).
    """
    return verify_principal_disjointness(
        dispatches=[
            RoundDispatch(
                role="primary", request_id=primary_request_id,
                revision_id=None, agent_text=None,
            ),
            RoundDispatch(
                role="challenger", request_id=challenger_request_id,
                revision_id=None, agent_text=None,
            ),
            RoundDispatch(
                role="cross_review", request_id=cross_review_request_id,
                revision_id=None, agent_text=None,
            ),
        ],
        base_dir=base_dir,
        min_dispatched=3,
    )


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


def _diversity_reasons(
    left: RoundDispatch,
    right: RoundDispatch,
    jaccard_ceiling: float,
) -> list[str]:
    """Diversity comparison for one pair, fail-closed on missing text.

    ORPHAN-HIGH-336 — ``compute_jaccard_similarity`` returns 0.0 when
    either side is empty, so an absent output used to score as maximally
    diverse and pass. Text we cannot read is text we cannot compare: it is
    reported as unavailable rather than treated as evidence of diversity.
    """
    if not left.has_text:
        return [f"{left.role}_text_unavailable"]
    if not right.has_text:
        return [f"{right.role}_text_unavailable"]
    score = compute_jaccard_similarity(str(left.agent_text), str(right.agent_text))
    if score > jaccard_ceiling:
        return [f"{left.role}_{right.role}_jaccard_{score:.3f}_above_ceiling"]
    return []


def verify_independence(
    *,
    primary: RoundDispatch,
    challenger: RoundDispatch,
    cross_review: RoundDispatch,
    base_dir: str | Path,
    jaccard_ceiling: float = DEFAULT_JACCARD_CEILING,
) -> tuple[bool, list[str]]:
    """Run all three independence checks over one round's real dispatches.

    Returns ``(passed, violation_reasons)``. Passed = True means the
    cross-review is structurally + semantically independent of the primary
    + challenger; the convergence verdict can stay ``converged``. Passed =
    False means at least one layer flagged echo chamber; the verdict MUST
    downgrade to ``cross_review_self_agreement``.

    ORPHAN-HIGH-336 — takes typed :class:`RoundDispatch` records instead
    of nine loose strings. The old signature let the drainer pass
    placeholder text and synthesized revision ids, which made the
    revision and diversity layers unable to fire at all: measured
    empirically, the placeholder texts scored a maximum pairwise Jaccard
    of 0.25 against a 0.85 ceiling, and the synthesized ids were always
    distinct. "Three-layer verification" was one layer, fed the wrong
    request ids.
    """
    reasons: list[str] = []
    roles = {primary.role, challenger.role, cross_review.role}
    if len(roles) != 3:
        reasons.append(f"dispatch_roles_not_distinct:{','.join(sorted(roles))}")
    dispatched_ids = [
        d.request_id for d in (primary, challenger, cross_review) if d.was_dispatched
    ]
    if len(set(dispatched_ids)) != len(dispatched_ids):
        reasons.append("dispatch_request_ids_not_distinct")
    # A kernel-seeded primary has no request to claim (round 1), so the
    # floor is two dispatched roles: the challenger and the reviewer must
    # at minimum be distinct principals from each other.
    ok_claim, claim_reasons = verify_principal_disjointness(
        dispatches=(primary, challenger, cross_review),
        base_dir=base_dir,
        min_dispatched=2,
    )
    if not ok_claim:
        reasons.extend(claim_reasons)
    ok_rev, rev_reasons = verify_revision_id_distinctness(
        primary_revision_id=str(primary.revision_id or ""),
        challenger_revision_id=str(challenger.revision_id or ""),
        cross_review_revision_id=cross_review.revision_id,
    )
    if not ok_rev:
        reasons.extend(rev_reasons)
    for left, right in (
        (primary, cross_review),
        (challenger, cross_review),
        (primary, challenger),
    ):
        reasons.extend(_diversity_reasons(left, right, jaccard_ceiling))
    # Deduplicate while preserving order — an unavailable text yields the
    # same reason from two pairings.
    ordered: list[str] = []
    for reason in reasons:
        if reason not in ordered:
            ordered.append(reason)
    return (len(ordered) == 0), ordered


def compute_agent_text_hash(text: str) -> str:
    """Helper for governance event payloads — never include the raw
    text in the event, only the hash (operator forensics + redaction
    discipline)."""
    return "sha256:" + hashlib.sha256(text.encode("utf-8")).hexdigest()
