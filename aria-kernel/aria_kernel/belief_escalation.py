"""M4+M8/E8 — the belief-verdict channel: contradictions reach a human,
and the human's verdict finally moves belief confidence.

Two halves of one severed loop, closed together because each is useless
alone:

* M4 — contradictions had no escalation producer. `_record_contradiction`
  appended `status: open` rows and the pressure path surfaced a generic
  "review the ledger" line, but nothing ever minted a HUMAN_REQUIRED
  record a human could adjudicate: a contradiction could stay open for
  months with no path to a verdict.
* M8 — `record_operator_feedback` accepted `affected_belief_ids` and
  `memory._feedback_adjustment` read it, but NO producer ever passed it:
  human and AI verdicts could never move belief confidence. The general
  producer (bind beliefs to findings by evidence overlap) belongs to the
  comprehension program — mechanical file-matching would re-introduce the
  drift the field exists to avoid. But when an operator adjudicates a
  BELIEF escalation, the affected belief is exact, by construction: this
  module is that narrow, honest producer.

Channel: contradiction open across >= min_open_cycles distinct cycles →
`record_human_required(kind=belief_escalation, belief_id, ...)` (idempotent
per belief) → an adjudicator resolves with a verdict → a feedback row
carrying `affected_belief_ids=[belief_id]` → `_feedback_adjustment` moves the
belief's confidence. The learning loop is closed end to end for the first
time.

JJ-3 (ORPHAN-HIGH-755) closed the last human-shaped link in that chain: the
adjudicator is now the EXISTING Y7/Y8 agent panel for escalations that carry
a belief identity (see `execute_belief_panel_correction` below), and the
operator only for the ones that do not, or the ones the panel refuses.

F0.7 (ARIA-MEDIUM-730) — a standing contradiction no longer mints a
HUMAN_REQUIRED record at all: it asks the consensus arbiter once
(`judge_fanout.dispatch_arbiter_for_belief`), and the ruling folds through
`record_belief_arbitration` under the same ground-truth boundary. The panel
path below stays for the belief_escalation records minted before F0.7, which
remain open in live stores until adjudicated.
"""
from __future__ import annotations

from pathlib import Path
from typing import Any

from .tool_registry import GovernanceError, ensure_tools_dir

__all__ = [
    "BELIEF_ESCALATION_KIND",
    "BELIEF_PANEL_JUDGE_ID",
    "BELIEF_PANEL_SOURCE_TYPE",
    "BELIEF_PANEL_VERDICT",
    "belief_panel_finding_id",
    "contradiction_inputs",
    "escalate_stuck_contradictions",
    "execute_belief_panel_correction",
    "record_belief_arbitration",
    "standing_contradiction_inputs",
]

BELIEF_ESCALATION_KIND = "belief_escalation"

# WHY 3: one contradictory sighting can be adapter noise, two can be a flaky
# rule; three distinct cycles of the same open contradiction is a standing
# disagreement between ARIA's memory and its scanners — exactly the thing the
# arbiter should settle.
DEFAULT_MIN_OPEN_CYCLES = 3


def _standing_contradictions(
    root: Path, min_open_cycles: int,
) -> dict[str, tuple[dict[str, Any], int]]:
    """belief_id -> (latest open contradiction row, distinct open cycles), for
    every belief contradicted in at least ``min_open_cycles`` cycles."""
    from .memory import load_jsonl

    path = root / "memory" / "contradictions.jsonl"
    cycles_by_belief: dict[str, set[str]] = {}
    latest_row: dict[str, dict[str, Any]] = {}
    for row in load_jsonl(path) if path.exists() else []:
        if row.get("status", "open") != "open":
            continue
        belief_id = str(row.get("belief_id") or "")
        if not belief_id:
            continue
        cycles_by_belief.setdefault(belief_id, set()).add(str(row.get("cycle_id") or ""))
        latest_row[belief_id] = row
    return {
        belief_id: (latest_row[belief_id], len(cycles))
        for belief_id, cycles in sorted(cycles_by_belief.items())
        if len(cycles) >= min_open_cycles
    }


