"""Plan ARIA-V5 shared test helpers.

Hermetic fixtures + mock runner factories for the V5 invariant
suite. Pre-stages BOTH convergence_runner mocks (C1 / V5.1) and
review_runner mocks (C2 / V5.2) so C2 reuses C1's _helpers without
re-churn.

All mock signatures accept ``**kwargs`` permissively (V3 §A2 pattern,
verified by Validator 2 §0). Future ConvergenceRunner / ReviewRunner
Protocol kwarg additions do not break the mocks; the Protocol
contract is enforced separately by I-V5-01 / I-V5-02 signature
inspection on ``run_autonomy_orchestrator`` itself.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any


_REPO_ROOT = Path(__file__).resolve().parents[4]
_KERNEL_ROOT = _REPO_ROOT / "aria-kernel"
if str(_KERNEL_ROOT) not in sys.path:
    sys.path.insert(0, str(_KERNEL_ROOT))


# ---------------------------------------------------------------------------
# Convergence-runner mocks — Plan ARIA-V5 §4 V5.1 + Plan Agent 3 design
# ---------------------------------------------------------------------------


def _base_convergence_result(
    plan_id: str,
    cycle_id: str,
    arbiter_verdict: str,
    rounds: int = 1,
    converged_plan: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Plan ARIA-V5 §3c v2 — fabricate a ConvergenceResult dict.

    Used by every convergence_runner mock to produce a structurally-
    valid result without going through the real plan_convergence
    machinery. Schema mirrors ``ConvergenceResult`` TypedDict in
    aria_kernel.convergence_drainer.
    """
    return {
        "plan_id": plan_id,
        "converged_plan": converged_plan if converged_plan is not None else (
            {"plan_id": plan_id, "must_satisfy": []} if arbiter_verdict == "converged" else {}
        ),
        "rounds_count": rounds,
        "arbiter_verdict": arbiter_verdict,
        "unsatisfied_items": [],
        "request_ids": [f"req-{plan_id}-r1"],
        "transcript_path": f"convergence/{cycle_id}.jsonl",
        "resumed_from_persistence": False,
        "convergence_id": plan_id,
    }


def _converges_immediately_fake_convergence_runner(**kwargs: Any) -> dict[str, Any]:
    """V5.1 happy path: arbiter_verdict='converged' on round 1.

    Used by the orchestrator's main test fixture so the cycle proceeds
    through worker_drainer + auto_merge unimpeded.
    """
    return _base_convergence_result(
        plan_id=kwargs.get("plan_id", "plan-test"),
        cycle_id=kwargs.get("cycle_id", "cycle-test"),
        arbiter_verdict="converged",
        rounds=1,
    )


def _converges_after_n_rounds_fake_convergence_runner_factory(rounds: int = 3):
    """V5.1 bounded oscillation: converges on round N (N <= max_rounds)."""
    def _runner(**kwargs: Any) -> dict[str, Any]:
        return _base_convergence_result(
            plan_id=kwargs.get("plan_id", "plan-test"),
            cycle_id=kwargs.get("cycle_id", "cycle-test"),
            arbiter_verdict="converged",
            rounds=rounds,
        )
    return _runner


def _never_converges_fake_convergence_runner(**kwargs: Any) -> dict[str, Any]:
    """V5.1 cap: hits max_rounds without consensus.

    Verdict='max_rounds' — orchestrator MUST skip worker_drainer.
    """
    return _base_convergence_result(
        plan_id=kwargs.get("plan_id", "plan-test"),
        cycle_id=kwargs.get("cycle_id", "cycle-test"),
        arbiter_verdict="max_rounds",
        rounds=kwargs.get("max_rounds", 4),
    )


def _verdict_fake_convergence_runner_factory(verdict: str, rounds: int = 1):
    """V5.1 parameterized: returns the named verdict.

    Covers ``split``, ``scope_abort``, ``primary_silent``,
    ``challenger_unavailable``, ``aria_stop_interrupted`` — used by
    I-V5.1-04 to assert worker_drainer is skipped for all 5
    non-converged verdicts.
    """
    def _runner(**kwargs: Any) -> dict[str, Any]:
        return _base_convergence_result(
            plan_id=kwargs.get("plan_id", "plan-test"),
            cycle_id=kwargs.get("cycle_id", "cycle-test"),
            arbiter_verdict=verdict,
            rounds=rounds,
        )
    return _runner


# ---------------------------------------------------------------------------
# Review-runner mocks — Plan ARIA-V5 §4 V5.2 + Plan Agent 3 design
# ---------------------------------------------------------------------------


