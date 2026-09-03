"""Plan 032 Faz 032d — delivery closure: what an implementation request actually delivered.

WHY: the funnel's last mile has no reader. A request can be CLAIMED, its
result ACCEPTED, and nothing ever reaches GitHub — the acceptance row is
green while the branch was never pushed, or was pushed twice, or the PR
opened and went red. Hermes-style harnesses stop at "the agent said done".
ARIA's answer is a report derived ONLY from ledgers that recorded the
effects: intents/receipts (recovery), PR lifecycle, own-PR CI checks and
merge outcomes, all read from the store, none written here.

WHAT: :func:`compute_delivery_closure` folds every ``implementation``
request into one :class:`DeliveryRecord` with a closed ``DELIVERY_STATES``
vocabulary and a summary that carries the Faz 032d SLO verbatim:
verified PRs ≥ 3, false-success 0, duplicate PRs 0. ``doctor`` reads it;
``aria-kernel delivery status`` prints it. Nothing here can make the SLO
pass except real rows written by real effects.
"""
from __future__ import annotations

import re
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any

from .ledger import load_declared_jsonl
from .recovery import (
    EXTERNAL_EFFECTS_RELPATH,
    EXTERNAL_EFFECTS_SURFACE,
    RECOVERY_DECISIONS_RELPATH,
    RECOVERY_DECISIONS_SURFACE,
)
from .tool_registry import ensure_tools_dir_readonly

IMPLEMENTATION_ROLE = "implementation"
# Closed vocabulary — ordered from "nothing happened" to "delivered"; the
# fold picks the FIRST matching state from the top of `_derive_state`.
DELIVERY_STATES: tuple[str, ...] = (
    "dispatched",         # request exists, never claimed
    "claimed",            # a claim is live (or the last claim was not released)
    "released",           # every claim released; no accepted result
    "result_accepted",    # kernel accepted the envelope; no external effect yet
    "push_pending",       # git_push intent without receipt
    "pushed",             # branch reached the remote; no PR intent yet
    "pr_pending",         # pr_create intent without receipt
    "pr_opened",          # PR receipt; no CI observation yet
    "ci_pending",         # own_pr_ci saw the PR, checks still running
    "ci_red",             # own_pr_ci saw red jobs
    "ci_green",           # own_pr_ci cleared — the VERIFIED state
    "merged",             # merge_outcomes has a merge_sha
    "duplicate",          # more than one PR for one request
    "human_required",     # recovery handed the request to a person
)
DELIVERED_STATES: tuple[str, ...] = ("ci_green", "merged")
SLO_VERIFIED_PRS_MIN = 3

_REQUESTS = ("agent-invocations", "requests.jsonl", "agent_invocation_requests")
_CLAIMS = ("agent-invocations", "claims.jsonl", "agent_invocation_claims")
_RESULTS = ("agent-invocations", "results.jsonl", "agent_invocation_results")
_PR_LIFECYCLE = ("pr-lifecycle.jsonl", "pr_lifecycle")
_OWN_PR_CHECKS = ("ci", "own-pr-checks.jsonl", "own_pr_checks")
_MERGE_OUTCOMES = ("ci", "merge-outcomes.jsonl", "merge_outcomes")
_PR_URL_RE = re.compile(r"/pull/(\d+)")


@dataclass
class DeliveryRecord:
    request_id: str
    cycle_id: str | None
    target_agent: str
    created_at: str
    state: str = "dispatched"
    claims: int = 0
    releases: int = 0
    last_release_reason: str | None = None
    result_accepted: bool = False
    push_intents: int = 0
    push_receipts: int = 0
    pr_intents: int = 0
    pr_receipts: int = 0
    pr_numbers: list[int] = field(default_factory=list)
    proposal_ids: list[str] = field(default_factory=list)
    ci_status: str | None = None
    red_jobs: list[str] = field(default_factory=list)
    merge_status: str | None = None
    recovery_decision: str | None = None
    unresolved_intents: int = 0
    delivered: bool = False

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass(frozen=True)
class DeliveryClosureReport:
    records: tuple[DeliveryRecord, ...]
    summary: dict[str, Any]

    def to_dict(self) -> dict[str, Any]:
        return {"schema_version": 1, "summary": self.summary, "records": [r.to_dict() for r in self.records]}


def _rows(root: Path, *parts: str) -> list[dict[str, Any]]:
    *rel, surface = parts
    path = root.joinpath(*rel)
    if not path.exists():
        return []
    return load_declared_jsonl(path, expected_surface=surface)


