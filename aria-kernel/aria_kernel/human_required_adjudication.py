"""ORPHAN-HIGH-426 — independent-agent adjudication of HUMAN_REQUIRED.

Operator direction: an escalation should be adjudicated by INDEPENDENT
AGENTS rather than by waiting on a human. ``resolve_human_required``
previously documented itself as "Operator-only — kernel never
auto-resolves", so every lease-lifecycle escalation sat until a person
opened the directory.

WHY THIS IS ONLY SAFE ON TOP OF ORPHAN-HIGH-421
  A panel that cannot prove its members are distinct principals is not a
  panel — it is one agent approving its own escalation, which is the same
  defect class as a plan approving itself. Before ORPHAN-HIGH-421 the
  independence checker compared ``claim_id`` sets only, and every claim
  gets a fresh claim_id, so a single agent could hold every role and pass.
  This module therefore folds a verdict ONLY after
  :func:`independence_check.verify_principal_disjointness` confirms
  distinct ``agent_id`` values against the claims ledger.

THE IRREDUCIBLE CLASS
  Some escalations must never be agent-clearable, because an agent
  clearing them would be raising its own authority:

    * a profile transition (notably into ``autonomous``),
    * credential or signing-key material,
    * changes to ARIA's own governance, authority or kernel surfaces,
    * anything the risk policy classifies as ``L3`` or ``blocked``.

  The default is fail-closed in the strongest sense: an escalation whose
  scope CANNOT be established from its record is treated as irreducible.
  The panel only ever clears escalations that are provably low-risk, so a
  record with no classifiable context stays with the operator rather than
  being waved through by three agents reasoning about prose.

QUORUM AND FAIL-CLOSED OUTCOMES
  Each adjudicator returns ``resolve``, ``refuse`` or
  ``insufficient_evidence``. Resolution needs a quorum of ``resolve`` AND
  zero ``insufficient_evidence`` — an adjudicator that says it cannot tell
  is a blocker, not an abstention. A split, a short panel, a
  non-independent panel, or an unreadable opinion all leave the escalation
  open. Nothing here can move an escalation to resolved except positive,
  independent, quorum agreement.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .agent_invocations import (
    accepted_result_for_request,
    create_agent_invocation_request,
    derive_request_state,
)
from .agent_surface import allowed_targets_for_role
from .independence_check import RoundDispatch, verify_principal_disjointness
from .ledger import append_declared_jsonl, load_declared_jsonl
from .tool_registry import GovernanceError, append_tools_governance, ensure_tools_dir, utc_now


ADJUDICATION_ROLE: str = "human_required_adjudication"

# A three-member panel with a two-vote quorum: one dissent blocks nothing
# on its own, but one "cannot tell" does (see module docstring).
DEFAULT_PANEL_SIZE: int = 3
DEFAULT_QUORUM: int = 2

RESOLVE_VERDICT: str = "resolve"
REFUSE_VERDICT: str = "refuse"
INSUFFICIENT_VERDICT: str = "insufficient_evidence"
ADJUDICATOR_VERDICTS: frozenset[str] = frozenset({
    RESOLVE_VERDICT, REFUSE_VERDICT, INSUFFICIENT_VERDICT,
})

# Panel outcomes.
OUTCOME_RESOLVED: str = "resolved"
OUTCOME_REFUSED: str = "refused"
OUTCOME_STILL_ESCALATED: str = "still_escalated"

# Context kinds an agent panel may never clear. Closed set — an unknown
# kind is irreducible by default, so adding a risky kind cannot
# accidentally make it adjudicable.
IRREDUCIBLE_CONTEXT_KINDS: frozenset[str] = frozenset({
    "profile_transition",
    "credential_mint",
    "signing_key_rotation",
    "self_modification",
    "governance_override",
    "merge_authority",
})

# Context kinds whose scope is established and low-risk enough for a panel.
ADJUDICABLE_CONTEXT_KINDS: frozenset[str] = frozenset({
    "consensus_escalation",
    "lease_lifecycle",
    "maintenance_utility",
})

# Risk-policy lanes a panel may not clear.
IRREDUCIBLE_RISK_LANES: frozenset[str] = frozenset({"L3", "blocked"})

_ADJUDICATIONS_RELATIVE = ("human-required", "adjudications.jsonl")


@dataclass(frozen=True)
class AdjudicabilityVerdict:
    """Whether an escalation may be adjudicated by agents at all."""

    adjudicable: bool
    reason: str

    def __bool__(self) -> bool:
        return self.adjudicable


@dataclass(frozen=True)
class AdjudicatorOpinion:
    """One panel member's submitted opinion."""

    request_id: str
    agent_id: str
    verdict: str
    rationale: str
    output_hash: str


