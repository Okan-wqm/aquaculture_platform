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
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

from .agent_invocations import (
    create_agent_invocation_request,
    list_agent_invocation_requests,
)
from .plan_convergence import events_path, fold_plan_state
from .ledger import load_declared_jsonl
from .tool_registry import GovernanceError, append_tools_governance, ensure_tools_dir

QUESTIONING_ROLE = "verification"

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
        "cannot establish either way; it is not a failure to return it."
    )


def open_decision_questioning(
    *,
    base_dir: str | Path | None = None,
    sample_size: int = DEFAULT_SAMPLE_SIZE,
    target_agent: str | None = None,
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
    for decision in sampled:
        plan_id = decision["plan_id"]
        request = create_agent_invocation_request(
            target_agent=resolved_target,
            role=QUESTIONING_ROLE,
            suggested_prompt=_questioning_prompt(decision),
            must_satisfy=[
                {
                    "id": f"question-decision-{plan_id}",
                    "criterion": (
                        "verdict is one of upheld/overturned/insufficient_evidence, "
                        "names which of the three attacks were attempted, and cites "
                        "file:line evidence for any claim that the decision was wrong"
                    ),
                }
            ],
            allowed_scope=[f"plan-convergence/{plan_id}"],
            evidence_refs=[f"plan:{plan_id}"],
            convergence_id=plan_id,
            base_dir=root,
        )
        request_ids.append(str(request["request_id"]))

    summary = {
        "$schema": "aria/decision-questioning/v1",
        "schema_version": 1,
        "unquestioned_decisions_seen": len(candidates),
        "questioned": [row["plan_id"] for row in sampled],
        "request_ids": request_ids,
        "target_agent": resolved_target,
        "sample_size": sample_size,
    }
    append_tools_governance(root, "decision_questioning_opened", dict(summary))
    return summary


__all__ = [
    "CLOSED_DECISION_STATES",
    "DEFAULT_SAMPLE_SIZE",
    "QUESTIONING_ROLE",
    "already_questioned",
    "closed_decisions",
    "open_decision_questioning",
    "sample_decisions",
]
