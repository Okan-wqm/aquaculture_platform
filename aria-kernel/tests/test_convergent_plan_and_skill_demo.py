"""Plan ARIA-V8 v2 §4 Phase 8.1 — rewritten for V8 producer surface.

V8 deleted ``start_convergent_plan_with_envelope`` (legacy round-1
primary envelope) per B-V2-07. The new entry
``start_convergent_plan_drafted_by_primary`` registers the plan
WITHOUT minting any envelope; convergence_drainer mints challenger +
cross_review immediately, and round-2+ mints primary REVISION via
``cross_review_bridge.issue_primary_envelope`` (Tier-1 impossible
mint guard for round-1).
"""
from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from aria_kernel.convergent_planning_bridge import (
    issue_challenger_envelope,
    start_convergent_plan_drafted_by_primary,
)
from aria_kernel.ledger import load_jsonl
from aria_kernel.skill_genesis import (
    draft_skill,
    list_skill_genesis,
    request_skill_genesis,
    sandbox_skill,
)
from aria_kernel.tool_registry import GovernanceError, ensure_tools_dir


def _seed_tools() -> Path:
    repo = Path(tempfile.mkdtemp(prefix="aria-d2d4-"))
    tools = repo / "aria-tools"
    ensure_tools_dir(tools)
    return tools


class ConvergentPlanBridgeTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tools = _seed_tools()
        self.repo = self.tools.parent

    def tearDown(self) -> None:
        import shutil
        shutil.rmtree(self.repo, ignore_errors=True)

    def _good_plan_args(self) -> dict:
        return {
            "plan_id": "PLAN-D2-001",
            "plan_content": {
                "schema_version": 1,
                "title": "Faz D2 envelope bridge demo",
                "summary": "V8 P+C+CR convergence; primary draft is cycle_runner's plan_content.",
                "affected_surfaces": ["aria-kernel/aria_kernel/convergent_planning_bridge.py"],
                "key_changes": ["V8 P+C+CR pipeline opens plan without primary envelope."],
                "validation_commands": [
                    {"cmd": "nx affected --target=test", "expected_exit": 0, "timeout_ms": 60000},
                ],
                "evidence_refs": ["docs/aria/SPEC.md:53"],
            },
            "initial_revision_id": "REV-001",
            "base_dir": self.tools,
        }

    def test_start_creates_plan_without_primary_envelope(self) -> None:
        """V8 §4 Phase 8.1 — plan is opened in DRAFT state but NO
        primary envelope is minted. The convergence_drainer mints
        challenger + cross_review afterwards."""
        result = start_convergent_plan_drafted_by_primary(**self._good_plan_args())
        self.assertIn("plan", result)
        self.assertNotIn("primary_request", result,
                         "V8: round-1 has NO primary envelope (cycle_runner's plan_content IS the primary draft)")
        # No envelope rows in the requests ledger yet
        requests_path = self.tools / "agent-invocations" / "requests.jsonl"
        if requests_path.exists():
            rows = load_jsonl(requests_path)
            self.assertEqual(len(rows), 0, "V8: no envelopes minted at plan-start")

    def test_empty_plan_content_rejected(self) -> None:
        args = self._good_plan_args()
        args["plan_content"] = {}
        with self.assertRaisesRegex(GovernanceError, "plan_content"):
            start_convergent_plan_drafted_by_primary(**args)

    def test_issue_challenger_creates_envelope(self) -> None:
        """V8 round-1 mints challenger envelope first (helper extracted
        from convergence_drainer round-1 + round-2+ bodies)."""
        start_convergent_plan_drafted_by_primary(**self._good_plan_args())
        challenger = issue_challenger_envelope(
            plan_id="PLAN-D2-001",
            round_number=1,
            must_satisfy=[{"id": "MS-1", "description": "Plan must validate impact graph."}],
            allowed_scope=["aria-kernel/**"],
            evidence_refs=["docs/aria/SPEC.md:53"],
            base_dir=self.tools,
        )
        self.assertEqual(challenger["target_agent"], "aria-challenger-planner")
        self.assertEqual(challenger["role"], "challenger_plan")
        self.assertEqual(challenger["round_number"], 1)
        rows = load_jsonl(self.tools / "agent-invocations" / "requests.jsonl")
        # Round-1 envelopes minted so far: just challenger (cross_review
        # mints later in the drainer flow)
        self.assertEqual(len(rows), 1)


class SkillGenesisDemo(unittest.TestCase):
    """Skill-genesis happy-path smoke (Plan 016 Faz D4 signature)."""

    def setUp(self) -> None:
        self.tools = _seed_tools()
        self.repo = self.tools.parent

    def tearDown(self) -> None:
        import shutil
        shutil.rmtree(self.repo, ignore_errors=True)

    def test_request_then_list(self) -> None:
        req = request_skill_genesis(
            capability_gap_key="GAP-1",
            title="skill-demo",
            base_dir=self.tools,
        )
        self.assertIn("request_id", req)
        listed = list_skill_genesis(base_dir=self.tools, kind="requests")
        self.assertEqual(len(listed), 1)
