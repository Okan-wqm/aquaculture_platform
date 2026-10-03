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

ORPHAN-HIGH-421 — all three layers were non-functional in production:

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
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .ledger import (
    LedgerIntegrityError,
    LedgerReadLimitError,
    load_declared_jsonl,
    load_jsonl,
    load_segments,
    segment_paths,
)
from .model_fleet import dispatching_provider_for_model
from .tool_registry import GovernanceError


# Per code-reviewer #3 — 0.85 ceiling is the bright-line operator
# tunable. Two LLMs producing >85% identical 3-gram coverage on a
# non-trivial plan is suspicious enough to investigate.
DEFAULT_JACCARD_CEILING = 0.85
DEFAULT_NGRAM = 3

PRIMARY_ROLE = "primary_plan"
CHALLENGER_ROLE = "challenger_plan"
CROSS_REVIEW_ROLE = "cross_review"


# ARIA-HIGH-193 — the identity the executor claims and submits under
# (`ci-executor:gha-<GITHUB_RUN_ID>`). It names the PROCESS that carried a
# seat, not the agent that answered it: every seat drained by one run shares
# it, so reading it as the principal made 35/35 live panels "not independent".
EXECUTOR_IDENTITY_PREFIX = "ci-executor:"


def is_executor_identity(value: object) -> bool:
    """True for an executor-shaped identity, which is never a principal."""
    return str(value or "").startswith(EXECUTOR_IDENTITY_PREFIX)


def seat_principal(request_row: dict[str, Any]) -> str | None:
    """The principal behind one dispatched seat: the agent the kernel minted
    the request FOR (``target_agent``), or ``None`` when the row cannot name
    one. The executor invokes exactly that subagent and force-stamps it as
    ``details.agent_subagent_type``; the claimant is only the carrier."""
    target = str(request_row.get("target_agent") or "").strip()
    if not target or is_executor_identity(target):
        return None
    return target


def response_principal(response: dict[str, Any]) -> str | None:
    """The principal behind one sealed response: the executor-stamped
    ``details.agent_subagent_type`` (never the agent's own spelling, never
    the envelope's executor-shaped ``agent_id``); ``None`` when absent."""
    details = response.get("details")
    stamped = str((details or {}).get("agent_subagent_type") or "").strip() if isinstance(details, dict) else ""
    if not stamped or is_executor_identity(stamped):
        return None
    return stamped


# The governance kind `budget._reserve_native_runtime_attempt` writes before a
# native dispatch: the provider, runtime and model a seat was sent to, bound
# to its request and claim.
RUNTIME_ATTEMPT_STARTED_KIND = "runtime_attempt_started"


@dataclass(frozen=True)
class Principal:
    """ARIA-MEDIUM-225 — who answered a seat: the agent AND the route.

    ``agent`` is the agent the kernel minted the seat for (``seat_principal``)
    and the executor stamped on the sealed response (``response_principal``);
    the two must agree. ``provider`` / ``model`` are the route that EXECUTED
    it. Reading the agent name alone made one executor run on one model three
    principals: three prompts, one mind.

    Two questions, answered separately, neither weaker than before:

    * two seats CONFLICT when they share the agent — one persona is one
      principal whichever model answered it
      (:func:`verify_principal_disjointness`, every panel);
    * two seats SHARE A MIND when they share the route — the question a
      decision that clears something must also answer
      (:func:`verify_route_distinctness`). It is not a disjointness rule for
      every panel: the convergence roles (planner, planner, judge_opus) all
      run opus, so a route rule there would refuse every convergence rather
      than measure one.
    """

    agent: str
    provider: str
    model: str

    @property
    def route(self) -> tuple[str, str]:
        return (self.provider, self.model)

    def __str__(self) -> str:
        return f"{self.agent}@{self.provider}/{self.model}"


def executed_route(
    response: Mapping[str, Any],
    *,
    attempt_rows: Sequence[Mapping[str, Any]],
) -> tuple[str, str] | None:
    """The ``(provider, model)`` that executed one sealed response, or ``None``.

    Two dispatch paths, each with ONE authority, both written by the
    executor and never by the agent:

    * native runtime — the envelope carries ``runtime_attempt_ledger_hash``,
      and the route is the ``runtime_attempt_started`` row with that hash,
      bound to this response's request and claim. A hash the ledger does not
      hold exactly once, a row bound to another seat, or an
      ``agent_dispatch_model`` stamp that contradicts the row's model is no
      route: the two records disagree about what ran.
    * the spawn path — no attempt row exists; the route is the
      force-stamped ``details.agent_dispatch_model`` (ORPHAN-HIGH-781,
      ARIA-MEDIUM-171) under the provider the fleet dispatches that model
      through.

    ``None`` is a refusal, never a default: a seat whose route cannot be
    named cannot count toward a claim that the routes were independent.
    """
    details = response.get("details")
    if not isinstance(details, dict):
        return None
    stamped = str(details.get("agent_dispatch_model") or "").strip()
    ledger_hash = details.get("runtime_attempt_ledger_hash")
    if ledger_hash:
        matches = [
            row for row in attempt_rows
            if row.get("kind") == RUNTIME_ATTEMPT_STARTED_KIND
            and row.get("ledger_hash") == ledger_hash
        ]
        if len(matches) != 1:
            return None
        attempt = matches[0].get("details")
        if not isinstance(attempt, dict):
            return None
        if (
            attempt.get("request_id") != response.get("request_id")
            or attempt.get("claim_id") != response.get("claim_id")
        ):
            return None
        provider = str(attempt.get("provider") or "").strip()
        model = str(attempt.get("model") or "").strip()
        if not provider or not model or (stamped and stamped != model):
            return None
        return (provider, model)
    if not stamped:
        return None
    return (dispatching_provider_for_model(stamped), stamped)


