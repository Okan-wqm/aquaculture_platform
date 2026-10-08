"""Re-open a decision the pipeline already closed, and ask if it was right.

WHY THIS EXISTS. Every gate in this kernel judges work on its way IN. Plan
convergence asks two planners to agree; cross-review asks whether they agreed
for good reasons; the coverage gate asks what they both missed. All three ask
*before* the decision is made. Once a plan reaches CONVERGED nothing ever asks
again — the verdict becomes a fact, and the ledger records it as one.

That asymmetry is how a systematically wrong judgement survives. Two planners
sharing a blind spot converge faster than two who disagree, and convergence is
the signal the pipeline treats as success. The coverage gate was added because
convergence measures agreement rather than coverage; this phase is the same
observation applied one step later in time: **agreement at decision time is not
evidence at review time.**

WHAT IT SAMPLES, and why plans rather than findings or tools. A closed
decision needs a ledger with a terminal state, a stable identity, and content
worth re-reading. `plan_convergence` has all three — an append-only, hash-
chained events ledger, a `plan_id`, and a folded state whose terminal members
are enumerable. Accepted findings and promoted tools were considered and are
not used here: findings have no terminal-decision event of their own, and the
tool ladder's promotions are already re-examined by `tool_health`, so
questioning them again would duplicate a live control rather than add one.

WHY `verification` AND NOT A NEW ROLE. `agent_surface.REQUEST_ROLES` has
declared `verification` for a long time and — as the E9-a gate now measures —
nothing has ever minted it. Adding a fifth adversarial-sounding role beside a
dormant one would be the defect this programme keeps closing. This phase is
`verification`'s first producer, which is also why it adds the role to
`DISPATCHABLE_ROLES` and `ROLE_TARGET_PAIRING` in the same change: a minted
envelope that no executor will claim is a writer with no reader, and shipping
one from a module built to hunt them would be indefensible.

IDEMPOTENCE without a new ledger. Whether a decision has already been
questioned is answered from the invocation-requests ledger itself — the
envelope IS the record. A separate "already questioned" ledger would be a
second source of truth for a fact the first one already holds, and the two
would eventually disagree.

ARIA-HIGH-204 — THE ANSWER IS READ. Asking was only half the mechanism:
for every cycle the phase ran, `open_decision_questioning` minted a
`verification` envelope whose contract is a verdict from
{upheld, overturned, insufficient_evidence}, and no code ever loaded an
accepted result back. An overturn changed nothing, so the phase spent
judge budget on questions whose answers could not matter.
:func:`fold_questioning_results` is the reader: it turns each accepted
answer into a row on the declared ``decision_questioning_outcomes``
ledger and gives ``overturned`` the only effect the meta-layer is allowed
to have on its own — an operator-visible escalation. The plan's terminal
state is deliberately NOT rewritten: a self-audit that reopened its own
decisions would be a writer with no external authority behind it.

WHERE THE ANSWER LIVES. The prompt and the must_satisfy criterion both
name ``details.questioning`` verbatim, so a compliant production answer
is read from its tier-1 location; the prompt-derived marker
(``verdict=<token>``) and the ``details.verdict`` fallback exist only so
envelopes minted before the contract was named still fold instead of
silently rotting. Prose is never token-scanned: a bare closed-set word
can be the verdict an answer REFUSES ("should NOT be overturned"), and
reading it would invert the answer.
"""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any, Mapping

from .agent_invocations import (
    accepted_result_for_request,
    create_agent_invocation_request,
    list_agent_invocation_requests,
    resolve_output_artifact_path,
)
from .human_required import record_human_required
from .plan_convergence import events_path, fold_plan_state
from .ledger import load_declared_jsonl, state_transaction
from .request_admission import admit_request
from .tool_registry import GovernanceError, append_tools_governance, ensure_tools_dir, utc_now

QUESTIONING_ROLE = "verification"

# ARIA-HIGH-204 — the answer contract of a questioning envelope. Closed set:
# an answer outside it is recorded as ``unparsed``, never guessed into a
# verdict, because the action mapping below keys off the verdict value.
VERDICT_UPHELD: str = "upheld"
VERDICT_OVERTURNED: str = "overturned"
VERDICT_INSUFFICIENT_EVIDENCE: str = "insufficient_evidence"
VERDICT_UNPARSED: str = "unparsed"
QUESTIONING_VERDICTS: frozenset[str] = frozenset({
    VERDICT_UPHELD, VERDICT_OVERTURNED, VERDICT_INSUFFICIENT_EVIDENCE,
})

