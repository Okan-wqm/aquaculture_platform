"""Plan 026R §E.3 — skill genesis chain enforcement.

5 tests:

* draft_skill without matching request → raise.
* draft_skill with valid request → succeed.
* sandbox_skill without matching draft → raise.
* materialize_skill without passing sandbox → raise.
* materialize_skill with failing sandbox → raise.
"""
from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from aria_kernel.auto_action_gate import gate_from_test_fixture
from aria_kernel.runtime_profile import set_profile
from aria_kernel.skill_genesis import (
    draft_skill,
    materialize_skill,
    request_skill_genesis,
    sandbox_skill,
)
from aria_kernel.tool_registry import GovernanceError


def _v3_test_gate():
    """Plan ARIA-V3 §A4 + §2l — autonomous-equivalent gate for unit
    tests so the materialise path auto-mints + consumes without
    requiring an operator ack token.
    """
    return gate_from_test_fixture(
        profile="autonomous",
        lane="L0-main",
        classifier_passed=True,
        policy_requires_acknowledge=False,
    )


class SkillGenesisChainTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="aria-e3-"))
        self.base = self.tmp / "aria-tools"
        set_profile("standard", operator_approval_ref="t", base_dir=self.base)

    def tearDown(self) -> None:
        import shutil
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_draft_without_request_raises(self) -> None:
        with self.assertRaises(GovernanceError) as ctx:
            draft_skill(
                request_id="nope-no-such-request",
                name="my-skill",
                description="desc",
                owners=["test"],
                handoff_agents=["agent-a"],
                base_dir=self.base,
            )
        self.assertIn("request_not_found", str(ctx.exception))

    def test_draft_with_valid_request_succeeds(self) -> None:
        req = request_skill_genesis(
            capability_gap_key="cap:test",
            title="test skill",
            base_dir=self.base,
        )
        draft = draft_skill(
            request_id=req["request_id"],
            name="my-skill",
            description="desc",
            owners=["test"],
            handoff_agents=["agent-a"],
            base_dir=self.base,
        )
        self.assertEqual(draft["request_id"], req["request_id"])

    def test_sandbox_without_draft_raises(self) -> None:
        with self.assertRaises(GovernanceError) as ctx:
            sandbox_skill(
                draft_id="nope-no-such-draft",
                checklist_results=[
                    {"fixture_id": "f1", "status": "pass"},
                    {"fixture_id": "f2", "status": "pass"},
                    {"fixture_id": "f3", "status": "pass"},
                ],
                base_dir=self.base,
                synthetic_test_mode=True,
                operator_approval_ref="test-synthetic-fixture",
            )
        self.assertIn("draft_not_found", str(ctx.exception))

    def test_materialize_without_sandbox_raises(self) -> None:
        req = request_skill_genesis(
            capability_gap_key="cap:test2",
            title="test skill 2",
            base_dir=self.base,
        )
        draft = draft_skill(
            request_id=req["request_id"],
            name="my-skill-2",
            description="desc",
            owners=["test"],
            handoff_agents=["agent-a"],
            base_dir=self.base,
        )
        # No sandbox row → materialise raises.
        with self.assertRaises(GovernanceError) as ctx:
            materialize_skill(
                draft_id=draft["draft_id"],
                assignment_id="as-x",
                workspace_root=self.tmp,
                gate=_v3_test_gate(),
                base_dir=self.base,
            )
        self.assertIn(
            "skill_materialize_requires_passing_sandbox",
            str(ctx.exception),
        )

    def test_materialize_with_failing_sandbox_raises(self) -> None:
        req = request_skill_genesis(
            capability_gap_key="cap:test3",
            title="test skill 3",
            base_dir=self.base,
        )
        draft = draft_skill(
            request_id=req["request_id"],
            name="my-skill-3",
            description="desc",
            owners=["test"],
            handoff_agents=["agent-a"],
            base_dir=self.base,
        )
        # Sandbox with at least one fail → decision="fail" → materialise raises.
        sandbox_skill(
            draft_id=draft["draft_id"],
            checklist_results=[
                {"fixture_id": "f1", "status": "pass"},
                {"fixture_id": "f2", "status": "fail"},
                {"fixture_id": "f3", "status": "pass"},
            ],
            base_dir=self.base,
            synthetic_test_mode=True,
            operator_approval_ref="test-synthetic-fixture",
        )
        with self.assertRaises(GovernanceError) as ctx:
            materialize_skill(
                draft_id=draft["draft_id"],
                assignment_id="as-y",
                workspace_root=self.tmp,
                gate=_v3_test_gate(),
                base_dir=self.base,
            )
        self.assertIn(
            "skill_materialize_requires_passing_sandbox",
            str(ctx.exception),
        )


if __name__ == "__main__":
    unittest.main()
