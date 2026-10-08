"""ARIA-HIGH-373 — every ARIA PR that needs a person's merge is a HUMAN_REQUIRED item.

WHY. A PR ARIA opens outside the merge lane got the ``aria:human-merge``
label (``pr_manager._create_pull_request``, ARIA-HIGH-211) and nothing else:
no HUMAN_REQUIRED record, so no notification, no SLA clock and no line in
the daily report. F-015, the first live delivery, touches
``web/**/src/**`` and ``apps/**/src/**`` — lane L2 in
``docs/aria/policy/risk-policy.json`` — and self-merge needs the
``autonomous`` profile besides (the live profile on 2026-10-07 is
``strict``): its PR would have waited on GitHub with nobody told.

WHAT. Once per cycle, after the own-PR scan and the branch update, with the
same reader: for each open PR ARIA's own ledger says it opened, the reasons
it is not self-mergeable RIGHT NOW are computed from the opener's recorded
merge route, the merge authority's own refusal (``assert_merge_authorized``
for the route's lane), the head against the delivered commit (the change
ledger's ``commit_sha`` — an updated head counts only when
``branch_update_lineage`` verifies it, ARIA-HIGH-374) and GitHub's
``mergeStateStatus``. A PR with any
reason has exactly ONE record, ``human-merge-pr-<n>``, whose context carries
the PR URL, its CI state (``own_pr_delivery.ci_summary``) and the reasons;
the context is refreshed while the PR waits (``refresh_open_record_context``)
and the record is resolved by OBSERVATION when GitHub reports the PR merged
or closed (``RESOLVED_BY_GITHUB_OBSERVATION``). The daily report renders
each one with its URL, CI state and reasons (:func:`daily_report_lines`).
"""
from __future__ import annotations

from pathlib import Path
from typing import Any

from .human_required import (
    HUMAN_MERGE_PR_KIND,
    RESOLVED_BY_GITHUB_OBSERVATION,
    human_required_record_exists,
    list_human_required,
    record_human_required,
    refresh_open_record_context,
    resolve_human_required,
)
from .own_pr_delivery import CI_PENDING, aria_opened_prs, ci_summary
from .tool_registry import GovernanceError, ensure_tools_dir

HUMAN_MERGE_SEVERITY = "MEDIUM"
TERMINAL_STATES = frozenset({"MERGED", "CLOSED"})


def human_merge_request_id(pr_number: int, *, base_dir: str | Path | None = None) -> str:
    """The id of the PR's NEXT record: ``human-merge-pr-<n>``, then ``-2``, ``-3``…

    Review LOW — a PR closed (record resolved) and reopened needs a new
    open record; ``record_human_required`` returns an existing record as it
    is, resolved included, so a reopened PR was never surfaced again. Each
    episode is its own record; at most one is open per PR at a time.
    """
    first = f"human-merge-pr-{pr_number}"
    if base_dir is None or not human_required_record_exists(first, base_dir=base_dir):
        return first
    episode = 2
    while human_required_record_exists(f"{first}-{episode}", base_dir=base_dir):
        episode += 1
    return f"{first}-{episode}"


def _head_lineage_refusal(
    opened: dict[str, Any], live: dict[str, Any], delivered: str, *,
    base_dir: str | Path | None, workspace_root: str | Path | None,
) -> str | None:
    """ARIA-HIGH-374 — the head judged by the SAME verifier the merge gates use.

    The cycle's checkout may not hold the PR's newest commits; they are
    fetched by object id (``refs/pull/<n>/head``, no local ref written)
    before the walk. A head the verifier refuses is named with its reason.
    """
    from .branch_update_lineage import BranchUpdateLineageRefused, fetch_pr_head, verify_branch_update_lineage

    head = str(live.get("headRefOid") or "")
    if workspace_root is None:
        return f"head_is_not_the_delivered_commit:head={head[:12]}:delivered={delivered[:12]}:no_checkout"
    number = int(live.get("number") or opened.get("pr_number") or 0)
    fetch_pr_head(workspace_root, number)
    try:
        verify_branch_update_lineage(
            workspace=workspace_root, base_dir=base_dir, pr_number=number, head_sha=head,
            delivered_sha=delivered, live_base_sha=str(live.get("baseRefOid") or ""),
        )
    except BranchUpdateLineageRefused as exc:
        return f"head_is_not_the_delivered_commit:head={head[:12]}:delivered={delivered[:12]}:{exc.reason}"
    return None