@dataclass(frozen=True)
class PanelVerdict:
    """The folded panel outcome, with everything needed to audit it."""

    escalation_request_id: str
    outcome: str
    reason: str
    opinions: tuple[AdjudicatorOpinion, ...]
    independence_ok: bool
    independence_reasons: tuple[str, ...]
    quorum_required: int
    resolve_votes: int
    refuse_votes: int
    insufficient_votes: int

    @property
    def clears_escalation(self) -> bool:
        return self.outcome == OUTCOME_RESOLVED


def _adjudications_path(root: Path) -> Path:
    return root.joinpath(*_ADJUDICATIONS_RELATIVE)


def escalation_adjudicability(record: dict[str, Any]) -> AdjudicabilityVerdict:
    """May an agent panel adjudicate this escalation?

    Fail-closed by construction: every path that cannot POSITIVELY
    establish a low-risk scope returns ``adjudicable=False``. An escalation
    with no context, an unrecognised context kind, unclassifiable changed
    files, or an L3/blocked risk lane all stay with the operator.
    """
    context = record.get("context")
    if not isinstance(context, dict) or not context:
        return AdjudicabilityVerdict(False, "no_context_to_classify")
    kind = str(context.get("kind") or "").strip()
    if not kind:
        return AdjudicabilityVerdict(False, "context_kind_absent")
    if kind in IRREDUCIBLE_CONTEXT_KINDS:
        return AdjudicabilityVerdict(False, f"irreducible_context_kind:{kind}")
    if kind not in ADJUDICABLE_CONTEXT_KINDS:
        # Unknown kinds are irreducible: a new escalation source must be
        # reviewed and explicitly admitted, never admitted by omission.
        return AdjudicabilityVerdict(False, f"context_kind_not_admitted:{kind}")
    changed_files = context.get("changed_files")
    if changed_files is not None:
        if not isinstance(changed_files, list) or not changed_files:
            return AdjudicabilityVerdict(False, "changed_files_unclassifiable")
        from .risk_policy import classify_change

        verdict = classify_change(list(changed_files))
        lane = str(getattr(verdict, "lane", "") or "")
        if not getattr(verdict, "valid", False):
            return AdjudicabilityVerdict(
                False, f"risk_policy_refused:{lane or 'invalid'}",
            )
        if lane in IRREDUCIBLE_RISK_LANES:
            return AdjudicabilityVerdict(False, f"irreducible_risk_lane:{lane}")
    return AdjudicabilityVerdict(True, f"adjudicable_context_kind:{kind}")