def _pr_number_of(observed: Any) -> int | None:
    if not isinstance(observed, dict):
        return None
    for key in ("pr_number", "number"):
        value = observed.get(key)
        if isinstance(value, int) and value > 0:
            return value
        if isinstance(value, str) and value.isdigit():
            return int(value)
    match = _PR_URL_RE.search(str(observed.get("url") or ""))
    return int(match.group(1)) if match else None


def _derive_state(rec: DeliveryRecord) -> str:
    if len(set(rec.pr_numbers)) > 1:
        return "duplicate"
    if rec.recovery_decision == "human_required":
        return "human_required"
    if rec.pr_numbers:
        if rec.merge_status is not None:
            return "merged"
        if rec.ci_status == "cleared":
            return "ci_green"
        if rec.ci_status == "open":
            return "ci_red"
        if rec.ci_status is not None:
            return "ci_pending"
        return "pr_opened"
    if rec.pr_intents > rec.pr_receipts:
        return "pr_pending"
    if rec.push_receipts:
        return "pushed"
    if rec.push_intents > rec.push_receipts:
        return "push_pending"
    if rec.result_accepted:
        return "result_accepted"
    if rec.claims and rec.releases >= rec.claims:
        return "released"
    if rec.claims:
        return "claimed"
    return "dispatched"


def compute_delivery_closure(*, base_dir: str | Path | None = None) -> DeliveryClosureReport:
    """Fold the delivery ledgers into per-request records + the SLO summary."""
    root = ensure_tools_dir_readonly(base_dir)
    if root is None:
        raise ValueError("tools_root_unbound")
    records: dict[str, DeliveryRecord] = {}
    for row in _rows(root, *_REQUESTS):
        if str(row.get("role") or "") != IMPLEMENTATION_ROLE:
            continue
        rid = str(row.get("request_id") or "")
        if not rid:
            continue
        records[rid] = DeliveryRecord(
            request_id=rid, cycle_id=row.get("cycle_id"),
            target_agent=str(row.get("target_agent") or ""), created_at=str(row.get("created_at") or ""),
        )
    if not records:
        return DeliveryClosureReport(records=(), summary=_summary(()))

    for row in _rows(root, *_CLAIMS):
        rec = records.get(str(row.get("request_id") or ""))
        if rec is None:
            continue
        event = str(row.get("event") or "")
        if event == "claimed":
            rec.claims += 1
        elif event in {"released", "stale", "anchor_stale"}:
            rec.releases += 1
            rec.last_release_reason = str(row.get("reason") or event)
    for row in _rows(root, *_RESULTS):
        rec = records.get(str(row.get("request_id") or ""))
        if rec is not None and str(row.get("status") or "") == "accepted":
            rec.result_accepted = True

    intents_by_request: dict[str, dict[str, dict[str, Any]]] = {}
    for row in _rows(root, *EXTERNAL_EFFECTS_RELPATH, EXTERNAL_EFFECTS_SURFACE):
        rec = records.get(str(row.get("request_id") or ""))
        if rec is None:
            continue
        op = str(row.get("operation_id") or "")
        if row.get("event") == "intent":
            intents_by_request.setdefault(rec.request_id, {})[op] = row
            kind = str(row.get("effect_kind") or "")
            if kind == "git_push":
                rec.push_intents += 1
            elif kind == "pr_create":
                rec.pr_intents += 1
            proposal = (row.get("intended_postcondition") or {}).get("proposal_id")
            if proposal and str(proposal) not in rec.proposal_ids:
                rec.proposal_ids.append(str(proposal))
        elif row.get("event") == "receipt":
            intent = intents_by_request.get(rec.request_id, {}).get(op)
            kind = str((intent or {}).get("effect_kind") or op.split(":", 1)[0])
            confirmed = str(row.get("status") or "confirmed") != "failed"
            if kind == "git_push" and confirmed:
                rec.push_receipts += 1
            elif kind == "pr_create" and confirmed:
                rec.pr_receipts += 1
                number = _pr_number_of(row.get("observed_receipt"))
                if number is not None and number not in rec.pr_numbers:
                    rec.pr_numbers.append(number)
            if intent is not None:
                intent["_receipted"] = True
    for rid, intents in intents_by_request.items():
        records[rid].unresolved_intents = sum(1 for i in intents.values() if not i.get("_receipted"))

    # Secondary PR link: lifecycle rows carry proposal_id, never request_id.
    by_proposal: dict[str, list[str]] = {}
    for rec in records.values():
        for proposal in rec.proposal_ids:
            by_proposal.setdefault(proposal, []).append(rec.request_id)
    for row in _rows(root, *_PR_LIFECYCLE):
        if str(row.get("event") or "") != "opened":
            continue
        number = row.get("pr_number")
        proposal = str(row.get("proposal_id") or "")
        if not isinstance(number, int) or proposal not in by_proposal:
            continue
        for rid in by_proposal[proposal]:
            if number not in records[rid].pr_numbers:
                records[rid].pr_numbers.append(number)

    latest_check: dict[int, dict[str, Any]] = {}
    for row in _rows(root, *_OWN_PR_CHECKS):
        number = row.get("pr_number")
        if isinstance(number, int):
            latest_check[number] = row
    latest_merge: dict[int, dict[str, Any]] = {}
    for row in _rows(root, *_MERGE_OUTCOMES):
        number = row.get("pr_number")
        if isinstance(number, int):
            latest_merge[number] = row
    latest_decision: dict[str, str] = {}
    for row in _rows(root, *RECOVERY_DECISIONS_RELPATH, RECOVERY_DECISIONS_SURFACE):
        latest_decision[str(row.get("request_id") or "")] = str(row.get("decision") or "")

    for rec in records.values():
        if rec.pr_numbers:
            number = rec.pr_numbers[-1]
            check = latest_check.get(number)
            if check is not None:
                rec.ci_status = str(check.get("status") or "")
                rec.red_jobs = [str(j) for j in (check.get("red_jobs") or [])]
            merge = latest_merge.get(number)
            if merge is not None and merge.get("merge_sha"):
                rec.merge_status = str(merge.get("status") or "")
        rec.recovery_decision = latest_decision.get(rec.request_id)
        rec.state = _derive_state(rec)
        rec.delivered = rec.state in DELIVERED_STATES

    ordered = tuple(sorted(records.values(), key=lambda r: (r.created_at, r.request_id)))
    return DeliveryClosureReport(records=ordered, summary=_summary(ordered))