def self_merge_refusals(
    opened: dict[str, Any], live: dict[str, Any], *,
    base_dir: str | Path | None, workspace_root: str | Path | None = None,
) -> list[str]:
    """Why the merge lane cannot merge this open ARIA PR now; empty when it can.

    ARIA-HIGH-374 — ``BEHIND`` is no longer a person's: the cycle and the
    merge lane request the update, and an updated head passes the gates
    when its lineage verifies. ``DIRTY`` is a conflict, and ``BLOCKED`` with
    settled checks a protection rule; both are named.
    """
    from .change_ledger import _find_committed
    from .risk_policy import HUMAN_MERGE_LABEL
    from .runtime_profile import assert_merge_authorized

    reasons: list[str] = []
    # ARIA-HIGH-389 — a PR whose plan ended after its delivery (the
    # executor's hand-over, or the orphan reaper after a run that died past
    # the push): no merge lane merges from a rejected plan, so the person
    # decides (merge or close), and the record stays theirs.
    handed_over = _handed_over_reason(opened, base_dir=base_dir)
    if handed_over is not None:
        reasons.append(handed_over)
    route = opened.get("merge_route") if isinstance(opened.get("merge_route"), dict) else {}
    lane = str(route.get("lane") or "")
    if route.get("human_merge") is True or not route:
        codes = ",".join(str(code) for code in route.get("reason_codes") or []) or "lane_not_an_auto_merge_candidate"
        reasons.append(f"merge_route_human:lane={lane or 'unrecorded'}:{codes}")
    labels = {str(label.get("name") if isinstance(label, dict) else label) for label in live.get("labels") or []}
    if HUMAN_MERGE_LABEL in labels and not reasons:
        reasons.append(f"labelled:{HUMAN_MERGE_LABEL}")
    try:
        assert_merge_authorized(lane=lane, base_dir=base_dir)
    except GovernanceError as exc:
        reasons.append(f"merge_authority:{str(exc)[:200]}")
    head = str(live.get("headRefOid") or "")
    committed = _find_committed(ensure_tools_dir(base_dir), str(opened.get("change_id") or "")) if opened.get("change_id") else None
    delivered = str((committed or {}).get("commit_sha") or "")
    if not delivered:
        reasons.append("delivered_commit_unrecorded")
    elif head != delivered:
        refusal = _head_lineage_refusal(opened, live, delivered, base_dir=base_dir, workspace_root=workspace_root)
        if refusal is not None:
            reasons.append(refusal)
    merge_state = str(live.get("mergeStateStatus") or "").upper()
    if merge_state == "DIRTY":
        reasons.append("conflicts_with_base")
    elif merge_state == "BLOCKED" and not (live.get("behindBy") or 0) > 0 \
            and ci_summary(live.get("statusCheckRollup"))["state"] != CI_PENDING:
        reasons.append("blocked_by_branch_protection")
    return reasons


HANDED_OVER_REASON_PREFIX = "implementation_settled_after_delivery"


def _handed_over_reason(opened: dict[str, Any], *, base_dir: str | Path | None) -> str | None:
    from .implementation_settlement import rejected_plan_for_change

    if base_dir is None:
        return None
    settled = rejected_plan_for_change(str(opened.get("change_id") or ""), base_dir=Path(base_dir))
    if settled is None:
        return None
    return f"{HANDED_OVER_REASON_PREFIX}:{settled.get('rejection_class')}:{settled.get('cause') or 'unrecorded'}"


def record_handed_over_pr(
    *, pr_number: int, pr_url: str, branch: str, head_sha: str, change_id: str | None, plan_id: str | None,
    request_id: str, rejection_class: str, cause: str, settlement_status: str, base_dir: str | Path | None,
) -> str:
    """ARIA-HIGH-389 — the open PR of a result refused after its delivery, handed
    to a person as the PR's one human-merge record, at once.

    Same record and shape the cycle's surface keeps for every ARIA PR that
    needs a person (``surface_human_merge_prs`` refreshes this context with
    GitHub's live CI and merge state, and resolves it by observation when the
    PR is merged or closed). The facts are the kernel's delivery's. Returns
    the record's id; an open record for the PR is returned as it is.
    """
    from .own_pr_delivery import ci_summary

    root = ensure_tools_dir(base_dir)
    for record in list_human_required(base_dir=root):
        context = record.get("context") or {}
        if context.get("kind") == HUMAN_MERGE_PR_KIND and context.get("pr_number") == pr_number \
                and record.get("status") == "open":
            return str(record["request_id"])
    record_id = human_merge_request_id(pr_number, base_dir=root)
    reason = f"{HANDED_OVER_REASON_PREFIX}:{rejection_class}:{cause}"
    record_human_required(
        request_id=record_id, severity=HUMAN_MERGE_SEVERITY, base_dir=root,
        reason=f"{pr_url or f'PR #{pr_number}'} was delivered, then its result was refused ({cause}); "
               "its plan is settled: merge or close it",
        context={
            "kind": HUMAN_MERGE_PR_KIND, "pr_number": pr_number, "pr_url": pr_url, "branch": branch,
            "head_sha": head_sha, "change_id": change_id, "merge_state": "UNKNOWN", "ci": ci_summary(None),
            "not_self_mergeable_because": [reason], "self_mergeable_now": False,
            "plan_id": plan_id, "implementation_request_id": request_id, "settlement_status": settlement_status,
        },
    )
    return record_id