# The named block the answer contract lives in. The prompt and the
# must_satisfy criterion NAME this block verbatim, and the fold reads it
# first — one agreed location the writer and the reader cannot disagree
# about, the same one-answer-location contract the adjudication role
# holds (ARIA-HIGH-097).
QUESTIONING_DETAILS_KEY: str = "questioning"

# ARIA-HIGH-204 (re-review) — the ONLY prose form tier 3 accepts. A bare
# closed-set token is NOT a verdict: "the decision should NOT be
# overturned" contains the token it is refusing, and a substring scan
# turned that negation into the verdict itself — a false MEDIUM
# escalation on an answer that upheld the decision. The explicit
# `verdict=<token>` directive is a machine field, not prose, so reading
# it cannot invert a negation; anything else in prose is `unparsed`.
_VERDICT_MARKER_RE = re.compile(
    r"\bverdict\s*=\s*(upheld|overturned|insufficient_evidence)\b", re.IGNORECASE
)

# An overturn buys a MEDIUM escalation (7-day SLA window, see
# ``human_required.SLA_WINDOWS``). Not CRITICAL/HIGH: the decision's
# terminal state stands until a person reopens it, so the cost of a slow
# response is a wrong plan surviving longer, not a security boundary.
OVERTURN_ESCALATION_SEVERITY: str = "MEDIUM"
# The context kind of the escalation. Deliberately NOT in
# ``human_required_adjudication.ADJUDICABLE_CONTEXT_KINDS``: an unadmitted
# kind is irreducible by construction, so an overturn stays with the
# operator instead of being waved through by an agent panel.
OVERTURN_CONTEXT_KIND: str = "decision_questioning"

_OUTCOMES_RELATIVE = ("decision-questioning", "outcomes.jsonl")
OUTCOMES_SURFACE = "decision_questioning_outcomes"
OUTCOME_SCHEMA = "aria/decision-questioning-outcome/v1"
FOLD_SCHEMA = "aria/decision-questioning-fold/v1"

# The must_satisfy id the mint seals a questioning envelope under. One
# spelling shared by the mint and the fold: the fold recognises its own
# envelopes by this prefix, so the `verification` role staying open to
# future producers never leaks their answers into this outcome ledger.
QUESTION_MUST_SATISFY_PREFIX = "question-decision-"

# The states that mean "the pipeline acted on this". CONVERGED is a decision
# the pipeline believed; IMPLEMENTATION_MERGED is one it shipped. ABANDONED
# and HUMAN_REQUIRED are deliberately absent: those are decisions NOT to act,
# and re-litigating a refusal costs judge budget to defend the status quo.
CLOSED_DECISION_STATES: frozenset[str] = frozenset({"CONVERGED", "IMPLEMENTATION_MERGED"})

DEFAULT_SAMPLE_SIZE = 2


def closed_decisions(*, base_dir: str | Path | None = None) -> list[dict[str, Any]]:
    """Plans that reached a state the pipeline acted on, newest last."""
    root = ensure_tools_dir(base_dir)
    path = events_path(root)
    if not path.exists():
        return []
    decided_at: dict[str, str] = {}
    for event in load_declared_jsonl(path, expected_surface="plan_convergence_events"):
        plan_id = event.get("plan_id")
        recorded_at = event.get("recorded_at")
        if isinstance(plan_id, str) and plan_id and isinstance(recorded_at, str):
            decided_at[plan_id] = recorded_at
    decisions: list[dict[str, Any]] = []
    for plan_id, recorded_at in decided_at.items():
        try:
            state = fold_plan_state(plan_id=plan_id, base_dir=root)
        except Exception:
            # A row the reducer rejects is an integrity problem owned by the
            # ledger gate, not a decision to question.
            continue
        current = state.get("state") if isinstance(state, dict) else None
        if isinstance(current, str) and current in CLOSED_DECISION_STATES:
            decisions.append({"plan_id": plan_id, "state": current, "decided_at": recorded_at})
    decisions.sort(key=lambda row: (row["decided_at"], row["plan_id"]))
    return decisions


