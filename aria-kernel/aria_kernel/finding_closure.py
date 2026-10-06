"""ARIA-HIGH-363 — a merged implementation closes the finding it was planned from.

WHY. The plan state machine ends at IMPLEMENTATION_MERGED
(``implementation_reconciler``), and nothing on that path touched the
finding the plan was minted from. The only automatic producer of a RESOLVED
ARIA finding was ``finding_fix_verified``, reachable from the CLI alone and
only for a finding with a recorded reproduction — which no seeded drift
finding has. So a merged fix left its finding OPEN, every duplicate of it
OPEN, and the aging-F plan source free to plan the fixed defect again: the
SELF_LOOP_OWN_CHANGE guard (``finding_grounding``) refuses only findings
CREATED after the merge, and the duplicates were all created before it.

WHAT. For every plan resting in IMPLEMENTATION_MERGED whose origin is an F
finding, :func:`close_merged_plan_finding` asks the finding's OWN detector
(the registry below is keyed by ``originating_skill``) whether the defect
still reproduces at the merge commit. ``absent`` closes the finding through
the kernel's status transitions (OPEN -> IN_PROGRESS -> RESOLVED, the only
path ``finding.STATUS_TRANSITIONS`` admits) with the merge commit as
``closes_in_commit`` and the detector's verdict as evidence, and closes
every other open finding with the same subject key
(``finding_subject``) citing the same evidence. ``reproduces`` is recorded
once and the findings stay open. ``unverifiable`` (no wire, revision not
present, a scan document the judge does not read) is retried by later cycles,
at most ``MAX_UNVERIFIABLE_RECHECKS`` times per reason, then recorded as
``closure_unverifiable_exhausted`` with the findings left open; a finding
whose origin has no registered detector is recorded and left open — an
unverified merge is not a fix.

Review B1 (2026-10-06): the pass is ONCE per merge, and it reaches only
findings that existed at the merge. Without both, a plan merged long ago was
re-run every cycle against every open finding of its subject, so a regression
the seeder minted after the merge (the subject came back) was closed with the
old merge's evidence the same night — RESOLVED is terminal, so the
regression could never be planned. A final outcome writes
``finding_merge_closure_completed`` and the reconciler skips the plan from
then on; :func:`existed_before_merge` keeps any finding minted at a commit
that already contains the merge out of the group.
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path
from typing import Any, Mapping, Protocol

from .finding import (
    FINDING_ID_RE,
    fold_findings,
    record_finding_status_change,
)
from .finding_subject import DRIFT_ORIGIN, drift_class_of, finding_subject_key
from .ledger import load_jsonl
from .tool_registry import append_tools_governance, ensure_tools_dir, parse_utc_stamp

VERDICT_ABSENT = "absent"
VERDICT_REPRODUCES = "reproduces"
VERDICT_UNVERIFIABLE = "unverifiable"
CLOSURE_ACTOR = "aria-kernel:implementation_reconciler"
RECHECK_GOVERNANCE_KIND = "finding_merge_recheck"
COMPLETION_GOVERNANCE_KIND = "finding_merge_closure_completed"
UNVERIFIABLE_EXHAUSTED_KIND = "closure_unverifiable_exhausted"
# A merge whose detector could not judge it five times for the same reason
# (no wire, revision missing, scanner shape) will not be judged by the sixth;
# the finding stays open and the operator sees why.
MAX_UNVERIFIABLE_RECHECKS = 5
# The finding states a merged fix moves to RESOLVED. SUPPRESSED is an
# operator decision about the finding and is left to the operator.
CLOSABLE_STATUSES = frozenset({"OPEN", "IN_PROGRESS"})
# The drift scan runs once per merged plan per cycle at most; 15 min bounds a
# wedged scanner without cutting the measured 17 s scan (2026-10-06, this
# repository) or a cold worktree checkout short.
DRIFT_RECHECK_TIMEOUT_SECONDS = 900


class FindingDetector(Protocol):
    def recheck(self, record: Mapping[str, Any], *, merge_sha: str, workspace_root: Path) -> dict[str, Any]:
        """``{"verdict": absent|reproduces|unverifiable, "reason": str, ...}`` at ``merge_sha``."""
        ...


class DriftSubjectDetector:
    """The seeder's own drift scan, at the merge commit, judged for one subject.

    Runs ``tools/aria-poc/seed_drift_findings.py --recheck-subject`` from the
    checkout the cycle runs in — the same scanner, selection and mintability
    rule that minted the finding — so the closure can never disagree with the
    seeder about what the drift is. ``ARIA_SUPERGRAPH`` is the supergraph the
    lane fetched for the drift scan; the script decides whether it is exact
    for the merge commit.
    """

    def recheck(self, record: Mapping[str, Any], *, merge_sha: str, workspace_root: Path) -> dict[str, Any]:
        subject = finding_subject_key(record)
        drift_class = drift_class_of(record)
        if subject is None or drift_class is None:
            return {"verdict": VERDICT_UNVERIFIABLE, "reason": "subject_key_underivable"}
        script = Path(workspace_root) / "tools" / "aria-poc" / "seed_drift_findings.py"
        if not script.is_file():
            return {"verdict": VERDICT_UNVERIFIABLE, "reason": "detector_script_missing"}
        command = [
            sys.executable, str(script), "--repo-root", str(workspace_root),
            "--recheck-subject", subject, "--drift-class", drift_class, "--at", merge_sha,
        ]
        supergraph = os.environ.get("ARIA_SUPERGRAPH")
        if supergraph:
            command += ["--supergraph", supergraph]
        try:
            completed = subprocess.run(
                command, cwd=str(workspace_root), capture_output=True, text=True,
                timeout=DRIFT_RECHECK_TIMEOUT_SECONDS,
            )
        except subprocess.TimeoutExpired:
            return {"verdict": VERDICT_UNVERIFIABLE, "reason": "detector_timeout"}
        lines = [line for line in completed.stdout.splitlines() if line.strip()]
        if completed.returncode != 0 or not lines:
            return {"verdict": VERDICT_UNVERIFIABLE, "reason": f"detector_exit_{completed.returncode}"}
        try:
            verdict = json.loads(lines[-1])
        except json.JSONDecodeError:
            return {"verdict": VERDICT_UNVERIFIABLE, "reason": "detector_output_unreadable"}
        if verdict.get("verdict") not in {VERDICT_ABSENT, VERDICT_REPRODUCES, VERDICT_UNVERIFIABLE}:
            return {"verdict": VERDICT_UNVERIFIABLE, "reason": "detector_verdict_unknown"}
        return verdict


def default_detectors() -> dict[str, FindingDetector]:
    """The finding origins whose detector can re-run at a merge commit."""
    return {DRIFT_ORIGIN: DriftSubjectDetector()}


def _rows(history: list[dict[str, Any]], kind: str, plan_id: str, merge_sha: str) -> list[dict[str, Any]]:
    return [
        row["details"] for row in history
        if row.get("kind") == kind and isinstance(row.get("details"), dict)
        and (row["details"].get("plan_id"), row["details"].get("merge_sha")) == (plan_id, merge_sha)
    ]


def closure_completed(history: list[dict[str, Any]], *, plan_id: str, merge_sha: str) -> bool:
    """True when this merge's closure pass reached a final outcome (review B1(b))."""
    return bool(_rows(history, COMPLETION_GOVERNANCE_KIND, plan_id, merge_sha))


