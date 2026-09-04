"""Plan 033 Faz 033g — SecurityReadinessProof: source-bound, recomputed at merge.

WHY: a green checkbox is not readiness. This proof is bound to a PR head SHA and is
recomputed from ledgers at merge time (a trusted `passed=true` is never accepted). It
has two obligations: impact_coverage (every control the PR touches PLUS every
zero-tolerance tenant/auth control is tested with a fresh, non-stale answer) and
finding_closure (every finding the PR claims to fix reproduced dual-red before and
verified dual-green after, on the SAME recipe and this head SHA). A gap in either is a
blocked proof with the reasons named — not a soft warning.
"""
from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from . import assurance as A
from . import reproduction as R

# controls that must ALWAYS be covered regardless of what the PR touched
ZERO_TOLERANCE_CONTROLS = ("multi_tenant/rls_coverage", "multi_tenant/tenant_isolation", "api/public_write_guard", "api/authz")


@dataclass(frozen=True)
class FindingClosure:
    finding_id: str
    claim_type: str
    recipe_digest: str
    pre_fix_confirmed: bool
    post_fix_clean: bool
    head_sha: str

    @property
    def closed(self) -> bool:
        return self.pre_fix_confirmed and self.post_fix_clean


@dataclass(frozen=True)
class SecurityReadinessProof:
    head_sha: str
    impacted_controls: tuple[str, ...]
    coverage: dict[str, Any]
    closures: tuple[FindingClosure, ...] = ()
    open_critical_or_high: int = 0

    @property
    def required_controls(self) -> tuple[str, ...]:
        return tuple(sorted(set(self.impacted_controls) | set(ZERO_TOLERANCE_CONTROLS)))

    @property
    def coverage_gaps(self) -> list[str]:
        gaps: list[str] = []
        if self.coverage.get("not_tested"):
            gaps.append(f"not_tested={self.coverage['not_tested']}")
        if self.coverage.get("unknown"):
            gaps.append(f"unknown={self.coverage['unknown']}")
        if self.coverage.get("vulnerability_confirmed"):
            gaps.append(f"confirmed={self.coverage['vulnerability_confirmed']}")
        return gaps

    @property
    def unclosed_findings(self) -> list[str]:
        return [c.finding_id for c in self.closures if not c.closed]

    @property
    def ready(self) -> bool:
        return (not self.coverage_gaps and not self.unclosed_findings and self.open_critical_or_high == 0
                and bool(self.coverage.get("required_cells")))

    def digest(self) -> str:
        payload = {"head_sha": self.head_sha, "required_controls": list(self.required_controls),
                   "coverage": self.coverage, "closures": [c.__dict__ for c in self.closures],
                   "open_critical_or_high": self.open_critical_or_high, "ready": self.ready}
        return "sha256:" + hashlib.sha256(json.dumps(payload, sort_keys=True).encode("utf-8")).hexdigest()

    def to_row(self) -> dict[str, Any]:
        return {"head_sha": self.head_sha, "required_controls": list(self.required_controls),
                "coverage_gaps": self.coverage_gaps, "unclosed_findings": self.unclosed_findings,
                "open_critical_or_high": self.open_critical_or_high, "ready": self.ready, "digest": self.digest()}


def compute_readiness(*, head_sha: str, impacted_controls: tuple[str, ...], profile_row: dict[str, Any],
                      pack_manifests: list[Any], closures: tuple[FindingClosure, ...] = (),
                      open_critical_or_high: int = 0, base_dir: str | Path | None = None) -> SecurityReadinessProof:
    """Recompute from the assurance ledger + reproduction ledger. Never trusts a prior verdict."""
    coverage = A.compute_coverage(profile_row=profile_row, pack_manifests=pack_manifests, base_dir=base_dir)
    verified: list[FindingClosure] = []
    for closure in closures:
        # a claimed closure is only counted if the reproduction ledger actually confirms the pre-fix red
        confirmed = R.is_confirmed(closure.claim_type, closure.recipe_digest, base_dir=base_dir)
        verified.append(FindingClosure(finding_id=closure.finding_id, claim_type=closure.claim_type,
                                       recipe_digest=closure.recipe_digest,
                                       pre_fix_confirmed=closure.pre_fix_confirmed and confirmed,
                                       post_fix_clean=closure.post_fix_clean, head_sha=closure.head_sha))
    return SecurityReadinessProof(head_sha=head_sha, impacted_controls=tuple(impacted_controls), coverage=coverage,
                                  closures=tuple(verified), open_critical_or_high=open_critical_or_high)


__all__ = ["ZERO_TOLERANCE_CONTROLS", "FindingClosure", "SecurityReadinessProof", "compute_readiness"]