def already_questioned(plan_id: str, *, base_dir: str | Path | None = None) -> bool:
    """Has a verification envelope already been minted for this decision."""
    root = ensure_tools_dir(base_dir)
    return bool(
        list_agent_invocation_requests(
            base_dir=root, convergence_id=plan_id, role=QUESTIONING_ROLE
        )
    )


def sample_decisions(
    decisions: list[dict[str, Any]], *, sample_size: int = DEFAULT_SAMPLE_SIZE
) -> list[dict[str, Any]]:
    """The ``sample_size`` most recent decisions.

    Deterministic on purpose. A random sample would make two runs over the
    same ledger disagree about what was reviewed, and a self-audit whose
    scope cannot be reproduced cannot be audited in turn. Recency is the
    right bias because the phase asks about *the last cycle*, and because a
    wrong decision is cheapest to reverse before things are built on it.
    """
    if sample_size <= 0:
        return []
    return decisions[-sample_size:]


def _questioning_prompt(decision: dict[str, Any]) -> str:
    return (
        f"Adversarial re-review of CLOSED decision {decision['plan_id']} "
        f"(state={decision['state']}, decided_at={decision['decided_at']}).\n\n"
        "This plan already converged and the pipeline acted on it. Your job is "
        "NOT to re-run the convergence gate — it passed. Your job is to ask the "
        "question nobody asked at decision time: given what the repository "
        "looks like NOW, was this decision right?\n\n"
        "Attack it in this order:\n"
        "1. A shared blind spot. Both planners agreed; agreement is cheapest "
        "when both are wrong the same way. Name a consequence neither traced.\n"
        "2. The evidence. Re-resolve the plan's evidence_refs against the "
        "current tree. An evidence_ref that no longer resolves means the "
        "decision rests on a repository that no longer exists.\n"
        "3. The outcome. If the change landed, does the code do what the plan "
        "claimed it would? Cite file:line for the difference.\n\n"
        "Return verdict=upheld ONLY if you attempted all three and found "
        "nothing. verdict=insufficient_evidence is the correct answer when you "
        "cannot establish either way; it is not a failure to return it.\n\n"
        "Answer in the response envelope's details.questioning object and "
        "nowhere else: verdict (exactly one of upheld, overturned, "
        "insufficient_evidence), attacks_attempted (which of the three attacks "
        "above you attempted), and the file:line evidence for any claim that "
        "the decision was wrong. A verdict stated only in prose is not read."
    )


def open_decision_questioning(
    *,
    base_dir: str | Path | None = None,
    sample_size: int = DEFAULT_SAMPLE_SIZE,
    target_agent: str | None = None,
    cycle_id: str | None = None,
) -> dict[str, Any]:
    """Mint one ``verification`` envelope per sampled unquestioned decision.

    Returns a summary rather than raising when there is nothing to question:
    a cycle phase that raises on an empty ledger is a phase every early cycle
    has to special-case, and special cases are where phases get skipped.
    """
    from .agent_surface import allowed_targets_for_role

    root = ensure_tools_dir(base_dir)
    targets = allowed_targets_for_role(QUESTIONING_ROLE) or ()
    resolved_target = target_agent or (targets[0] if targets else None)
    if resolved_target is None:
        raise GovernanceError(f"decision_questioning_no_target_for_role:{QUESTIONING_ROLE}")
    if targets and resolved_target not in targets:
        raise GovernanceError(
            f"decision_questioning_target_not_paired:{resolved_target} "
            f"(allowed: {sorted(targets)})"
        )

    candidates = [
        decision
        for decision in closed_decisions(base_dir=root)
        if not already_questioned(decision["plan_id"], base_dir=root)
    ]
    sampled = sample_decisions(candidates, sample_size=sample_size)

    request_ids: list[str] = []
    questioned: list[str] = []
    throttled: str | None = None
    for decision in sampled:
        plan_id = decision["plan_id"]
        # ARIA-HIGH-364 — re-questioning a closed decision starts new work:
        # discretionary. A refused decision stays unquestioned, so the next
        # cycle samples it again; the refusal holds for this cycle.
        admission = admit_request("decision_questioning.open", QUESTIONING_ROLE, base_dir=root, cycle_id=cycle_id)
        if not admission.admitted:
            throttled = admission.refusal
            break
        request = create_agent_invocation_request(
            target_agent=resolved_target,
            role=QUESTIONING_ROLE,
            suggested_prompt=_questioning_prompt(decision),
            must_satisfy=[
                {
                    "id": f"{QUESTION_MUST_SATISFY_PREFIX}{plan_id}",
                    "description": (
                        "verdict is exactly one of upheld/overturned/"
                        "insufficient_evidence, written to "
                        "details.questioning.verdict in the response envelope, "
                        "with details.questioning.attacks_attempted naming "
                        "which of the three attacks were attempted, and "
                        "file:line evidence cited for any claim that the "
                        "decision was wrong"
                    ),
                }
            ],
            allowed_scope=[f"plan-convergence/{plan_id}"],
            evidence_refs=[f"plan:{plan_id}"],
            convergence_id=plan_id,
            base_dir=root,
            admission=admission,
        )
        request_ids.append(str(request["request_id"]))
        questioned.append(plan_id)

    summary = {
        "$schema": "aria/decision-questioning/v1",
        "schema_version": 1,
        "unquestioned_decisions_seen": len(candidates),
        "questioned": questioned,
        "request_ids": request_ids,
        "request_admission_throttled": throttled,
        "target_agent": resolved_target,
        "sample_size": sample_size,
    }
    append_tools_governance(root, "decision_questioning_opened", dict(summary))
    return summary