def contradiction_inputs(*, belief_id: str, contradiction: dict[str, Any]) -> dict[str, Any]:
    """J4 — what the belief arbiter is bound to: the belief and the
    contradiction it was asked about (not the cycle count, which grows every
    cycle the contradiction stands)."""
    from .judge_fanout import ARBITER_SUBJECT_BELIEF, arbiter_inputs

    return arbiter_inputs(ARBITER_SUBJECT_BELIEF, {
        "belief_id": belief_id,
        "source_tool_id": str(contradiction.get("source_tool_id") or ""),
        "reason": str(contradiction.get("reason") or ""),
    })


def standing_contradiction_inputs(
    *, belief_id: str, base_dir: str | Path | None = None,
    min_open_cycles: int = DEFAULT_MIN_OPEN_CYCLES,
) -> dict[str, Any] | None:
    """The belief's current arbiter inputs, or None when its contradiction no
    longer stands."""
    standing = _standing_contradictions(ensure_tools_dir(base_dir), min_open_cycles).get(belief_id)
    return None if standing is None else contradiction_inputs(belief_id=belief_id, contradiction=standing[0])


def escalate_stuck_contradictions(
    *,
    cycle_id: str,
    base_dir: str | Path | None = None,
    min_open_cycles: int = DEFAULT_MIN_OPEN_CYCLES,
) -> dict[str, Any]:
    """F0.7 — ask the arbiter, once, about each belief whose contradiction
    persists (``judge_fanout.dispatch_arbiter_for_belief``). Before F0.7 this
    minted a HUMAN_REQUIRED record per belief.
    """
    from .judge_fanout import dispatch_arbiter_for_belief

    root = ensure_tools_dir(base_dir)
    standing = _standing_contradictions(root, min_open_cycles)
    arbitration = [
        dispatch_arbiter_for_belief(
            belief_id=belief_id, contradiction=row, open_cycles=open_cycles,
            cycle_id=cycle_id, base_dir=root,
        )
        for belief_id, (row, open_cycles) in standing.items()
    ]
    return {
        "schema_version": 1,
        "cycle_id": cycle_id,
        "escalated_belief_ids": sorted(standing),
        "arbitration": arbitration,
    }


def record_belief_arbitration(
    *,
    request: dict[str, Any],
    verdict_block: dict[str, Any],
    base_dir: str | Path | None = None,
) -> dict[str, Any]:
    """F0.7 — fold the arbiter's ruling on a standing contradiction.

    The JJ-3 ground-truth boundary holds: the row is ``ai_consensus`` (never
    human), one judge agreed of one that voted (never ground truth), its
    subject is the belief, and the belief moves only on
    ``BELIEF_PANEL_VERDICT`` — a ruling that the belief stands records the
    ruling and moves nothing. Idempotent per arbiter request, so a bridge
    replay cannot stack a second correction.
    """
    from .bridge_exceptions import BridgeContractRefused
    from .confidence import confidence_in_unit_interval
    from .feedback_store import (
        FEEDBACK_VERDICTS,
        JUDGMENT_SUBJECT_BELIEF,
        load_feedback,
        record_operator_feedback,
    )
    from .judge_fanout import CONSENSUS_ARBITER_AGENT

    root = ensure_tools_dir(base_dir)
    verdict = verdict_block.get("verdict")
    if verdict not in FEEDBACK_VERDICTS:
        raise BridgeContractRefused(f"belief arbitration expected verdict in {FEEDBACK_VERDICTS}, got {verdict!r}")
    request_id = str(request.get("request_id") or "")
    for row in load_feedback(tool_id=str(request.get("tool_id") or ""), base_dir=root):
        if request_id in (row.get("request_ids") or []):
            return row
    belief_id = str(request["arbiter_inputs"]["facts"]["belief_id"])
    return record_operator_feedback(
        tool_id=str(request.get("tool_id") or ""),
        run_id=str(request.get("run_id") or ""),
        finding_id=str(request.get("finding_id") or ""),
        verdict=verdict,
        severity="medium",
        note=f"arbiter ruling on the standing contradiction of belief {belief_id}",
        affected_belief_ids=[belief_id] if verdict == BELIEF_PANEL_VERDICT else None,
        source_type=BELIEF_PANEL_SOURCE_TYPE,
        judge_id=CONSENSUS_ARBITER_AGENT,
        confidence=confidence_in_unit_interval(verdict_block.get("confidence")),
        rationale=str(verdict_block.get("rationale") or "")[:2000],
        evidence_refs=[str(r) for r in verdict_block.get("evidence_refs") or [] if isinstance(r, str) and r.strip()],
        judgment_group_id=str(request.get("judgment_group_id") or ""),
        judge_count=1,
        judges_voted=1,
        judgment_subject=JUDGMENT_SUBJECT_BELIEF,
        request_ids=[request_id],
        base_dir=root,
    )