def _summary(records: tuple[DeliveryRecord, ...]) -> dict[str, Any]:
    by_state = {state: sum(1 for r in records if r.state == state) for state in DELIVERY_STATES}
    verified = sum(1 for r in records if r.delivered)
    # False success: the kernel accepted an implementation result and no PR
    # exists for it — the acceptance was the last thing that happened.
    false_success = sum(1 for r in records if r.result_accepted and not r.pr_numbers and r.state != "human_required")
    duplicates = by_state["duplicate"]
    gaps: list[str] = []
    if verified < SLO_VERIFIED_PRS_MIN:
        gaps.append(f"verified_prs<{SLO_VERIFIED_PRS_MIN}")
    if false_success:
        gaps.append("false_success>0")
    if duplicates:
        gaps.append("duplicate_prs>0")
    return {
        "implementation_requests": len(records),
        "by_state": by_state,
        "verified_prs": verified,
        "prs_opened": sum(1 for r in records if r.pr_numbers),
        "red_prs": by_state["ci_red"],
        "false_success": false_success,
        "duplicate_prs": duplicates,
        "unresolved_intents": sum(r.unresolved_intents for r in records),
        "human_required": by_state["human_required"],
        "slo": {"verified_prs_min": SLO_VERIFIED_PRS_MIN, "met": not gaps, "gaps": gaps},
    }


def render_delivery_text(report: DeliveryClosureReport) -> str:
    s = report.summary
    lines = [
        f"implementation requests: {s['implementation_requests']}  verified PRs: {s['verified_prs']}  "
        f"opened: {s['prs_opened']}  red: {s['red_prs']}  false-success: {s['false_success']}  "
        f"duplicates: {s['duplicate_prs']}  human-required: {s['human_required']}",
        f"SLO met: {str(s['slo']['met']).lower()}" + (f"  gaps: {', '.join(s['slo']['gaps'])}" if s["slo"]["gaps"] else ""),
    ]
    for rec in report.records:
        prs = ",".join(f"#{n}" for n in rec.pr_numbers) or "-"
        lines.append(f"{rec.request_id}  {rec.state:<16} prs={prs} ci={rec.ci_status or '-'} claims={rec.claims}/{rec.releases}")
    return "\n".join(lines)


__all__ = [
    "DELIVERED_STATES",
    "DELIVERY_STATES",
    "DeliveryClosureReport",
    "DeliveryRecord",
    "IMPLEMENTATION_ROLE",
    "SLO_VERIFIED_PRS_MIN",
    "compute_delivery_closure",
    "render_delivery_text",
]