def _outcomes_path(root: Path) -> Path:
    return root.joinpath(*_OUTCOMES_RELATIVE)


def _is_questioning_request(request: Mapping[str, Any]) -> bool:
    """Is this envelope THIS lane's question, not another `verification` producer's?

    The role alone is not the identity: `verification` is a shared
    REQUEST_ROLES member and this phase is merely its first producer. The
    questioning mint seals its subject into the must_satisfy id
    (``question-decision-<plan_id>``), so the fold binds to that prefix and a
    future sibling lane's verification results get their own reader instead
    of being folded as decision-questioning outcomes.
    """
    items = request.get("must_satisfy")
    if not isinstance(items, list):
        return False
    return any(
        isinstance(item, dict)
        and isinstance(item.get("id"), str)
        and item["id"].startswith(QUESTION_MUST_SATISFY_PREFIX)
        for item in items
    )


def _closed_verdict(value: Any) -> str | None:
    if isinstance(value, str):
        verdict = value.strip()
        if verdict in QUESTIONING_VERDICTS:
            return verdict
    return None


def _read_answer_payload(
    root: Path, accepted: Mapping[str, Any],
) -> tuple[dict[str, Any] | None, str | None]:
    """The sealed response body behind an accepted result row.

    Returns ``(payload, None)`` or ``(None, reason)``; every failure reason
    becomes the ``unparsed_reason`` on the outcome row, because an answer
    that cannot be read is an answer that was given, not one that never
    existed.
    """
    output_path = accepted.get("output_path")
    if not isinstance(output_path, str) or not output_path:
        return None, "output_path_absent"
    path = resolve_output_artifact_path(root, output_path)
    if not path.exists():
        return None, "output_artifact_missing"
    try:
        payload = json.loads(path.read_text(encoding="utf-8", errors="replace"))
    except (OSError, json.JSONDecodeError) as exc:
        return None, f"output_artifact_unreadable:{str(exc)[:120]}"
    if not isinstance(payload, dict):
        return None, "output_payload_not_object"
    return payload, None


