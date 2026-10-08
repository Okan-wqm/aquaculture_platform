"""ARIA-HIGH-384 — a pressure's evidence is what an agent can cite back.

THE MEASURED DEFECT. ``pipeline_stalled`` — severity critical, weight 100,
"every other pressure waits behind it" — named its evidence
``knowledge-graph/pressure-source-effectiveness.jsonl:<source_type>``: a
tools-root state ledger with a non-line suffix. The autonomy projection copied
the pressure's ``evidence`` verbatim into the planner envelope's
``evidence_refs``; the planner cited the envelope's refs, as it is told to; and
the submit law (``evidence_validator._judge_agent_ref``) grades refs against
the repository at ``target_sha``, so every answer was refused
``agent_evidence_ref_malformed`` / ``agent_evidence_path_missing`` /
``agent_evidence_not_repo_verified``. Four of four requests since 2026-10-05.
Six sibling sources wrote the same class: ``pr-<n>:<sha>`` (own_pr_ci,
post_merge_ci, repo_pr_health), ``aria-tools/memory/...`` (contradiction,
uncertainty_repeat) and an absolute store path (discovery_incomplete).

THE RULE, ONE OWNER PER HALF.

* A pressure's ``evidence`` holds only refs whose SHAPE the agent law admits
  (``evidence_validator.agent_ref_shape_refusal``); where the pressure came
  from — a state ledger, a PR, a store file — is ``provenance_refs``, the
  channel ``plan_synthesizer`` already uses for the same split
  (ORPHAN-HIGH-519: "where a plan came from is provenance, never evidence").
  ``pressure._pressure`` refuses a non-citable evidence ref by name, so a
  producer cannot build the defect.
* The autonomy projection hands the planner only the refs the FULL law admits
  at the envelope's ``target_sha`` (``admissible_agent_evidence_refs``, the
  function the submit path and plan synthesis already ask). The pressure's
  reason and provenance travel as prompt data, which the agent reads and never
  cites.
"""
from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable

from .tool_registry import GovernanceError

# The prompt keys the projection writes; named once so the projection, the
# planner's contract and the tests read the same words.
PROMPT_PRESSURE_REASON_KEY = "pressure_reason"
PROMPT_PROVENANCE_REFS_KEY = "provenance_refs"
PROMPT_REFUSED_EVIDENCE_KEY = "refused_evidence_refs"


def split_citable_refs(refs: Iterable[Any]) -> tuple[list[str], list[str]]:
    """``(evidence, provenance)`` for refs a pressure read from a record it does not author.

    A belief's refs, a tool run's read paths, a runtime signal's code refs are
    data: a ref the agent law cannot accept the shape of is still the lead the
    record named, so it is kept, on the channel no agent cites. Order and
    duplicates are preserved per channel.
    """
    from .evidence_validator import agent_ref_shape_refusal

    evidence: list[str] = []
    provenance: list[str] = []
    for ref in refs:
        if not isinstance(ref, str) or not ref.strip():
            continue
        (provenance if agent_ref_shape_refusal(ref) else evidence).append(ref)
    return evidence, provenance


def require_citable_evidence(source: str, evidence: Iterable[Any]) -> list[str]:
    """``evidence`` unchanged when every ref passes the agent law's shape; otherwise a named refusal.

    Called by ``pressure._pressure`` for every source, so a producer that puts
    a ledger, PR or store ref into ``evidence`` fails at construction (and in
    its tests), not at a paid agent run three hops downstream.
    """
    from .evidence_validator import agent_ref_shape_refusal

    refs = list(evidence)
    refused = [(ref, code) for ref in refs if (code := agent_ref_shape_refusal(ref)) is not None]
    if refused:
        raise GovernanceError(
            f"pressure_evidence_not_agent_citable: source {source!r} names {refused[:3]} as "
            "evidence; a ref no agent can cite back belongs in provenance_refs"
        )
    return [str(ref) for ref in refs]


@dataclass(frozen=True)
class EvidenceProjection:
    """What one kernel record contributes to an agent envelope.

    ``evidence_refs`` are admitted by the agent law at the envelope's
    ``target_sha``; ``refused_evidence`` names each candidate ref the law
    refused, with its codes; ``harness_fault`` is true when nothing was
    admitted and every refusal says the host could not verify (the item is
    asked again, never spent).
    """

    evidence_refs: tuple[str, ...]
    refused_evidence: tuple[dict[str, Any], ...]
    provenance_refs: tuple[str, ...]
    reason: str | None
    harness_fault: bool

    def prompt_fields(self) -> dict[str, Any]:
        """The prompt data the record carries beside the envelope's evidence."""
        return {
            PROMPT_PRESSURE_REASON_KEY: self.reason,
            PROMPT_PROVENANCE_REFS_KEY: list(self.provenance_refs),
            PROMPT_REFUSED_EVIDENCE_KEY: [dict(entry) for entry in self.refused_evidence],
        }


def project_refs_for_agent(
    candidates: Iterable[Any],
    *,
    workspace_root: str | Path,
    target_sha: str | None,
    provenance_refs: Iterable[Any] = (),
    reason: Any = None,
) -> EvidenceProjection:
    """Judge a record's candidate evidence by the agent law, and carry the rest as data.

    The law is ``evidence_validator.admissible_agent_evidence_refs`` — the
    function the submit path and plan synthesis ask; there is no mint-side
    copy of it. A record written before ARIA-HIGH-384 (a stored pressure
    payload, a mission row holding ``pr:<n>`` / ``branch:<name>``) is judged
    the same way, so a stored ref can no more reach an envelope's evidence
    channel than a new one.
    """
    from .evidence_validator import admissible_agent_evidence_refs

    raw = [ref for ref in candidates if isinstance(ref, str) and ref]
    verdict = admissible_agent_evidence_refs(raw, workspace_root=workspace_root, target_sha=target_sha)
    return EvidenceProjection(
        evidence_refs=verdict.admitted,
        refused_evidence=verdict.refused,
        provenance_refs=tuple(ref for ref in provenance_refs if isinstance(ref, str) and ref),
        reason=reason if isinstance(reason, str) and reason else None,
        harness_fault=verdict.harness_fault,
    )


def project_pressure_for_agent(
    pressure: dict[str, Any], *, workspace_root: str | Path, target_sha: str | None,
) -> EvidenceProjection:
    """A stored pressure's envelope evidence (its ``evidence``, judged) and prompt data (reason, provenance)."""
    return project_refs_for_agent(
        pressure.get("evidence") or [],
        workspace_root=workspace_root,
        target_sha=target_sha,
        provenance_refs=pressure.get("provenance_refs") or [],
        reason=pressure.get("reason"),
    )


__all__ = [
    "PROMPT_PRESSURE_REASON_KEY",
    "PROMPT_PROVENANCE_REFS_KEY",
    "PROMPT_REFUSED_EVIDENCE_KEY",
    "EvidenceProjection",
    "project_pressure_for_agent",
    "project_refs_for_agent",
    "require_citable_evidence",
    "split_citable_refs",
]
