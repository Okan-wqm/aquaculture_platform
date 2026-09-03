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


def _plan_synthesizer_fake_runner(**kwargs: Any) -> dict[str, Any] | None:
    """Plan ARIA-V7 §2i v2 V7.1 — happy-path mock plan_synthesizer.

    Returns a structurally-valid plan_content (all 7 required fields)
    so the cycle proceeds through Gate A unimpeded. R-A9 compat for
    V6.1 invariant tests + reused by future V7 tests.
    """
    cycle_id = kwargs.get("cycle_id", "cycle-test")
    return {
        "schema_version": 1,
        "title": f"Fake cycle {cycle_id}",
        "summary": "R-A9 V7 fixture",
        "affected_surfaces": ["fixture.py"],
        "key_changes": [{"id": "c1", "description": "x", "paths": ["fixture.py"]}],
        "validation_commands": [{"cmd": "echo ok", "timeout_ms": 1000, "expected_exit": 0}],
        "evidence_refs": ["fixture.py:1:line"],
    }


def _plan_synthesizer_no_pressure_fake_runner(**kwargs: Any) -> None:
    """V7.1 no-pressure mock — synthesizer returns None when discovery
    finds no workspace deltas. Cycle should emit cycle_runner_no_pressure
    phase + skip Gate A/B/C/worker/auto_merge."""
    return None


def _skill_genesis_drainer_fake_runner(**kwargs: Any) -> dict[str, Any]:
    """Plan ARIA-V7 §2h v2 V7.4 — happy-path mock skill_genesis_drainer.

    Returns aggregate_verdict='no_requests' so the cycle proceeds
    through Gate A unimpeded. R-A9 compat for V6.1 invariant tests.
    """
    return {
        "cycle_id": kwargs.get("cycle_id", "cycle-test"),
        "requests_scanned": 0, "requests_dispatched": 0,
        "requests_skipped_corpus_missing": 0,
        "requests_skipped_evidence_insufficient": 0,
        "requests_skipped_already_terminal": 0,
        "requests_skipped_token_budget": 0,
        "requests_skipped_non_convergent": 0,
        "authoring_results": [], "tokens_spent_this_cycle": 0,
        "aggregate_verdict": "no_requests",
    }