def _verdict_from_payload(
    payload: Mapping[str, Any],
) -> tuple[str, list[str] | None, str | None]:
    """ ``(verdict, attacks_attempted, unparsed_reason)`` from one answer.

    Extraction order, strongest evidence first:

    1. ``details.questioning.verdict`` — the named block the prompt and
       the must_satisfy criterion both point at, the same
       one-answer-location contract the adjudication role holds
       (ARIA-HIGH-097).
    2. ``details.verdict`` — a top-level details field some executors
       already write; still a declared field, still checked against the
       closed set.
    3. An explicit ``verdict=<token>`` directive (word-bounded) in the
       prose the response contract makes agents write anyway
       (``satisfaction_matrix`` notes/rationales, the envelope
       ``rationale``). Transitional safety for envelopes minted before
       the answer location was named; bare closed-set tokens are
       deliberately NOT scanned — "the decision should NOT be overturned"
       names the verdict it refuses, and reading that token would invert
       the negation into the verdict itself. Two DIFFERENT directives is
       an ambiguous answer: ``unparsed``, not the scanner's pick.

    Anything else is ``unparsed`` with the reason — the fold never guesses
    a verdict, because the effect mapping below keys off the value.
    """
    def _short(value: Any) -> str:
        return str(value)[:60]

    attacks: list[str] | None = None
    details = payload.get("details")
    if isinstance(details, dict):
        block = details.get(QUESTIONING_DETAILS_KEY)
        if isinstance(block, dict):
            raw = block.get("verdict")
            verdict = _closed_verdict(raw)
            if verdict is not None:
                attempted = block.get("attacks_attempted")
                if (
                    isinstance(attempted, list)
                    and attempted
                    and all(isinstance(item, str) and item.strip() for item in attempted)
                ):
                    attacks = [str(item).strip() for item in attempted]
                return verdict, attacks, None
            if raw is not None:
                return (
                    VERDICT_UNPARSED, None,
                    f"questioning_verdict_not_in_closed_set:{_short(raw)}",
                )
        raw = details.get("verdict")
        verdict = _closed_verdict(raw)
        if verdict is not None:
            return verdict, attacks, None
        if raw is not None:
            return (
                VERDICT_UNPARSED, None,
                f"details_verdict_not_in_closed_set:{_short(raw)}",
            )
    pieces: list[str] = []
    matrix = payload.get("satisfaction_matrix")
    if isinstance(matrix, list):
        for entry in matrix:
            if isinstance(entry, dict):
                for field in ("note", "rationale"):
                    text = entry.get(field)
                    if isinstance(text, str):
                        pieces.append(text)
    rationale = payload.get("rationale")
    if isinstance(rationale, str):
        pieces.append(rationale)
    directed: set[str] = set()
    for text in pieces:
        for match in _VERDICT_MARKER_RE.finditer(text):
            directed.add(match.group(1).lower())
    if len(directed) == 1:
        return directed.pop(), None, None
    if directed:
        return (
            VERDICT_UNPARSED, None,
            "verdict_tokens_ambiguous:" + ",".join(sorted(directed)),
        )
    return VERDICT_UNPARSED, None, "verdict_absent"


def _folded_result_row_ids(outcomes: Path) -> set[str]:
    """Every result row the outcomes ledger already carries."""
    return {
        str(row.get("result_row_id"))
        for row in load_declared_jsonl(outcomes, expected_surface=OUTCOMES_SURFACE)
    }


