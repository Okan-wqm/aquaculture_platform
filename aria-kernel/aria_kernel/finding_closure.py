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
present) is recorded once per reason and retried by the next cycle; a
finding whose origin has no registered detector is recorded and left open —
an unverified merge is not a fix.
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
from .tool_registry import append_tools_governance_once, ensure_tools_dir

VERDICT_ABSENT = "absent"
VERDICT_REPRODUCES = "reproduces"
VERDICT_UNVERIFIABLE = "unverifiable"
CLOSURE_ACTOR = "aria-kernel:implementation_reconciler"
RECHECK_GOVERNANCE_KIND = "finding_merge_recheck"
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


def _recorded_reproduction(base_dir: Path, *, finding_id: str, plan_id: str, merge_sha: str) -> bool:
    """A ``reproduces`` verdict for this merge is final: the revision cannot change."""
    for row in load_jsonl(ensure_tools_dir(base_dir) / "governance.jsonl"):
        details = row.get("details") if row.get("kind") == RECHECK_GOVERNANCE_KIND else None
        if isinstance(details, dict) and details.get("verdict") == VERDICT_REPRODUCES and (
            details.get("finding_id"), details.get("plan_id"), details.get("merge_sha"),
        ) == (finding_id, plan_id, merge_sha):
            return True
    return False


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
) -> dict[str, Any]:
    """Close the finding a merged plan was planned from, if its detector agrees."""
    from .plan_origin import started_origin_finding_id

    finding_id = started_origin_finding_id(state)
    out: dict[str, Any] = {"plan_id": plan_id, "finding_id": finding_id}
    if not isinstance(finding_id, str) or not FINDING_ID_RE.match(finding_id):
        return {**out, "status": "no_f_finding"}
    implementation = state.get("implementation") or {}
    merge_sha = str(implementation.get("merge_sha") or "")
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
    targets = [fid for fid in group if findings[fid].get("status") in CLOSABLE_STATUSES]
    out.update(subject_key=subject, merge_sha=merge_sha)
    if not targets:
        return {**out, "status": "already_closed"}
    origin = str(record.get("originating_skill") or "")
    detector = detectors.get(origin)
    disclosure = {"finding_id": finding_id, "plan_id": plan_id, "merge_sha": merge_sha,
                  "subject_key": subject, "originating_skill": origin}
    claim_keys = ("finding_id", "plan_id", "merge_sha", "verdict", "reason")
    if detector is None:
        append_tools_governance_once(
            base_dir, RECHECK_GOVERNANCE_KIND,
            {**disclosure, "verdict": VERDICT_UNVERIFIABLE, "reason": "detector_unregistered"},
            claim_keys=claim_keys,
        )
        return {**out, "status": "detector_unregistered"}
    if _recorded_reproduction(base_dir, finding_id=finding_id, plan_id=plan_id, merge_sha=merge_sha):
        return {**out, "status": VERDICT_REPRODUCES, "recorded": True}
    verdict = detector.recheck(record, merge_sha=merge_sha, workspace_root=repo_root)
    if verdict.get("verdict") != VERDICT_ABSENT:
        append_tools_governance_once(
            base_dir, RECHECK_GOVERNANCE_KIND,
            {**disclosure, "verdict": verdict.get("verdict"), "reason": verdict.get("reason"),
             "matches": verdict.get("matches") or []},
            claim_keys=claim_keys,
        )
        return {**out, "status": str(verdict.get("verdict")), "reason": verdict.get("reason")}
    evidence = {
        "plan_id": plan_id,
        "merge_sha": merge_sha,
        "merged_at": implementation.get("merged_at"),
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
    return {**out, "status": "closed", "closed": targets}


__all__ = [
    "CLOSABLE_STATUSES",
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
