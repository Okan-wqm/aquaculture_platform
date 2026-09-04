"""Plan 033 Faz 033h — security operability: doctor checks + a fitness instrument.

WHY: the health of the security lane must be visible and it must fail loudly. `doctor`
reports a pack in quarantine, coverage that is stale/inconclusive/not-tested, a cleanup
that never verified, and any open CRITICAL/HIGH. The fitness instrument turns assurance
coverage into a security dimension verdict that is `unknown` when it cannot see and
`red` on any gap — never a silent green.
"""
from __future__ import annotations

from pathlib import Path
from typing import Any

from ..doctor import DoctorCheck
from . import assurance as A


def security_doctor(*, profile_row: dict[str, Any], pack_manifests: list[Any], open_critical_or_high: int = 0,
                    quarantined_packs: tuple[str, ...] = (), unverified_cleanups: tuple[str, ...] = (),
                    base_dir: str | Path | None = None) -> tuple[DoctorCheck, ...]:
    coverage = A.compute_coverage(profile_row=profile_row, pack_manifests=pack_manifests, base_dir=base_dir)
    checks: list[DoctorCheck] = []
    checks.append(DoctorCheck(
        name="security.packs_quarantined",
        status="fail" if quarantined_packs else "ok",
        reason=f"{len(quarantined_packs)} pack(s) quarantined" if quarantined_packs else "no packs quarantined",
        detail={"packs": list(quarantined_packs)}))
    gap = coverage["not_tested"] or coverage["unknown"]
    checks.append(DoctorCheck(
        name="security.coverage",
        status="fail" if (gap or not coverage["required_cells"]) else "ok",
        reason=(f"not_tested={coverage['not_tested']} unknown={coverage['unknown']}" if gap
                else "no required cells" if not coverage["required_cells"] else "all applicable controls covered with fresh evidence"),
        detail={"clean_required_coverage": coverage["clean_required_coverage"], "required_cells": coverage["required_cells"]}))
    checks.append(DoctorCheck(
        name="security.cleanup",
        status="fail" if unverified_cleanups else "ok",
        reason=f"{len(unverified_cleanups)} campaign(s) without a verified teardown" if unverified_cleanups else "all campaigns torn down",
        detail={"campaigns": list(unverified_cleanups)}))
    checks.append(DoctorCheck(
        name="security.open_findings",
        status="fail" if open_critical_or_high else "ok",
        reason=f"{open_critical_or_high} open CRITICAL/HIGH" if open_critical_or_high else "no open CRITICAL/HIGH",
        detail={"open_critical_or_high": open_critical_or_high}))
    return tuple(checks)


def security_fitness_verdict(*, profile_row: dict[str, Any], pack_manifests: list[Any],
                             base_dir: str | Path | None = None) -> tuple[str, str]:
    """(status, detail): green only when every applicable control is covered with fresh
    evidence and no vulnerability is confirmed; unknown when there is nothing to measure."""
    coverage = A.compute_coverage(profile_row=profile_row, pack_manifests=pack_manifests, base_dir=base_dir)
    if not coverage["required_cells"]:
        return "unknown", "no applicable security controls to measure"
    if coverage["vulnerability_confirmed"]:
        return "red", f"{coverage['vulnerability_confirmed']} confirmed vulnerability(ies)"
    if coverage["not_tested"] or coverage["unknown"]:
        return "red", f"not_tested={coverage['not_tested']} unknown={coverage['unknown']}"
    return "green", f"clean_required_coverage={coverage['clean_required_coverage']}"


__all__ = ["security_doctor", "security_fitness_verdict"]