def fold_questioning_results(
    *,
    base_dir: str | Path | None = None,
    cycle_id: str | None = None,
) -> dict[str, Any]:
    """ARIA-HIGH-204 — read the answers the questioning phase asked for.

    One outcome row on the ``decision_questioning_outcomes`` ledger per
    accepted result, keyed by the result's ``row_id`` (idempotent: a
    re-fold appends nothing). An envelope with no accepted result yet is
    counted as unanswered and left alone — its answer is still owed, not
    unread. An accepted answer whose verdict cannot be established is
    recorded as ``unparsed`` with the reason, never silently dropped.

    The one effect an answer can have: ``overturned`` records a MEDIUM
    HUMAN_REQUIRED escalation under an unadmitted context kind, so the
    reopen decision stays with the operator. The plan's ledger state is
    not rewritten — this meta-layer observes and escalates; it does not
    overturn its own decisions.

    CONCURRENCY: the dedupe read that gates the append is taken INSIDE the
    same ``state_transaction`` that appends, so two concurrent folds
    cannot both read an empty ledger and both append. Actions
    (escalations, governance events) run before that transaction on
    purpose: ``record_human_required`` is idempotent on the record file,
    so a fold that dies between an action and its row is converged by the
    next fold, never stranded.
    """
    root = ensure_tools_dir(base_dir)
    outcomes = _outcomes_path(root)
    requests = [
        request
        for request in list_agent_invocation_requests(base_dir=root, role=QUESTIONING_ROLE)
        if _is_questioning_request(request)
    ]

    # Best-effort pre-read OUTSIDE the lock: it only keeps an ordinary
    # sequential re-fold from re-running actions already folded. The
    # authoritative dedupe read is the one inside the transaction below.
    already_folded = _folded_result_row_ids(outcomes)

    escalated: list[str] = []
    unanswered: list[str] = []
    pending_rows: list[dict[str, Any]] = []
    planned_row_ids: set[str] = set()

    for request in requests:
        request_id = str(request.get("request_id") or "")
        if not request_id:
            # A row without identity is an integrity problem owned by the
            # ledger gate, not an answer to fold.
            continue
        plan_id = str(request.get("convergence_id") or "")
        accepted = accepted_result_for_request(
            request_id=request_id, role=QUESTIONING_ROLE, base_dir=root,
        )
        if accepted is None:
            unanswered.append(request_id)
            continue
        result_row_id = str(accepted.get("row_id") or "")
        if result_row_id in already_folded or result_row_id in planned_row_ids:
            continue
        payload, read_error = _read_answer_payload(root, accepted)
        if payload is None:
            verdict, attacks, reason = VERDICT_UNPARSED, None, read_error
        else:
            verdict, attacks, reason = _verdict_from_payload(payload)

        # ACTION BEFORE LEDGER, on purpose — see the docstring's
        # CONCURRENCY paragraph.
        if verdict == VERDICT_OVERTURNED:
            record_human_required(
                request_id=request_id,
                severity=OVERTURN_ESCALATION_SEVERITY,
                reason=(
                    f"decision_questioning_overturned:{plan_id} "
                    f"({result_row_id}) — the adversarial re-review of the "
                    f"closed decision returned verdict=overturned; the "
                    f"decision's terminal state stands until reopened"
                ),
                context={
                    "kind": OVERTURN_CONTEXT_KIND,
                    "plan_id": plan_id,
                    "questioning_request_id": request_id,
                    "verdict": verdict,
                },
                base_dir=root,
            )
            escalated.append(plan_id)

        row: dict[str, Any] = {
            "$schema": OUTCOME_SCHEMA,
            "schema_version": 1,
            "plan_id": plan_id,
            "request_id": request_id,
            "result_row_id": result_row_id,
            "verdict": verdict,
            "folded_at": utc_now(),
        }
        if attacks:
            row["attacks_attempted"] = attacks
        if verdict == VERDICT_UNPARSED:
            row["unparsed_reason"] = reason
        append_tools_governance(
            root,
            "decision_questioning_verdict_unparsed"
            if verdict == VERDICT_UNPARSED
            else "decision_questioning_folded",
            {
                "plan_id": plan_id,
                "request_id": request_id,
                "result_row_id": result_row_id,
                "verdict": verdict,
                **({"unparsed_reason": reason} if verdict == VERDICT_UNPARSED else {}),
            },
        )
        pending_rows.append(row)
        planned_row_ids.add(result_row_id)

    written_rows: list[dict[str, Any]] = []
    if pending_rows:
        with state_transaction([outcomes]) as transaction:
            # The authoritative read, under the lock this append holds:
            # a concurrent fold's rows are visible here and deduped.
            folded_now = _folded_result_row_ids(outcomes)
            written_rows = [
                row for row in pending_rows
                if row["result_row_id"] not in folded_now
            ]
            if written_rows:
                transaction.append_declared_jsonl_rows(
                    outcomes, written_rows, expected_surface=OUTCOMES_SURFACE,
                )

    verdicts: dict[str, list[str]] = {
        verdict: [] for verdict in sorted(QUESTIONING_VERDICTS)
    }
    verdicts[VERDICT_UNPARSED] = []
    for row in written_rows:
        verdicts[str(row["verdict"])].append(str(row["plan_id"]))

    return {
        "$schema": FOLD_SCHEMA,
        "schema_version": 1,
        "cycle_id": cycle_id,
        "requests_seen": len(requests),
        "outcomes_written": len(written_rows),
        "unanswered": unanswered,
        "verdicts": verdicts,
        "escalated": escalated,
    }


__all__ = [
    "CLOSED_DECISION_STATES",
    "DEFAULT_SAMPLE_SIZE",
    "FOLD_SCHEMA",
    "OUTCOME_SCHEMA",
    "OUTCOMES_SURFACE",
    "QUESTIONING_DETAILS_KEY",
    "QUESTIONING_ROLE",
    "QUESTIONING_VERDICTS",
    "QUESTION_MUST_SATISFY_PREFIX",
    "VERDICT_INSUFFICIENT_EVIDENCE",
    "VERDICT_OVERTURNED",
    "VERDICT_UNPARSED",
    "VERDICT_UPHELD",
    "already_questioned",
    "closed_decisions",
    "fold_questioning_results",
    "open_decision_questioning",
    "sample_decisions",
]
