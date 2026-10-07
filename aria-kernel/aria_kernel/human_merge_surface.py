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
ledger's ``commit_sha`` — an updated head is not one the self-merge gates
accept, ARIA-HIGH-374) and GitHub's ``mergeStateStatus``. A PR with any
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
    list_human_required,
    record_human_required,
    refresh_open_record_context,
    resolve_human_required,
)
from .own_pr_delivery import aria_opened_prs, ci_summary
from .tool_registry import GovernanceError, ensure_tools_dir

HUMAN_MERGE_SEVERITY = "MEDIUM"
TERMINAL_STATES = frozenset({"MERGED", "CLOSED"})


def human_merge_request_id(pr_number: int) -> str:
    return f"human-merge-pr-{pr_number}"


def self_merge_refusals(opened: dict[str, Any], live: dict[str, Any], *, base_dir: str | Path | None) -> list[str]:
    """Why the merge lane cannot merge this open ARIA PR now; empty when it can."""
    from .change_ledger import _find_committed
    from .risk_policy import HUMAN_MERGE_LABEL
    from .runtime_profile import assert_merge_authorized

    reasons: list[str] = []
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
        reasons.append(f"head_is_not_the_delivered_commit:head={head[:12]}:delivered={delivered[:12]}:ARIA-HIGH-374")
    merge_state = str(live.get("mergeStateStatus") or "").upper()
    if merge_state == "DIRTY":
        reasons.append("conflicts_with_base")
    elif merge_state == "BEHIND":
        reasons.append("behind_base_under_strict_protection")
    return reasons


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


def surface_human_merge_prs(*, cycle_id: str, base_dir: str | Path | None, reader: Any) -> dict[str, Any]:
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
        request_id = human_merge_request_id(number)
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
            reasons = self_merge_refusals(opened[number], live, base_dir=root)
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
    "HUMAN_MERGE_SEVERITY",
    "daily_report_lines",
    "human_merge_request_id",
    "self_merge_refusals",
    "surface_human_merge_prs",
]