class IndependenceInputError(ValueError):
    """Raised when a dispatch record cannot support an independence claim.

    ORPHAN-HIGH-421 — this exists so a caller CANNOT hand the checker a
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


@dataclass(frozen=True)
class _BoundSeat:
    role: str
    claim_ids: frozenset[str]
    principal: Principal


# The ledger's own failure modes on a strict read. Anything else is a defect
# and propagates.
_LEDGER_READ_FAILURES: tuple[type[BaseException], ...] = (
    GovernanceError, LedgerIntegrityError, LedgerReadLimitError, OSError, ValueError,
)


def _sealed_response(root: Path, accepted: Mapping[str, Any]) -> dict[str, Any] | None:
    """The sealed envelope an accepted result names, read as the bytes its
    ``output_hash`` seals; ``None`` when they cannot be read or do not match."""
    from .agent_invocations import (
        _read_stable_submission_artifact,
        resolve_output_artifact_path,
    )

    output_path = accepted.get("output_path")
    if not isinstance(output_path, str) or not output_path:
        return None
    try:
        content = _read_stable_submission_artifact(
            resolve_output_artifact_path(root, output_path)
        )
    except OSError:
        return None
    if "sha256:" + hashlib.sha256(content).hexdigest() != accepted.get("output_hash"):
        return None
    try:
        envelope = json.loads(content)
    except (UnicodeDecodeError, json.JSONDecodeError):
        return None
    return envelope if isinstance(envelope, dict) else None


def _bind_seats(
    dispatched: Sequence[RoundDispatch],
    base_dir: str | Path,
) -> tuple[list[_BoundSeat], list[str]]:
    """Bind every dispatched role to its receipt and its principal.

    A seat binds only when all of these hold, each refusal named for its role:
    a claim row (the receipt), a request row naming an agent (the seat), an
    accepted result whose sealed envelope reads back under its hash, a
    response stamped for THE SAME agent the seat was minted for, and an
    executed route (:func:`executed_route`).
    """
    from .agent_invocations import accepted_result_for_request

    root = Path(base_dir)
    reasons: list[str] = []
    claims_path = root / "agent-invocations" / "claims.jsonl"
    if not claims_path.exists():
        return [], ["claims_jsonl_missing"]
    if not segment_paths(root, "agent_invocation_requests"):
        return [], ["requests_jsonl_missing"]
    by_request: dict[str, list[dict[str, Any]]] = {}
    for row in load_jsonl(claims_path):
        rid = row.get("request_id")
        if rid:
            by_request.setdefault(str(rid), []).append(row)
    request_rows: dict[str, dict[str, Any]] = {}
    for row in load_segments(root, "agent_invocation_requests"):
        rid = row.get("request_id")
        if rid and row.get("target_agent"):
            request_rows[str(rid)] = row
    attempt_rows: list[dict[str, Any]] | None = None
    bound: list[_BoundSeat] = []
    for dispatch in dispatched:
        role = dispatch.role
        rows_for = by_request.get(str(dispatch.request_id), [])
        if not rows_for:
            reasons.append(f"{role}_no_claim_row")
            continue
        claim_ids = frozenset(str(r.get("claim_id")) for r in rows_for if r.get("claim_id"))
        request_row = request_rows.get(str(dispatch.request_id))
        if request_row is None:
            reasons.append(f"{role}_no_request_row")
            continue
        seat = seat_principal(request_row)
        if seat is None:
            reasons.append(f"{role}_request_names_no_principal")
            continue
        try:
            accepted = accepted_result_for_request(
                request_id=str(dispatch.request_id), base_dir=root,
            )
        except _LEDGER_READ_FAILURES as exc:
            reasons.append(f"{role}_accepted_result_unreadable:{type(exc).__name__}")
            continue
        if accepted is None:
            reasons.append(f"{role}_no_accepted_result")
            continue
        response = _sealed_response(root, accepted)
        if response is None:
            reasons.append(f"{role}_sealed_response_unavailable")
            continue
        answered = response_principal(response)
        if answered != seat:
            reasons.append(
                f"{role}_response_principal_mismatch:{seat}!={answered or 'none'}"
            )
            continue
        details = response.get("details")
        if (
            attempt_rows is None
            and isinstance(details, dict)
            and details.get("runtime_attempt_ledger_hash")
        ):
            try:
                attempt_rows = load_declared_jsonl(
                    root / "governance.jsonl", expected_surface="tools_governance",
                )
            except _LEDGER_READ_FAILURES as exc:
                reasons.append(f"{role}_runtime_attempt_ledger_unreadable:{type(exc).__name__}")
                continue
        route = executed_route(response, attempt_rows=attempt_rows or ())
        if route is None:
            reasons.append(f"{role}_executed_route_unavailable")
            continue
        bound.append(_BoundSeat(
            role=role,
            claim_ids=claim_ids,
            principal=Principal(agent=seat, provider=route[0], model=route[1]),
        ))
    return bound, reasons


def verify_principal_disjointness(
    *,
    dispatches: "Sequence[RoundDispatch]",
    base_dir: str | Path,
    min_dispatched: int = 2,
) -> tuple[bool, list[str]]:
    """N-party source-level independence over dispatched roles.

    ORPHAN-HIGH-421 — generalises the old three-argument claim check. The
    property is pairwise: no two roles may share a ``claim_id`` (the
    receipt) or a principal. The principal check is the one that matters —
    every claim gets a fresh claim_id, so a single agent could hold every
    role and pass the receipt check alone.

    ARIA-HIGH-193 — the principal's agent is :func:`seat_principal` of the
    role's REQUEST row (the agent the kernel minted it for), not the claim's
    ``agent_id``: that is the executor process that carried the seat, shared
    by every seat one run drains, so it failed every live panel.

    ARIA-MEDIUM-225 — and the agent is only half of it. The principal is the
    agent bound to the route that executed the seat (:class:`Principal`),
    read from the seat's accepted, sealed response; the response must be
    stamped for the agent the seat was minted for. A seat that cannot be
    bound all the way is a named refusal, never a pass. The pairwise
    conflict stays the agent (see :class:`Principal`); a shared route is
    :func:`verify_route_distinctness`'s question.

    Roles with no ``request_id`` are skipped because nothing was
    dispatched for them; ``min_dispatched`` is the floor that stops that
    skip from emptying the check.
    """
    dispatched = [d for d in dispatches if d.was_dispatched]
    if len(dispatched) < min_dispatched:
        return False, [f"insufficient_dispatched_roles:{len(dispatched)}<{min_dispatched}"]
    bound, reasons = _bind_seats(dispatched, base_dir)
    if reasons:
        return False, reasons
    # Pair in the caller's order, not alphabetically: the reason strings
    # are read by operators and asserted by invariants, so
    # "primary_challenger_..." must not silently become
    # "challenger_primary_...".
    for i, left in enumerate(bound):
        for right in bound[i + 1:]:
            if left.claim_ids & right.claim_ids:
                reasons.append(f"{left.role}_{right.role}_claim_id_overlap")
            if left.principal.agent == right.principal.agent:
                reasons.append(f"{left.role}_{right.role}_same_principal:{left.principal.agent}")
    return (len(reasons) == 0), reasons


def verify_route_distinctness(
    *,
    dispatches: "Sequence[RoundDispatch]",
    base_dir: str | Path,
    min_distinct_routes: int,
) -> tuple[bool, list[str]]:
    """ARIA-MEDIUM-225 — do these seats span ``min_distinct_routes`` routes?

    For a decision that CLEARS something (an escalation), distinct agent
    names are not enough: the voters that carry the decision must have been
    executed on at least ``min_distinct_routes`` distinct (provider, model)
    routes, so no single model can carry it by answering under several
    names. Every seat must bind (:func:`_bind_seats`) first.
    """
    dispatched = [d for d in dispatches if d.was_dispatched]
    bound, reasons = _bind_seats(dispatched, base_dir)
    if reasons:
        return False, reasons
    routes = sorted({seat.principal.route for seat in bound})
    if len(routes) < min_distinct_routes:
        spelled = ",".join(f"{provider}/{model}" for provider, model in routes)
        return False, [f"distinct_routes:{len(routes)}<{min_distinct_routes}:{spelled}"]
    return True, []


# ORPHAN-HIGH-573 — `verify_claim_disjointness` was DELETED here on 2026-09-09.
#
# It was a pure ADAPTER: it built three `RoundDispatch` rows from three request
# ids and returned `verify_principal_disjointness(...)` unchanged. Same question,
# same answer, different argument shape — and no production caller, while
# `verify_principal_disjointness` is live from `human_required_adjudication.py:519`
# and from two callsites in this module.
#
# Its ORPHAN-HIGH-421 docstring is preserved in the surviving function, which is
# where the three properties (a claim row per role, no shared claim_id, no shared
# agent_id) are actually enforced. Callers that have three request ids build the
# rows themselves; that is one line more at the callsite and one fewer way for
# the two answers to drift apart.


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

    ORPHAN-HIGH-421 — ``compute_jaccard_similarity`` returns 0.0 when
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

    ORPHAN-HIGH-421 — takes typed :class:`RoundDispatch` records instead
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
