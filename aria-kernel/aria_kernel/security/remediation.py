"""Plan 033 Faz 033h — autonomous remediation flow (confirmed → hardened → ready).

WHY: finding a hole is half the job; ARIA must drive the fix to a proven, permanently
guarded close. The flow is a closed, ordered machine: a CONFIRMED finding opens a
security_hardening mission, a fix is proposed, the SAME sealed recipe must re-run
dual-GREEN at the NEW head SHA (proof of fix), a permanent regression must be locked,
and only a READY SecurityReadinessProof reaches READY_FOR_MERGE. The merge itself stays
the existing human merge_authority path — this flow produces the proof, it never merges.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from ..ledger import append_declared_jsonl, load_declared_jsonl
from ..tool_registry import ensure_tools_dir, utc_now
from . import regression as REG
from . import reproduction as R

REMEDIATION_SURFACE = "security_remediation"
REMEDIATION_RELPATH: tuple[str, ...] = ("security", "remediation.jsonl")
STATES = ("CONFIRMED", "HARDENING_PLANNED", "FIX_PROPOSED", "FIX_DUAL_VERIFIED", "REGRESSION_LOCKED", "READY_FOR_MERGE", "ABANDONED")
TRANSITIONS: dict[str, tuple[str, ...]] = {
    "CONFIRMED": ("HARDENING_PLANNED", "ABANDONED"),
    "HARDENING_PLANNED": ("FIX_PROPOSED", "ABANDONED"),
    "FIX_PROPOSED": ("FIX_DUAL_VERIFIED", "ABANDONED"),
    "FIX_DUAL_VERIFIED": ("REGRESSION_LOCKED", "ABANDONED"),
    "REGRESSION_LOCKED": ("READY_FOR_MERGE", "ABANDONED"),
    "READY_FOR_MERGE": (),
    "ABANDONED": (),
}


class RemediationError(ValueError):
    pass


@dataclass
class Remediation:
    finding_id: str
    claim_type: str
    recipe_digest: str
    state: str = "CONFIRMED"
    fix_head_sha: str | None = None
    mission_id: str | None = None


def _path(base_dir: str | Path | None) -> Path:
    p = ensure_tools_dir(base_dir).joinpath(*REMEDIATION_RELPATH)
    p.parent.mkdir(parents=True, exist_ok=True)
    return p


def _append(base_dir: str | Path | None, row: dict[str, Any]) -> None:
    append_declared_jsonl(_path(base_dir), {"schema_version": 1, "recorded_at": utc_now(), **row}, expected_surface=REMEDIATION_SURFACE)


def open_remediation(*, finding_id: str, claim_type: str, recipe_digest: str, base_dir: str | Path | None = None) -> Remediation:
    """A remediation may only open on a finding the reproduction ledger CONFIRMED."""
    if not R.is_confirmed(claim_type, recipe_digest, base_dir=base_dir):
        raise RemediationError(f"finding {finding_id} is not confirmed in the reproduction ledger; nothing to harden")
    rem = Remediation(finding_id=finding_id, claim_type=claim_type, recipe_digest=recipe_digest)
    _append(base_dir, {"event": "opened", "finding_id": finding_id, "claim_type": claim_type, "recipe_digest": recipe_digest})
    return rem


def _advance(rem: Remediation, to: str, base_dir: str | Path | None, **extra: Any) -> Remediation:
    if to not in TRANSITIONS[rem.state]:
        raise RemediationError(f"{rem.state} -> {to} is not a legal remediation transition")
    _append(base_dir, {"event": "transition", "finding_id": rem.finding_id, "from": rem.state, "to": to, **extra})
    rem.state = to
    return rem


def plan_hardening(rem: Remediation, *, mission_id: str, base_dir: str | Path | None = None) -> Remediation:
    rem.mission_id = mission_id
    return _advance(rem, "HARDENING_PLANNED", base_dir, mission_id=mission_id)


def propose_fix(rem: Remediation, *, fix_head_sha: str, base_dir: str | Path | None = None) -> Remediation:
    rem.fix_head_sha = fix_head_sha
    return _advance(rem, "FIX_PROPOSED", base_dir, fix_head_sha=fix_head_sha)


def verify_fix_dual_green(rem: Remediation, *, primary: R.ExecutorRun, replay: R.ExecutorRun,
                          base_dir: str | Path | None = None) -> Remediation:
    """The SAME recipe must re-run and both executors must observe NO violation on the fix."""
    primary.validate()
    replay.validate()
    if rem.state != "FIX_PROPOSED":
        raise RemediationError("a fix must be proposed before it is verified")
    if primary.recipe_digest != rem.recipe_digest or replay.recipe_digest != rem.recipe_digest:
        raise RemediationError("fix verification must re-run the SAME sealed recipe that reproduced the defect")
    if primary.executor_id == replay.executor_id or primary.lease_id == replay.lease_id:
        raise RemediationError("fix verification needs two independent executors and two clean labs")
    if not (primary.positive_control_ok and replay.positive_control_ok):
        raise RemediationError("a failed positive control cannot verify a fix")
    if not (primary.verdict == "NO_VIOLATION_OBSERVED" and replay.verdict == "NO_VIOLATION_OBSERVED"):
        raise RemediationError("both executors must observe NO_VIOLATION_OBSERVED at the fix head SHA")
    return _advance(rem, "FIX_DUAL_VERIFIED", base_dir, fix_head_sha=rem.fix_head_sha)


def lock_regression(rem: Remediation, recipe: "REG.RegressionRecipe", *, base_dir: str | Path | None = None) -> Remediation:
    if rem.state != "FIX_DUAL_VERIFIED":
        raise RemediationError("a regression can only be locked after the fix is dual-verified")
    if recipe.finding_id != rem.finding_id or recipe.recipe_digest != rem.recipe_digest:
        raise RemediationError("the regression recipe must bind this finding and its recipe digest")
    REG.register_regression(recipe, base_dir=base_dir)
    return _advance(rem, "REGRESSION_LOCKED", base_dir, recipe_id=recipe.recipe_id)


def mark_ready(rem: Remediation, readiness_proof: Any, *, base_dir: str | Path | None = None) -> Remediation:
    if rem.state != "REGRESSION_LOCKED":
        raise RemediationError("readiness comes after the regression is locked")
    if not getattr(readiness_proof, "ready", False):
        raise RemediationError("the SecurityReadinessProof is not ready; remediation stays open")
    return _advance(rem, "READY_FOR_MERGE", base_dir, readiness_digest=readiness_proof.digest())


def harden(rem: Remediation, *, fix_head_sha: str, primary: R.ExecutorRun, replay: R.ExecutorRun,
           regression_recipe: "REG.RegressionRecipe", readiness_proof: Any,
           base_dir: str | Path | None = None) -> Remediation:
    """The kernel's one-shot drive from a planned hardening to READY_FOR_MERGE: propose the
    fix, prove it dual-green on the SAME recipe, lock the permanent regression, gate on the
    readiness proof. It stops at the first gate that refuses; the remediation stays at the
    last state it legitimately reached (nothing is rounded up)."""
    if rem.state != "HARDENING_PLANNED":
        raise RemediationError("harden() starts from HARDENING_PLANNED")
    propose_fix(rem, fix_head_sha=fix_head_sha, base_dir=base_dir)
    verify_fix_dual_green(rem, primary=primary, replay=replay, base_dir=base_dir)
    lock_regression(rem, regression_recipe, base_dir=base_dir)
    return mark_ready(rem, readiness_proof, base_dir=base_dir)


def fold(finding_id: str, *, base_dir: str | Path | None = None) -> Remediation | None:
    path = _path(base_dir)
    if not path.exists():
        return None
    rem: Remediation | None = None
    for row in load_declared_jsonl(path, expected_surface=REMEDIATION_SURFACE):
        if row.get("finding_id") != finding_id:
            continue
        if row.get("event") == "opened":
            rem = Remediation(finding_id=finding_id, claim_type=row.get("claim_type"), recipe_digest=row.get("recipe_digest"))
        elif rem is not None and row.get("event") == "transition":
            rem.state = str(row.get("to"))
            rem.fix_head_sha = row.get("fix_head_sha", rem.fix_head_sha)
            rem.mission_id = row.get("mission_id", rem.mission_id)
    return rem


__all__ = ["REMEDIATION_RELPATH", "REMEDIATION_SURFACE", "STATES", "TRANSITIONS", "Remediation", "RemediationError",
           "fold", "harden", "lock_regression", "mark_ready", "open_remediation", "plan_hardening", "propose_fix", "verify_fix_dual_green"]
