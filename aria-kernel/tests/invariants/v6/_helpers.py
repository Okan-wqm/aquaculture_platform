"""Plan ARIA-V6 shared test helpers.

Mock factories for specialist_review_runner (V6.1), convergent_skill_
authoring (V6.2 — pre-staged), evidence_collector (V6.2 — pre-staged).
All mocks accept ``**kwargs`` permissively (V3 §A2 pattern, verified
by V5 §A9 R-A9 audit) so future Protocol kwarg additions do not
break the fixtures.
"""

from __future__ import annotations

import sys
from pathlib import Path
from typing import Any


_REPO_ROOT = Path(__file__).resolve().parents[4]
_KERNEL_ROOT = _REPO_ROOT / "aria-kernel"
if str(_KERNEL_ROOT) not in sys.path:
    sys.path.insert(0, str(_KERNEL_ROOT))


def _base_specialist_result(
    cycle_id: str,
    verdict: str,
    profile: str = "standard",
    specialists: list[str] | None = None,
    findings: dict[str, list[dict[str, Any]]] | None = None,
) -> dict[str, Any]:
    """Plan ARIA-V6 §2c v2 — fabricate a SpecialistReviewResult dict."""
    return {
        "cycle_id": cycle_id,
        "specialists_dispatched": specialists or [],
        "specialists_timed_out": [],
        "consolidated_verdict": verdict,
        "findings_by_specialist": findings or {},
        "request_ids": [],
        "rounds_count": 1,
        "token_cost_estimate": 0,
        "profile": profile,
    }


def _specialists_no_gaps_fake_runner(**kwargs: Any) -> dict[str, Any]:
    """V6.1 happy-path mock — all specialists clean, worker proceeds."""
    return _base_specialist_result(
        cycle_id=kwargs.get("cycle_id", "cycle-test"),
        verdict="consolidated_no_gaps",
        profile=kwargs.get("profile", "standard"),
        specialists=["auth-security-expert", "farm-expert"],
    )


def _specialists_unavailable_fake_runner(**kwargs: Any) -> dict[str, Any]:
    """V6.1 defensive default — no external dispatcher running."""
    return _base_specialist_result(
        cycle_id=kwargs.get("cycle_id", "cycle-test"),
        verdict="specialists_unavailable",
        profile=kwargs.get("profile", "standard"),
        specialists=[],
    )


def _specialists_remediation_required_fake_runner(**kwargs: Any) -> dict[str, Any]:
    """V6.1 blocking-path mock — specialist found HIGH/CRITICAL finding."""
    return _base_specialist_result(
        cycle_id=kwargs.get("cycle_id", "cycle-test"),
        verdict="consolidated_remediation_required",
        profile=kwargs.get("profile", "standard"),
        specialists=["auth-security-expert"],
        findings={
            "auth-security-expert": [{
                "id": "auth-1",
                "claim_type": "security_risk",
                "severity": "CRITICAL",
                "summary": "missing MFA gate",
                "evidence_refs": ["apps/auth-service/src/mfa.ts:42"],
                "source_agent": "auth-security-expert",
            }],
        },
    )


def _specialists_verdict_fake_runner_factory(verdict: str):
    """Parameterized factory for I-V6.1 verdict-gate testing."""
    def _runner(**kwargs: Any) -> dict[str, Any]:
        return _base_specialist_result(
            cycle_id=kwargs.get("cycle_id", "cycle-test"),
            verdict=verdict,
            profile=kwargs.get("profile", "standard"),
        )
    return _runner