def open_adjudication(
    *,
    escalation_request_id: str,
    record: dict[str, Any],
    base_dir: str | Path | None = None,
    panel_size: int = DEFAULT_PANEL_SIZE,
) -> dict[str, Any]:
    """Mint one adjudication envelope per distinct panel target.

    Refuses when the escalation is in the irreducible class, and refuses
    when the role's registered target list cannot supply ``panel_size``
    distinct agents — a panel short of its own size is not a panel.
    """
    root = ensure_tools_dir(base_dir)
    adjudicability = escalation_adjudicability(record)
    if not adjudicability:
        append_tools_governance(
            root,
            "human_required_adjudication_refused",
            {
                "escalation_request_id": escalation_request_id,
                "reason": adjudicability.reason,
            },
        )
        raise GovernanceError(
            f"human_required_not_agent_adjudicable:{adjudicability.reason}"
        )
    targets = allowed_targets_for_role(ADJUDICATION_ROLE) or ()
    distinct_targets = list(dict.fromkeys(targets))
    if len(distinct_targets) < panel_size:
        raise GovernanceError(
            f"adjudication_panel_targets_insufficient:"
            f"{len(distinct_targets)}<{panel_size}"
        )
    panel = distinct_targets[:panel_size]
    request_ids: list[str] = []
    for target in panel:
        request = create_agent_invocation_request(
            target_agent=target,
            role=ADJUDICATION_ROLE,
            suggested_prompt=(
                f"Adjudicate HUMAN_REQUIRED escalation {escalation_request_id}. "
                f"Escalation reason: {record.get('reason')!r}. Decide whether the "
                f"escalation can be cleared on the evidence in the record and the "
                f"repository. Return verdict=resolve only if you can point to the "
                f"evidence that clears it; return insufficient_evidence if you "
                f"cannot establish either way — that blocks resolution, and is the "
                f"correct answer when you are unsure."
            ),
            must_satisfy=[{
                "id": f"adjudicate-{escalation_request_id}",
                "criterion": (
                    "verdict is one of resolve/refuse/insufficient_evidence and "
                    "cites the evidence it relied on"
                ),
            }],
            allowed_scope=[f"human-required/{escalation_request_id}"],
            evidence_refs=[f"human-required:{escalation_request_id}"],
            base_dir=root,
        )
        request_ids.append(str(request["request_id"]))
    row = {
        "$schema": "aria/human-required-adjudication/v1",
        "schema_version": 1,
        "escalation_request_id": escalation_request_id,
        "panel": list(panel),
        "request_ids": request_ids,
        "quorum_required": DEFAULT_QUORUM,
        "adjudicability_reason": adjudicability.reason,
        "opened_at": utc_now(),
    }
    append_declared_jsonl(
        _adjudications_path(root), row, expected_surface="human_required_adjudications",
    )
    append_tools_governance(
        root,
        "human_required_adjudication_opened",
        {
            "escalation_request_id": escalation_request_id,
            "panel": list(panel),
            "request_ids": request_ids,
        },
    )
    return row


def _load_opinion(
    *,
    request_id: str,
    base_dir: Path,
) -> AdjudicatorOpinion | None:
    """Read one adjudicator's accepted, role-bound opinion.

    Returns ``None`` when there is no accepted result, when its output
    cannot be read, or when the payload does not carry a verdict from the
    closed set. Each of those is a blocker rather than an abstention: the
    caller counts a missing opinion toward "panel incomplete".
    """
    accepted = accepted_result_for_request(
        request_id=request_id, role=ADJUDICATION_ROLE, base_dir=base_dir,
    )
    if accepted is None:
        return None
    output_path = accepted.get("output_path")
    if not isinstance(output_path, str) or not output_path:
        return None
    path = Path(output_path)
    if not path.exists():
        return None
    try:
        payload = json.loads(path.read_text(encoding="utf-8", errors="replace"))
    except (OSError, json.JSONDecodeError):
        return None
    if not isinstance(payload, dict):
        return None
    verdict = str(payload.get("verdict") or "").strip()
    if verdict not in ADJUDICATOR_VERDICTS:
        return None
    return AdjudicatorOpinion(
        request_id=request_id,
        agent_id=str(accepted.get("agent_id") or ""),
        verdict=verdict,
        rationale=str(payload.get("rationale") or ""),
        output_hash=str(accepted.get("output_hash") or ""),
    )