# JJ-3 (ORPHAN-HIGH-755) — the panel-side half of the same channel.
#
# WHY THIS EXISTS: `escalate_stuck_contradictions` above mints a
# HUMAN_REQUIRED record and `resolve_human_required` fans an OPERATOR verdict
# into `affected_belief_ids`. Between those two the loop still had a person
# standing in it: `escalation_adjudicability` did not admit
# `belief_escalation`, and an unadmitted kind is irreducible by construction,
# so every standing contradiction parked in the operator queue. The Y7/Y8
# panel that already adjudicates lease deaths, genesis candidates and tool
# promotions is the adjudicator; this is the executor its resolve quorum
# calls, exactly as `promotion_panel.execute_tool_promotion_panel_approval`
# and `agent_genesis.execute_genesis_panel_approval` are called.
#
# THE GROUND-TRUTH BOUNDARY IS THE LOAD-BEARING PART
#   `source_type="human"` is what judge calibration, false-positive
#   suppression and goldset proposal score AGAINST. A panel row written as
#   human would have the judge fleet grading itself with its own output — the
#   defect `resolve_human_required` already refuses for the `verdict`
#   parameter. This writer therefore has NO source_type parameter: the value
#   is a module constant, so there is no argument through which any caller
#   could select "human". The row is an ANCHOR (ground truth) only when the
#   panel was UNANIMOUS — a 2-1 correction still moves the belief but can
#   never become repository truth (`feedback_store.is_ground_truth_row`).

# The one direction a panel may move a belief. The escalation says "this
# belief has stood contradicted for N cycles"; a resolve quorum AFFIRMS the
# contradiction, which makes the BELIEF the false positive (memory's
# `_feedback_adjustment`: -0.1 at medium severity). The inverse is
# deliberately unreachable: a panel that could vote a belief's confidence UP
# would be ARIA reading its own agreement as evidence, which is the exact
# ratchet `_record_belief` had to be fixed for.
BELIEF_PANEL_VERDICT: str = "false_positive"
# Never "human" — see the boundary note above. Named, not inlined, so the
# pin has something to assert against.
BELIEF_PANEL_SOURCE_TYPE: str = "ai_consensus"
BELIEF_PANEL_JUDGE_ID: str = "aria-adjudication-panel"


def _panel_agent_model(agent_id: str) -> str:
    """The model an adjudicator actually runs as, from its frontmatter.

    Read through `read_agent_runtime_profile` rather than recorded on the
    opinion: the opinion says who spoke, the frontmatter is the SSoT for
    what they spoke as, and duplicating it onto the opinion would be a
    second place for the tier to drift.
    """
    from .agent_runtime_profile import read_agent_runtime_profile

    try:
        return str(read_agent_runtime_profile(agent_id).model or "").strip()
    except Exception:
        # An unresolvable agent contributes NO receipt. Fail closed: the
        # anchor predicate then sees fewer distinct models and declines to
        # treat the row as truth, which is the honest reading of "we cannot
        # say what produced this".
        return ""


def belief_panel_finding_id(belief_id: str) -> str:
    """The feedback ledger's identity for a belief adjudication.

    One spelling, shared with the operator path in `resolve_human_required`:
    both producers write the SAME (run_id, finding_id) key, which is what
    makes "already adjudicated" answerable from the ledger instead of
    guessed.
    """
    return f"belief-escalation:{belief_id}"