def _base_review_result(
    plan_id: str,
    cycle_id: str,
    review_verdict: str,
    rounds: int = 1,
    gaps: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    """Plan ARIA-V5 §3d v2 — fabricate a ReviewResult dict.

    Pre-staged at C1 (V5.1 landing) so C2 (V5.2 wiring) reuses
    without re-churn.
    """
    return {
        "plan_id": plan_id,
        "impl_artifacts_ref": f"pr-{cycle_id}@abc123",
        "review_verdict": review_verdict,
        "rounds_count": rounds,
        "gaps_found": gaps if gaps is not None else (
            [] if review_verdict == "no_gaps" else [{"id": "gap-1", "severity": "MEDIUM"}]
        ),
        "request_ids": [f"req-review-{plan_id}-r1"],
        "convergence_id": plan_id,
    }


def _review_passes_immediately_fake_review_runner(**kwargs: Any) -> dict[str, Any]:
    """V5.2 happy path: review finds no gaps on round 1.

    Verdict='no_gaps' — orchestrator proceeds to auto_merge_runner.
    """
    return _base_review_result(
        plan_id=kwargs.get("plan_id", "plan-test"),
        cycle_id=kwargs.get("cycle_id", "cycle-test"),
        review_verdict="no_gaps",
        rounds=1,
    )


def _review_finds_gaps_then_passes_fake_review_runner_factory(rounds: int = 2):
    """V5.2 iteration: gaps round 1, passes round N."""
    def _runner(**kwargs: Any) -> dict[str, Any]:
        return _base_review_result(
            plan_id=kwargs.get("plan_id", "plan-test"),
            cycle_id=kwargs.get("cycle_id", "cycle-test"),
            review_verdict="no_gaps",
            rounds=rounds,
        )
    return _runner


def _review_always_finds_gaps_fake_review_runner(**kwargs: Any) -> dict[str, Any]:
    """V5.2 cap: gaps_open verdict — auto_merge_runner MUST be skipped."""
    return _base_review_result(
        plan_id=kwargs.get("plan_id", "plan-test"),
        cycle_id=kwargs.get("cycle_id", "cycle-test"),
        review_verdict="gaps_open",
        rounds=kwargs.get("max_review_rounds", 3),
        gaps=[
            {"id": "gap-1", "severity": "HIGH"},
            {"id": "gap-2", "severity": "MEDIUM"},
        ],
    )


def _review_verdict_fake_review_runner_factory(verdict: str, rounds: int = 1):
    """V5.2 parameterized review verdict factory.

    Covers all 4 non-pass verdicts (``gaps_open``, ``max_review_rounds``,
    ``judge_split``, ``artifact_mismatch``) for I-V5.2-03.
    """
    def _runner(**kwargs: Any) -> dict[str, Any]:
        return _base_review_result(
            plan_id=kwargs.get("plan_id", "plan-test"),
            cycle_id=kwargs.get("cycle_id", "cycle-test"),
            review_verdict=verdict,
            rounds=rounds,
        )
    return _runner


# ---------------------------------------------------------------------------
# Generic fixture seeds — Plan ARIA-V5 §4 fixtures
# ---------------------------------------------------------------------------


def seed_minimal_tools_root(workspace: Path) -> Path:
    """Plan ARIA-V5 §4 — minimum aria-tools setup for orchestrator tests."""
    tools_root = workspace / "aria-tools"
    tools_root.mkdir(parents=True, exist_ok=True)
    identity_path = tools_root / "repo_identity.json"
    if not identity_path.exists():
        identity_path.write_text(
            json.dumps({
                "aria_tools_contract_version": 3,
                "bound_canonical_identity": "test-identity",
                "bound_repo_hash": "test-identity",
                "bound_repo_root": str(workspace),
                "schema_version": 3,
            }),
            encoding="utf-8",
        )
    return tools_root


def clear_aria_tools_env() -> dict[str, str]:
    """Plan ARIA-V3.3 R-A4 — clear ARIA_TOOLS_DIR snapshot."""
    import os
    snapshot: dict[str, str] = {}
    if "ARIA_TOOLS_DIR" in os.environ:
        snapshot["ARIA_TOOLS_DIR"] = os.environ.pop("ARIA_TOOLS_DIR")
    return snapshot


def restore_aria_tools_env(snapshot: dict[str, str]) -> None:
    """Restore env snapshot saved by ``clear_aria_tools_env``."""
    import os
    for key, value in snapshot.items():
        os.environ[key] = value