def _git_contains(repo_root: Path, *, ancestor: str, descendant: str) -> bool | None:
    """Is ``ancestor`` reachable from ``descendant``? None when git cannot say (unknown object)."""
    completed = subprocess.run(
        ["git", "-C", str(repo_root), "merge-base", "--is-ancestor", ancestor, descendant],
        capture_output=True, text=True,
    )
    return {0: True, 1: False}.get(completed.returncode)


def existed_before_merge(
    record: Mapping[str, Any], *, merge_sha: str, merged_at: Any, repo_root: Path,
) -> bool:
    """Was this finding minted against a tree WITHOUT the merge? (review B1(a))

    A merge can only have fixed what existed when it landed. A finding minted
    at a commit that already contains the merge is a regression the merge did
    not fix — closing it with the merge's evidence is a false RESOLVED, and
    the subject would never be planned again. The mint commit
    (``minted_at_sha``, from the mint event) decides; when git cannot place
    one of the two commits, the mint stamp against the merge stamp does; when
    neither is readable the finding is not closed.
    """
    minted_at_sha = record.get("minted_at_sha")
    if isinstance(minted_at_sha, str) and minted_at_sha and merge_sha:
        contains = _git_contains(repo_root, ancestor=merge_sha, descendant=minted_at_sha)
        if contains is not None:
            return not contains
    created = parse_utc_stamp(record.get("created_at")) if isinstance(record.get("created_at"), str) else None
    merged = parse_utc_stamp(merged_at) if isinstance(merged_at, str) else None
    return created is not None and merged is not None and created <= merged


