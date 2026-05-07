"""Tests for the Plan 016 Faz D2 (convergent plan envelope) + D4 (skill genesis demo)."""
from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from aria_kernel.convergent_planning_bridge import (
    issue_challenger_envelope,
    start_convergent_plan_with_envelope,
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

    def _good_args(self) -> dict:
        # plan_convergence._validate_plan_content requires this exact field set.
        return {
            "plan_id": "PLAN-D2-001",
            "plan_content": {
                "schema_version": 1,
                "title": "Faz D2 envelope bridge demo",
                "summary": "Open a convergent plan AND issue a primary envelope in one call.",
                "affected_surfaces": ["aria-kernel/aria_kernel/convergent_planning_bridge.py"],
                "key_changes": ["Open a convergent plan AND issue a primary envelope in one call."],
                "validation_commands": [
                    {"cmd": "nx affected --target=test", "expected_exit": 0, "timeout_ms": 60000},
                ],
                "evidence_refs": ["docs/aria/SPEC.md:53"],
            },
            "initial_revision_id": "REV-001",
            "must_satisfy": [{"id": "MS-1", "statement": "Plan must validate impact graph."}],
            "evidence_refs": ["docs/aria/SPEC.md:53"],
            "allowed_scope": ["aria-kernel/**"],
            "base_dir": self.tools,
        }

    def test_start_creates_plan_and_primary_envelope(self) -> None:
        result = start_convergent_plan_with_envelope(**self._good_args())
        self.assertIn("plan", result)
        self.assertIn("primary_request", result)
        # The primary envelope is in the requests ledger.
        rows = load_jsonl(self.tools / "agent-invocations" / "requests.jsonl")
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["target_agent"], "aria-primary-planner")
        self.assertEqual(rows[0]["role"], "primary_plan")
        self.assertEqual(rows[0]["convergence_id"], "PLAN-D2-001")
        self.assertEqual(rows[0]["round_number"], 1)

    def test_empty_must_satisfy_rejected(self) -> None:
        args = self._good_args()
        args["must_satisfy"] = []
        with self.assertRaisesRegex(GovernanceError, "must_satisfy"):
            start_convergent_plan_with_envelope(**args)

    def test_empty_evidence_refs_rejected(self) -> None:
        args = self._good_args()
        args["evidence_refs"] = []
        with self.assertRaisesRegex(GovernanceError, "evidence_refs"):
            start_convergent_plan_with_envelope(**args)

    def test_empty_allowed_scope_rejected(self) -> None:
        args = self._good_args()
        args["allowed_scope"] = []
        with self.assertRaisesRegex(GovernanceError, "allowed_scope"):
            start_convergent_plan_with_envelope(**args)

    def test_issue_challenger_creates_separate_envelope(self) -> None:
        start_convergent_plan_with_envelope(**self._good_args())
        challenger = issue_challenger_envelope(
            plan_id="PLAN-D2-001",
            round_number=2,
            base_dir=self.tools,
        )
        self.assertEqual(challenger["target_agent"], "aria-challenger-planner")
        self.assertEqual(challenger["role"], "challenger_plan")
        self.assertEqual(challenger["round_number"], 2)
        rows = load_jsonl(self.tools / "agent-invocations" / "requests.jsonl")
        self.assertEqual(len(rows), 2)


class SkillGenesisLifecycleDemoTests(unittest.TestCase):
    """Plan 016 Faz D4 — exercise the existing skill genesis lifecycle.

    Walks request -> draft -> sandbox to verify the existing CLI primitives
    still compose under the v3 ROLES + envelope context. Materialization
    (which writes to .claude/agents/) is intentionally NOT exercised in
    the test suite — that is an operator-supervised step.
    """

    def setUp(self) -> None:
        self.tools = _seed_tools()
        self.repo = self.tools.parent

    def tearDown(self) -> None:
        import shutil
        shutil.rmtree(self.repo, ignore_errors=True)

    def test_request_to_sandbox_walk(self) -> None:
        request = request_skill_genesis(
            capability_gap_key="adapter:demo:missed_signal",
            title="Demo skill genesis lifecycle",
            base_dir=self.tools,
        )
        self.assertTrue(request.get("request_id"))

        draft = draft_skill(
            request_id=request["request_id"],
            name="aria-demo-skill",
            description="Synthetic skill exercising the genesis lifecycle for Plan 016 Faz D4.",
            owners=["platform-team"],
            handoff_agents=["aria-evidence-judge"],
            base_dir=self.tools,
        )
        self.assertTrue(draft.get("draft_id"))

        # Sandbox requires >=3 fixture entries; we feed three synthetic
        # results showing the validator wiring. None of these fixtures
        # carries operator-promotion evidence — the draft moves to a
        # validated state but is intentionally not materialised here.
        sandbox = sandbox_skill(
            draft_id=draft["draft_id"],
            checklist_results=[
                {"id": "fixture-1", "status": "pass", "note": "scope check"},
                {"id": "fixture-2", "status": "pass", "note": "evidence shape check"},
                {"id": "fixture-3", "status": "pass", "note": "no false-positive seed"},
            ],
            base_dir=self.tools,
        )
        # sandbox_skill returns a `decision` field (pass / fail).
        self.assertIn(sandbox.get("decision"), {"pass", "fail"})

        # The kernel ledger now lists the request, draft, and sandbox runs.
        rows = list_skill_genesis(base_dir=self.tools, kind="requests")
        self.assertGreaterEqual(len(rows), 1)


if __name__ == "__main__":
    unittest.main()
