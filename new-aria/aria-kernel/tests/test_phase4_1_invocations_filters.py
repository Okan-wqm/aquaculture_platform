from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from aria_kernel.agent_invocations import (
    create_agent_invocation_request,
    list_agent_invocation_requests,
)
from aria_kernel.tool_registry import ensure_tools_dir


class AgentInvocationListFilterTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.tools_dir = ensure_tools_dir(Path(self.tmp.name) / "aria-tools")
        # Plan 024 §B-2 — these tests only exercise list_agent_invocation_-
        # requests filtering, never the strict claim path. The escape
        # hatch keeps the matrix shape from being the test's concern;
        # the request rows still carry empty must_satisfy + allowed_scope
        # so an attempt to strict-claim them later would surface
        # request_state_legacy_unmigrated as expected.
        self.req_a = create_agent_invocation_request(
            target_agent="farm-expert",
            role="cross_review",
            suggested_prompt="A",
            legacy_strict_fields_optional=True,
            convergence_id="C-1",
            round_number=1,
            base_dir=self.tools_dir,
        )
        self.req_b = create_agent_invocation_request(
            target_agent="aria-adversarial-judge",
            role="primary_plan",
            suggested_prompt="B",
            legacy_strict_fields_optional=True,
            convergence_id="C-2",
            round_number=1,
            base_dir=self.tools_dir,
        )
        self.req_c = create_agent_invocation_request(
            target_agent="aria-implementer",
            role="implementation",
            suggested_prompt="C",
            legacy_strict_fields_optional=True,
            convergence_id="C-1",
            round_number=2,
            base_dir=self.tools_dir,
        )

    def tearDown(self):
        self.tmp.cleanup()

    def test_filter_by_role(self):
        rows = list_agent_invocation_requests(base_dir=self.tools_dir, role="cross_review")
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["request_id"], self.req_a["request_id"])

    def test_filter_by_request_id(self):
        rows = list_agent_invocation_requests(base_dir=self.tools_dir, request_id=self.req_b["request_id"])
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["target_agent"], "aria-adversarial-judge")

    def test_filter_by_target_agent(self):
        rows = list_agent_invocation_requests(base_dir=self.tools_dir, target_agent="farm-expert")
        self.assertEqual(len(rows), 1)

    def test_filter_by_convergence_id(self):
        rows = list_agent_invocation_requests(base_dir=self.tools_dir, convergence_id="C-1")
        self.assertEqual(len(rows), 2)

    def test_combined_filter_role_and_target_agent(self):
        rows = list_agent_invocation_requests(
            base_dir=self.tools_dir,
            target_agent="aria-implementer",
            role="implementation",
        )
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["request_id"], self.req_c["request_id"])

    def test_combined_filter_returns_empty_on_no_match(self):
        rows = list_agent_invocation_requests(
            base_dir=self.tools_dir,
            target_agent="aria-adversarial-judge",
            role="implementation",
        )
        self.assertEqual(rows, [])


if __name__ == "__main__":
    unittest.main()