def _resolve(repo_root: Path, finding_id: str, *, status: str, reason: str, merge_sha: str,
             evidence: dict[str, Any], base_dir: Path) -> None:
    """OPEN -> IN_PROGRESS -> RESOLVED; a retry after a crash resumes at IN_PROGRESS."""
    if status == "OPEN":
        record_finding_status_change(
            repo_root, finding_id=finding_id, to_status="IN_PROGRESS",
            reason=reason, actor=CLOSURE_ACTOR, base_dir=base_dir,
        )
    record_finding_status_change(
        repo_root, finding_id=finding_id, to_status="RESOLVED", reason=reason,
        actor=CLOSURE_ACTOR, closes_in_commit=merge_sha, evidence=evidence, base_dir=base_dir,
    )


def close_merged_plan_finding(
    *,
    plan_id: str,
    state: Mapping[str, Any],
    repo_root: Path,
    base_dir: Path,
    detectors: Mapping[str, FindingDetector],
    history: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    """Close the finding a merged plan was planned from, if its detector agrees.

    One pass per merge (review B1(b)): a final outcome — closed, reproduces,
    no detector, nothing left that predates the merge, or ``unverifiable``
    ``MAX_UNVERIFIABLE_RECHECKS`` times for one reason (review M6) — writes
    ``finding_merge_closure_completed`` and the plan is skipped from then
    on. ``history`` is the governance rows the caller read once for all
    merged plans.
    """
    from .plan_origin import started_origin_finding_id

    finding_id = started_origin_finding_id(state)
    out: dict[str, Any] = {"plan_id": plan_id, "finding_id": finding_id}
    if not isinstance(finding_id, str) or not FINDING_ID_RE.match(finding_id):
        return {**out, "status": "no_f_finding"}
    implementation = state.get("implementation") or {}
    merge_sha = str(implementation.get("merge_sha") or "")
    merged_at = implementation.get("merged_at")
    rows = history if history is not None else load_jsonl(ensure_tools_dir(base_dir) / "governance.jsonl")
    out["merge_sha"] = merge_sha
    if closure_completed(rows, plan_id=plan_id, merge_sha=merge_sha):
        return {**out, "status": "completed_earlier"}
    findings = fold_findings(repo_root)
    if findings is None:
        return {**out, "status": "finding_store_unavailable"}
    record = findings.get(finding_id)
    if record is None:
        return {**out, "status": "finding_unknown"}
    subject = finding_subject_key(record)
    group = [finding_id] + sorted(
        other for other, candidate in findings.items()
        if subject is not None and other != finding_id and finding_subject_key(candidate) == subject
    )
    targets = [
        fid for fid in group
        if findings[fid].get("status") in CLOSABLE_STATUSES
        and existed_before_merge(findings[fid], merge_sha=merge_sha, merged_at=merged_at, repo_root=repo_root)
    ]
    out["subject_key"] = subject
    origin = str(record.get("originating_skill") or "")
    disclosure = {"finding_id": finding_id, "plan_id": plan_id, "merge_sha": merge_sha,
                  "subject_key": subject, "originating_skill": origin}

    def complete(outcome: str, **extra: Any) -> dict[str, Any]:
        append_tools_governance(base_dir, COMPLETION_GOVERNANCE_KIND, {**disclosure, "outcome": outcome})
        return {**out, "status": outcome, **extra}

    if not targets:
        return complete("already_closed")
    detector = detectors.get(origin)
    if detector is None:
        append_tools_governance(
            base_dir, RECHECK_GOVERNANCE_KIND,
            {**disclosure, "verdict": VERDICT_UNVERIFIABLE, "reason": "detector_unregistered"},
        )
        return complete("detector_unregistered")
    verdict = detector.recheck(record, merge_sha=merge_sha, workspace_root=repo_root)
    if verdict.get("verdict") == VERDICT_REPRODUCES:
        append_tools_governance(
            base_dir, RECHECK_GOVERNANCE_KIND,
            {**disclosure, "verdict": VERDICT_REPRODUCES, "reason": verdict.get("reason"),
             "matches": verdict.get("matches") or []},
        )
        return complete(VERDICT_REPRODUCES)
    if verdict.get("verdict") != VERDICT_ABSENT:
        reason = str(verdict.get("reason") or "unknown")
        tried = sum(
            1 for row in _rows(rows, RECHECK_GOVERNANCE_KIND, plan_id, merge_sha)
            if row.get("verdict") == VERDICT_UNVERIFIABLE and row.get("reason") == reason
        ) + 1
        append_tools_governance(
            base_dir, RECHECK_GOVERNANCE_KIND,
            {**disclosure, "verdict": VERDICT_UNVERIFIABLE, "reason": reason, "try": tried},
        )
        if tried < MAX_UNVERIFIABLE_RECHECKS:
            return {**out, "status": VERDICT_UNVERIFIABLE, "reason": reason, "try": tried}
        append_tools_governance(
            base_dir, UNVERIFIABLE_EXHAUSTED_KIND,
            {**disclosure, "reason": reason, "tries": tried, "left_open": targets},
        )
        return complete(UNVERIFIABLE_EXHAUSTED_KIND, reason=reason)
    evidence = {
        "plan_id": plan_id,
        "merge_sha": merge_sha,
        "merged_at": merged_at,
        "pr_url": implementation.get("pr_url"),
        "detector": origin,
        "subject_key": subject,
        "recheck": {key: verdict.get(key) for key in ("verdict", "reason", "wire", "at")},
        "primary_finding_id": finding_id,
    }
    reason = (
        f"implementation of plan {plan_id} merged at {merge_sha}; the {origin} detector "
        f"does not reproduce subject {subject or finding_id} at that commit"
    )
    for fid in targets:
        _resolve(repo_root, fid, status=str(findings[fid].get("status")), reason=reason,
                 merge_sha=merge_sha, evidence=evidence, base_dir=base_dir)
    return complete("closed", closed=targets)


__all__ = [
    "CLOSABLE_STATUSES",
    "COMPLETION_GOVERNANCE_KIND",
    "MAX_UNVERIFIABLE_RECHECKS",
    "UNVERIFIABLE_EXHAUSTED_KIND",
    "closure_completed",
    "existed_before_merge",
    "CLOSURE_ACTOR",
    "DriftSubjectDetector",
    "FindingDetector",
    "RECHECK_GOVERNANCE_KIND",
    "VERDICT_ABSENT",
    "VERDICT_REPRODUCES",
    "VERDICT_UNVERIFIABLE",
    "close_merged_plan_finding",
    "default_detectors",
]