def _context(number: int, opened: dict[str, Any], live: dict[str, Any], reasons: list[str]) -> dict[str, Any]:
    return {
        "kind": HUMAN_MERGE_PR_KIND,
        "pr_number": number,
        "pr_url": str(live.get("url") or ""),
        "branch": str(live.get("headRefName") or ""),
        "head_sha": str(live.get("headRefOid") or ""),
        "change_id": opened.get("change_id"),
        "merge_state": str(live.get("mergeStateStatus") or "").upper() or "UNKNOWN",
        "ci": ci_summary(live.get("statusCheckRollup")),
        "not_self_mergeable_because": reasons,
        "self_mergeable_now": not reasons,
    }


def surface_human_merge_prs(
    *, cycle_id: str, base_dir: str | Path | None, reader: Any, workspace_root: str | Path | None = None,
) -> dict[str, Any]:
    """Record, refresh and resolve the human-merge items; see module doc."""
    readable, reason = reader.readable()
    if not readable:
        return {"status": "unreadable", "reason": reason, "recorded": [], "refreshed": [], "resolved": []}
    root = ensure_tools_dir(base_dir)
    opened = aria_opened_prs(base_dir=root)
    open_records = {
        int(record["context"]["pr_number"]): record
        for record in list_human_required(base_dir=root)
        if (record.get("context") or {}).get("kind") == HUMAN_MERGE_PR_KIND
        and type((record.get("context") or {}).get("pr_number")) is int
    }
    listed = {int(row["number"]) for row in reader.list_own_prs()
              if type(row.get("number")) is int and row["number"] in opened}
    result: dict[str, Any] = {"status": "ran", "recorded": [], "refreshed": [], "resolved": [], "errors": []}
    for number in sorted(listed | set(open_records)):
        live = reader.pr_delivery_state(number)
        if live is None:
            continue
        record = open_records.get(number)
        request_id = str(record["request_id"]) if record else human_merge_request_id(number, base_dir=root)
        state = str(live.get("state") or "").upper()
        try:
            if state in TERMINAL_STATES:
                if number in open_records:
                    resolve_human_required(
                        request_id=request_id, resolved_by=RESOLVED_BY_GITHUB_OBSERVATION, base_dir=root,
                        resolution_note=f"pr_{state.lower()}_observed_on_github:{live.get('url') or number}",
                    )
                    result["resolved"].append({"pr_number": number, "state": state})
                continue
            if state != "OPEN" or number not in opened:
                continue
            reasons = self_merge_refusals(opened[number], live, base_dir=root, workspace_root=workspace_root)
            context = _context(number, opened[number], live, reasons)
            if number in open_records:
                if refresh_open_record_context(request_id=request_id, context=context, base_dir=root):
                    result["refreshed"].append(number)
            elif reasons:
                record_human_required(
                    request_id=request_id, severity=HUMAN_MERGE_SEVERITY, base_dir=root, context=context,
                    reason=f"{context['pr_url'] or f'PR #{number}'} needs a human merge",
                )
                result["recorded"].append(number)
        except GovernanceError as exc:
            result["errors"].append({"pr_number": number, "reason": str(exc)[:300]})
    return result


def daily_report_lines(items: list[dict[str, Any]]) -> list[str]:
    """The daily report's section for the open human-merge items: URL, CI, why."""
    rows = [item for item in items if (item.get("context") or {}).get("kind") == HUMAN_MERGE_PR_KIND]
    if not rows:
        return []
    lines = ["", "### ARIA PRs awaiting a human merge", ""]
    for item in rows:
        context = item["context"]
        ci = context.get("ci") or {}
        red = f" (red: {', '.join(ci.get('red') or [])})" if ci.get("red") else ""
        why = "; ".join(context.get("not_self_mergeable_because") or []) or "self-mergeable now"
        lines.append(f"- #{context.get('pr_number')} {context.get('pr_url')} — CI {ci.get('state', 'none')}{red}"
                     f" · {context.get('merge_state')} · why: {why}")
    return lines


__all__ = [
    "HANDED_OVER_REASON_PREFIX",
    "HUMAN_MERGE_SEVERITY",
    "daily_report_lines",
    "human_merge_request_id",
    "record_handed_over_pr",
    "self_merge_refusals",
    "surface_human_merge_prs",
]