def fold_adjudication(
    *,
    escalation_request_id: str,
    base_dir: str | Path | None = None,
) -> PanelVerdict:
    """Fold the panel's opinions into one outcome, fail-closed throughout.

    Resolution requires ALL of: a complete panel, verified principal
    disjointness, zero ``insufficient_evidence``, and a quorum of
    ``resolve``. Anything else leaves the escalation open.
    """
    root = ensure_tools_dir(base_dir)
    rows = [
        row
        for row in load_declared_jsonl(
            _adjudications_path(root), expected_surface="human_required_adjudications",
        )
        if row.get("escalation_request_id") == escalation_request_id
    ]
    if not rows:
        return PanelVerdict(
            escalation_request_id=escalation_request_id,
            outcome=OUTCOME_STILL_ESCALATED,
            reason="no_adjudication_opened",
            opinions=(), independence_ok=False, independence_reasons=(),
            quorum_required=DEFAULT_QUORUM,
            resolve_votes=0, refuse_votes=0, insufficient_votes=0,
        )
    latest = rows[-1]
    request_ids = [str(r) for r in (latest.get("request_ids") or [])]
    quorum = int(latest.get("quorum_required") or DEFAULT_QUORUM)

    opinions: list[AdjudicatorOpinion] = []
    missing: list[str] = []
    for request_id in request_ids:
        opinion = _load_opinion(request_id=request_id, base_dir=root)
        if opinion is None:
            missing.append(
                f"{request_id}:{derive_request_state(request_id=request_id, base_dir=root)}"
            )
            continue
        opinions.append(opinion)

    resolve_votes = sum(1 for o in opinions if o.verdict == RESOLVE_VERDICT)
    refuse_votes = sum(1 for o in opinions if o.verdict == REFUSE_VERDICT)
    insufficient_votes = sum(1 for o in opinions if o.verdict == INSUFFICIENT_VERDICT)

    # Principal disjointness over the panel members that actually answered.
    independence_ok, independence_reasons = verify_principal_disjointness(
        dispatches=[
            RoundDispatch(
                role=f"adjudicator_{index}",
                request_id=opinion.request_id,
                revision_id=None,
                agent_text=None,
            )
            for index, opinion in enumerate(opinions)
        ],
        base_dir=root,
        min_dispatched=quorum,
    )

    def _verdict(outcome: str, reason: str) -> PanelVerdict:
        result = PanelVerdict(
            escalation_request_id=escalation_request_id,
            outcome=outcome,
            reason=reason,
            opinions=tuple(opinions),
            independence_ok=independence_ok,
            independence_reasons=tuple(independence_reasons),
            quorum_required=quorum,
            resolve_votes=resolve_votes,
            refuse_votes=refuse_votes,
            insufficient_votes=insufficient_votes,
        )
        append_tools_governance(
            root,
            "human_required_adjudication_folded",
            {
                "escalation_request_id": escalation_request_id,
                "outcome": outcome,
                "reason": reason,
                "resolve_votes": resolve_votes,
                "refuse_votes": refuse_votes,
                "insufficient_votes": insufficient_votes,
                "independence_ok": independence_ok,
                "independence_reasons": list(independence_reasons),
                "agent_ids": [o.agent_id for o in opinions],
            },
        )
        return result

    if missing:
        return _verdict(
            OUTCOME_STILL_ESCALATED, f"panel_incomplete:{','.join(missing)}",
        )
    if not independence_ok:
        return _verdict(
            OUTCOME_STILL_ESCALATED,
            f"panel_not_independent:{','.join(independence_reasons)}",
        )
    if insufficient_votes:
        # "I cannot tell" blocks. Treating it as an abstention would let a
        # single confident voter carry a panel that mostly did not know.
        return _verdict(
            OUTCOME_STILL_ESCALATED, f"insufficient_evidence_votes:{insufficient_votes}",
        )
    if resolve_votes >= quorum:
        return _verdict(OUTCOME_RESOLVED, f"quorum_resolve:{resolve_votes}/{quorum}")
    if refuse_votes >= quorum:
        return _verdict(OUTCOME_REFUSED, f"quorum_refuse:{refuse_votes}/{quorum}")
    return _verdict(
        OUTCOME_STILL_ESCALATED,
        f"no_quorum:resolve={resolve_votes},refuse={refuse_votes},required={quorum}",
    )


def adjudicate_human_required(
    *,
    escalation_request_id: str,
    base_dir: str | Path | None = None,
) -> PanelVerdict:
    """Fold the panel and, only on a clearing verdict, resolve the record.

    WHY CLEARING THIS IS NOT A CODE-AUTHORITY DECISION
      A lease-lifecycle escalation means "three agents claimed this request
      and released it without delivering". Clearing it decides whether to
      retry, cancel or park the REQUEST — it merges nothing. The underlying
      work still has to pass post-implementation review
      (ORPHAN-HIGH-422), the domain-specialist gate (ORPHAN-HIGH-423) and
      head-SHA-bound merge authority. That is why an L2 work scope is
      adjudicable while L3 is not: an L3-scoped item's queue decisions can
      steer the control plane, an L2 item's cannot.

      The panel is passed through with ``resolved_by="agent_panel"`` and
      NO ``verdict``, so it cannot write agent judgment into the human
      ground-truth ledger that judge calibration scores against;
      ``resolve_human_required`` refuses that combination outright.
    """
    root = ensure_tools_dir(base_dir)
    verdict = fold_adjudication(
        escalation_request_id=escalation_request_id, base_dir=root,
    )
    if not verdict.clears_escalation:
        return verdict
    from .human_required import RESOLVED_BY_AGENT_PANEL, resolve_human_required

    resolve_human_required(
        request_id=escalation_request_id,
        resolution_note=(
            f"resolved by independent agent panel "
            f"({verdict.resolve_votes}/{verdict.quorum_required} resolve, "
            f"agents={','.join(sorted(o.agent_id for o in verdict.opinions))}); "
            f"independence verified"
        ),
        resolved_by=RESOLVED_BY_AGENT_PANEL,
        base_dir=root,
    )
    return verdict


