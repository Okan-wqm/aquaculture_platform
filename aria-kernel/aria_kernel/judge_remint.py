"""Re-mint an expired judge request the way the fan-out would mint it today (ARIA-HIGH-360).

WHY this module exists. Review of PR #1825 found the first version re-minted
an expired judge request by copying its ``suggested_prompt`` and
``must_satisfy`` verbatim. A judge envelope minted before ARIA-HIGH-324 asks
whether the rule fired, carries no premise obligations, and names no product
claim; re-issuing it at HEAD went around the fan-out's rule-contract gate
(``judge_fanout.dispatch_judges_for_sample``: a rule with no declared
contract is refused as ``rule_contract_undeclared``, never asked).

So the successor is built from the same inputs the fan-out uses: the finding
as the newest raw-finding row reports it (the sampler's own resolution,
``feedback_store.resolve_raw_finding`` and ``_sample_item_from_finding``),
the rule contract resolved now (``rule_contract.resolve_rule_contract``),
and the fan-out's envelope (``judge_fanout.judge_request_fields``). Only the
identity is the dead request's: role, judge, finding id, run id and judgment
group, so the answer folds into the same consensus group, and ``remint_of``
names the dead request. The anchor-stale disposition and the adjudication
panel's ``re_mint`` (``remint_judge_for_panel``) both re-ask a judge here.
"""
from __future__ import annotations

from pathlib import Path
from typing import Any, Mapping

from .agent_invocations import create_agent_invocation_request
from .judge_subject_liveness import JudgeSubjectLiveness

RULE_CONTRACT_UNDECLARED = "rule_contract_undeclared"


def remint_judge_request(
    dead: Mapping[str, Any],
    *,
    subjects: JudgeSubjectLiveness,
    target_sha: str | None,
    workspace: Path | None,
    extra_evidence_refs: tuple[str, ...] = (),
) -> dict[str, Any] | str:
    """The successor row, or the fan-out's named refusal (``rule_contract_undeclared``)."""
    from .feedback_store import _sample_item_from_finding, finding_fingerprint
    from .judge_fanout import _evidence_refs, judge_request_fields
    from .rule_contract import resolve_rule_contract

    root = subjects.root
    tool_id = str(dead.get("tool_id") or "")
    finding = subjects.reported_finding(dead)
    fingerprint = str(dead.get("finding_fingerprint") or "") or finding_fingerprint(tool_id, finding)
    item = _sample_item_from_finding(
        tool_id, str(dead.get("run_id") or ""), dead.get("cycle_id"),
        str(dead.get("finding_id") or ""), finding, fingerprint,
    )
    contract = resolve_rule_contract(tool_id=tool_id, rule=item["rule"], base_dir=root)
    if contract is None:
        return RULE_CONTRACT_UNDECLARED
    return create_agent_invocation_request(
        target_agent=str(dead.get("target_agent") or ""),
        role=str(dead.get("role") or ""),
        **judge_request_fields(item, contract),
        evidence_refs=(_evidence_refs(item) + list(extra_evidence_refs)) or None,
        finding_id=item["finding_id"],
        finding_fingerprint=fingerprint,
        tool_id=tool_id,
        run_id=item["run_id"],
        judgment_group_id=str(dead.get("judgment_group_id") or ""),
        cycle_id=dead.get("cycle_id"),
        target_sha=target_sha,
        remint_of=str(dead.get("request_id") or ""),
        base_dir=root,
        context_repo_root=workspace,
    )


def remint_judge_for_panel(
    root: Path, dead: Mapping[str, Any], *, adjudication_ref: str | None,
) -> dict[str, Any] | str:
    """The panel's ``re_mint`` of a dead fan-out judge request, through the same gate.

    Review of PR #1825: the panel copied a judge request's prompt and
    obligations verbatim, so a pre-ARIA-HIGH-324 envelope came back at the
    panel's word, without ``forbidden_scope``, fingerprint or rule-contract
    check. The successor is anchored at the workspace HEAD, as the fan-out
    anchors a fresh judge envelope, and cites the panel's verdict.
    """
    from datetime import datetime, timezone

    from .convergence_drainer import _resolve_workspace_head_sha
    from .tool_registry import bound_workspace_root

    workspace = bound_workspace_root(root)
    return remint_judge_request(
        dead,
        subjects=JudgeSubjectLiveness(base_dir=root, now=datetime.now(timezone.utc)),
        target_sha=_resolve_workspace_head_sha(workspace),
        workspace=workspace,
        extra_evidence_refs=(adjudication_ref,) if adjudication_ref else (),
    )


__all__ = ["RULE_CONTRACT_UNDECLARED", "remint_judge_for_panel", "remint_judge_request"]