def execute_belief_panel_correction(
    *,
    escalation_id: str,
    record: dict[str, Any],
    judge_count: int,
    judges_voted: int,
    panel_agent_ids: tuple[str, ...] = (),
    base_dir: str | Path | None = None,
) -> dict[str, Any]:
    """Write the belief-confidence correction a panel's resolve quorum earned.

    Called by `human_required_adjudication.adjudicate_human_required` AFTER
    the record resolves, because the proof below demands a RESOLVED,
    agent-panel, `panel_outcome=resolved` record — the same shared resolver
    the promotion and genesis lanes use. A hand-built ``record`` dict proves
    nothing: the panel decision is re-derived from the record FILE, so a ref
    naming no adjudication, or one the panel REFUSED, writes no row.

    Idempotent on (run_id, finding_id): a re-fold of the same escalation must
    not stack a second -0.1 onto the belief, and an escalation an operator
    already adjudicated keeps his row rather than gaining a second one.
    """
    from .feedback_store import (
        JUDGMENT_SUBJECT_BELIEF,
        load_feedback,
        record_operator_feedback,
    )
    from .human_required import resolve_panel_adjudication_proof

    root = ensure_tools_dir(base_dir)
    context = record.get("context") or {}
    belief_id = str(context.get("belief_id") or "").strip()
    if not belief_id:
        raise GovernanceError("belief_panel_correction_missing_belief_id")
    resolve_panel_adjudication_proof(
        adjudication_ref=escalation_id,
        expected_kind=BELIEF_ESCALATION_KIND,
        context_match={"belief_id": belief_id},
        error_prefix="belief_panel",
        base_dir=root,
    )
    finding_id = belief_panel_finding_id(belief_id)
    for row in load_feedback(base_dir=root):
        if row.get("run_id") == escalation_id and row.get("finding_id") == finding_id:
            return row
    return record_operator_feedback(
        tool_id=str(context.get("source_tool_id") or "unknown"),
        # The escalation record IS the run this verdict came out of, and the
        # finding is its own kind — real identities, not pointers to findings
        # that do not exist (the same rule the operator path follows).
        run_id=escalation_id,
        finding_id=finding_id,
        verdict=BELIEF_PANEL_VERDICT,
        severity="medium",
        note=(
            f"independent agent panel adjudicated belief escalation "
            f"{escalation_id} ({judge_count}/{judges_voted} judges agreed)"
        ),
        affected_belief_ids=[belief_id],
        source_type=BELIEF_PANEL_SOURCE_TYPE,
        judge_id=BELIEF_PANEL_JUDGE_ID,
        rationale=str(context.get("contradiction_reason") or "")[:2000],
        evidence_refs=[f"aria-tools/human-required/{escalation_id}.json"],
        # AGREEMENT vs ATTENDANCE, both read off the fold. Equal and >=
        # ANCHOR_MIN_JUDGE_COUNT is what makes the row ground-truth-bearing;
        # a 2-1 correction still moves the belief and settles nothing else.
        judge_count=judge_count,
        judges_voted=judges_voted,
        # JJ-3 (ORPHAN-HIGH-755) - the WRITE the operator authorised is a
        # correction to ONE BELIEF, and it is bounded to that. Declaring the
        # subject is what keeps it bounded: without it a unanimous panel row
        # is ground-truth-bearing for whatever adapter the escalation named,
        # and `judge_fanout.mint_anchor_judgments` (which does NOT join
        # recorded runs the way readiness does) would retire one of that
        # adapter's real anchor debts per belief adjudicated - belief work
        # silently suppressing finding judgement.
        judgment_subject=JUDGMENT_SUBJECT_BELIEF,
        # G-2 — the observer receipt, resolved through the SAME frontmatter
        # SSoT the executor dispatches by, so the row cannot claim a model
        # the fleet does not actually run. A panel of three agents that all
        # resolve to one model is one observation, and the anchor predicate
        # will refuse it — which is the correct outcome, not a regression.
        observers=[
            {"judge_id": agent_id, "model": _panel_agent_model(agent_id)}
            for agent_id in panel_agent_ids
            if _panel_agent_model(agent_id)
        ] or None,
        base_dir=root,
    )
