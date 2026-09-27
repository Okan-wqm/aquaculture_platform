"""The closed vocabulary of reasons a work candidate is NOT schedulable — and
who clears each one.

WHY THIS MODULE EXISTS. `mission.adopt_task_candidates` refuses a candidate
that carries ``blocked_by`` and records ``mission_candidate_refused
reason=candidate_blocked``. Measured on the live store 2026-09-12
(origin/aria/state `tools/governance.jsonl`): 71 such rows across every
nightly from 2026-08-13 to 2026-09-04, 42 naming a ``shadow_run_summary``
candidate and 29 a ``capability_gap shadow_run:*`` gap. Joined to
`tools/tasks/task-candidates.jsonl` on (cycle_id, source, source_id): 43 of
the candidates carried ``genesis_adjudication_required`` — "the agent panel
adjudicates this, not the operator" (Y8 / ORPHAN-HIGH-709) — 15 carried the
pre-Y8 spelling ``operator_feedback_required`` (the operator's), and 13
predate the first stored payload and cannot be joined. The row said
``candidate_blocked`` for every one of them and nothing else, so an operator
reading the ledger could not tell "the panel has it, do nothing" from "the
registry is unreadable, repair it". A refusal that does not name who clears
it is a refusal nobody clears.

WHAT IT IS. One table: token → owner → the sentence an operator needs. The
producers (`capability_gap._gap`, `pressure`, `task`) keep minting the tokens
they always minted; this table is the reader's side of that contract, and
`describe_candidate_block` is the ONLY way a refusal row learns what a token
means. A token that is not in the table is disclosed as ``unregistered``
with the operator action "register it here" — the vocabulary miss becomes an
operator-visible fact instead of a silent generic reason, and
`tests/test_candidate_blocks.py` walks the producers' source so a new token
cannot be minted without a row here.

THE OWNER DECIDES THE ROUTE. `task.generate_task_candidates` reads the owner
off this table: a panel-owned candidate is routed to the panel and never
offered to the adopter (no refusal row — nothing was refused); an
operator-owned one is disclosed outside the admission budget and refused
once per claim.

OWNERSHIP RULE. A candidate with several tokens is owned by the OPERATOR if
any token is operator-owned; the panel owns a candidate only when every
token is the panel's. The stronger claim wins because the operator is the
only owner who can act on all of them.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Iterable

from .tool_registry import GovernanceError

# Who clears a block. `agent_panel` — the genesis / adjudication panel opens
# and folds it without a human (`agent_genesis.sweep_candidate_gaps_for_
# adjudication`); `operator` — a human must change the store or the repo.
OWNER_AGENT_PANEL = "agent_panel"
OWNER_OPERATOR = "operator"
CANDIDATE_BLOCK_OWNERS: tuple[str, ...] = (OWNER_AGENT_PANEL, OWNER_OPERATOR)

# Y8 (ORPHAN-709) — the genesis gate token. Renamed from
# "operator_feedback_required" (İ2 semantic reversal): a gap carrying ONLY
# this token routes to the agent panel instead of parking on the operator.
# `capability_gap.GENESIS_ADJUDICATION_BLOCK_TOKEN` re-exports it so the
# producer and this vocabulary cannot drift apart.
GENESIS_ADJUDICATION_REQUIRED = "genesis_adjudication_required"


@dataclass(frozen=True)
class CandidateBlock:
    """One row of the vocabulary.

    ``parameterized`` marks a token minted as ``<prefix>:<parameter>`` (the
    pressure engine writes ``candidate_tool_unregistered:<tool_id>``); the row
    then matches on the prefix and the parameter travels in the token itself.
    """

    token: str
    owner: str
    operator_action: str
    parameterized: bool = False

    def matches(self, value: str) -> bool:
        if self.parameterized:
            return value.startswith(self.token) and len(value) > len(self.token)
        return value == self.token


CANDIDATE_BLOCKS: tuple[CandidateBlock, ...] = (
    CandidateBlock(
        GENESIS_ADJUDICATION_REQUIRED,
        OWNER_AGENT_PANEL,
        "none: the genesis panel adjudicates this gap "
        "(agent_genesis.sweep_candidate_gaps_for_adjudication opens escalation "
        "genesis-<sha256(capability_gap_key)[:16]>); if that escalation keeps "
        "folding still_escalated:panel_incomplete while its three panel "
        "requests read ACCEPTED, the adjudicators answered but their verdict "
        "is not reaching the fold — read the human_required_adjudication_folded "
        "row, not this one",
    ),
    CandidateBlock(
        "registry_repair_required",
        OWNER_OPERATOR,
        "repair aria-tools/registry.json: it is unreadable",
    ),
    CandidateBlock(
        "real_adapter_required",
        OWNER_OPERATOR,
        "replace the tool's stub runner (shadow_runner.py / noop.py / echo) with a real adapter",
    ),
    CandidateBlock(
        "manifest_required",
        OWNER_OPERATOR,
        "add tools/aria-adapters/<tool_id>.tool.json for the registered tool",
    ),
    CandidateBlock(
        "registry_compile_required",
        OWNER_OPERATOR,
        "compile the registry so the adapter manifest is registered",
    ),
    CandidateBlock(
        "pressure_candidate_repair_required",
        OWNER_OPERATOR,
        "the pressure names a tool the registry does not have: register it or "
        "fix the pressure's candidate_tools",
    ),
    CandidateBlock(
        "fitness_evidence_review_required",
        OWNER_OPERATOR,
        "an ARIA fitness dimension scored at or below 0.25: review the latest "
        "fitness report's evidence for that dimension before any agent is "
        "drafted against it",
    ),
    CandidateBlock(
        "candidate_tool_unregistered:",
        OWNER_OPERATOR,
        "register the named tool or retire the pressure's binding to it",
        parameterized=True,
    ),
    CandidateBlock(
        "operator_feedback_required",
        OWNER_OPERATOR,
        "pre-Y8 token: record operator feedback on the gap, or re-run "
        "capability-gap detection so it is re-minted under the panel token",
    ),
)


def lookup_candidate_block(token: str) -> CandidateBlock | None:
    for block in CANDIDATE_BLOCKS:
        if block.matches(token):
            return block
    return None


def describe_candidate_block(blocked_by: Iterable[Any]) -> dict[str, Any]:
    """What a ``blocked_by`` list means: who owns it and what to do.

    Returns ``{"blocked_by", "owner", "operator_action", "unregistered"}``.
    Refuses an EMPTY list rather than describing it: a caller that asks what
    an unblocked candidate's block means has confused the two branches, and a
    description of nothing would read as a block in the ledger.
    """
    tokens = [str(item) for item in blocked_by if isinstance(item, str) and item.strip()]
    if not tokens:
        raise GovernanceError("describe_candidate_block requires at least one block token")
    owners: set[str] = set()
    actions: list[str] = []
    unregistered: list[str] = []
    for token in tokens:
        block = lookup_candidate_block(token)
        if block is None:
            unregistered.append(token)
            continue
        owners.add(block.owner)
        actions.append(f"{token}: {block.operator_action}")
    if unregistered:
        actions.append(
            "unregistered block token(s) "
            + ", ".join(unregistered)
            + ": add a CandidateBlock row in aria_kernel/candidate_blocks.py"
        )
    # Operator wins over panel: see the OWNERSHIP RULE in the module docstring.
    owner = (
        OWNER_OPERATOR
        if OWNER_OPERATOR in owners or unregistered
        else OWNER_AGENT_PANEL
    )
    return {
        "blocked_by": tokens,
        "owner": owner,
        "operator_action": "; ".join(actions),
        "unregistered": unregistered,
    }


__all__ = [
    "CANDIDATE_BLOCKS",
    "CANDIDATE_BLOCK_OWNERS",
    "GENESIS_ADJUDICATION_REQUIRED",
    "OWNER_AGENT_PANEL",
    "OWNER_OPERATOR",
    "CandidateBlock",
    "describe_candidate_block",
    "lookup_candidate_block",
]