def sweep_human_required_adjudications(
    *, base_dir: str | Path | None = None,
) -> dict[str, Any]:
    """Open or fold an agent panel for every adjudicable open escalation.

    ORPHAN-HIGH-450 — the production caller this module did not have.
    ``ORPHAN-HIGH-426`` was closed with a 498-line panel and zero non-test
    importers, which is the same defect the finding described: a control
    that exists and never runs. `cycle.py` already runs the two sweeps that
    CREATE escalations; this is the one that acts on them.

    Idempotent, which is what makes it safe to run every cycle:

      * an escalation with no adjudication row gets exactly one panel;
      * an escalation that already has one is FOLDED, never re-opened —
        ``open_adjudication`` mints ``panel_size`` fresh envelopes per call
        and appends a new ledger row, so calling it unconditionally would
        spawn a panel per cycle forever;
      * a resolved escalation is not listed by ``list_human_required``, so
        it is never revisited.

    Irreducible escalations are skipped rather than refused loudly: those
    are the ones that genuinely need a human, and turning each cycle into a
    governance event for them would bury the signal. The refusal is still
    recorded once, by ``open_adjudication``, if anything tries.

    Never raises. A cycle phase that dies on one malformed escalation
    record would take the whole cycle's remaining phases with it.
    """
    root = ensure_tools_dir(base_dir)
    opened: list[str] = []
    folded: list[str] = []
    resolved: list[str] = []
    skipped: list[dict[str, str]] = []

    try:
        from .human_required import list_human_required

        escalations = list_human_required(base_dir=root)
    except Exception as exc:  # pragma: no cover — defensive, see docstring
        return {"status": "failed", "error": str(exc)[:300]}

    existing = {
        str(row.get("escalation_request_id"))
        for row in load_declared_jsonl(
            _adjudications_path(root), expected_surface="human_required_adjudications",
        )
    }

    for record in escalations:
        request_id = str(record.get("request_id") or "")
        if not request_id:
            continue
        adjudicability = escalation_adjudicability(record)
        if not adjudicability:
            skipped.append({"request_id": request_id, "reason": adjudicability.reason})
            continue
        try:
            if request_id in existing:
                verdict = adjudicate_human_required(
                    escalation_request_id=request_id, base_dir=root,
                )
                folded.append(request_id)
                if verdict.clears_escalation:
                    resolved.append(request_id)
            else:
                open_adjudication(escalation_request_id=request_id, record=record, base_dir=root)
                opened.append(request_id)
        except Exception as exc:
            skipped.append({"request_id": request_id, "reason": str(exc)[:200]})

    return {
        "status": "ok",
        "opened": opened,
        "folded": folded,
        "resolved": resolved,
        "skipped": skipped,
        "escalations_seen": len(escalations),
    }


__all__ = [
    "ADJUDICABLE_CONTEXT_KINDS",
    "ADJUDICATION_ROLE",
    "ADJUDICATOR_VERDICTS",
    "DEFAULT_PANEL_SIZE",
    "DEFAULT_QUORUM",
    "INSUFFICIENT_VERDICT",
    "IRREDUCIBLE_CONTEXT_KINDS",
    "IRREDUCIBLE_RISK_LANES",
    "OUTCOME_REFUSED",
    "OUTCOME_RESOLVED",
    "OUTCOME_STILL_ESCALATED",
    "REFUSE_VERDICT",
    "RESOLVE_VERDICT",
    "AdjudicabilityVerdict",
    "AdjudicatorOpinion",
    "PanelVerdict",
    "adjudicate_human_required",
    "escalation_adjudicability",
    "fold_adjudication",
    "open_adjudication",
    "sweep_human_required_adjudications",
]
