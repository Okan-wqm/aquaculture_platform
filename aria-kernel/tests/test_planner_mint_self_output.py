"""ARIA-HIGH-194 — a planning envelope cannot be minted on ARIA's own output.

Both live round-1 challengers (`AIR-aria-challenger-planner-2d16fdbb749e`,
`-9f069578375a`) carried only `aria-findings/F-*.json`: gitignored, under
`evidence_trust.SELF_OUTPUT_PREFIXES`, resolvable at no workspace SHA. The
planners refused, the refusal was lost, and each burned its budget to
HUMAN_REQUIRED. ARIA-HIGH-181/183 fixed the synthesizer; the mint now refuses
the shape for every caller.
"""
from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from aria_kernel.agent_invocations import create_agent_invocation_request
from aria_kernel.tool_registry import GovernanceError, ensure_tools_dir


class PlannerMintSelfOutputTests(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory(prefix="aria-h194-mint-")
        self.tools = ensure_tools_dir(Path(self._tmp.name) / "aria-tools")

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def _mint(self, refs: list[str], *, role: str = "challenger_plan", target: str = "aria-challenger-planner"):
        return create_agent_invocation_request(
            target_agent=target,
            role=role,
            suggested_prompt="challenge the plan",
            must_satisfy=[{"id": "MS-1", "description": "cite the repository"}],
            allowed_scope=["aria-kernel/**"],
            evidence_refs=refs,
            base_dir=self.tools,
        )

    def test_self_output_only_is_refused(self) -> None:
        with self.assertRaises(GovernanceError) as ctx:
            self._mint(["aria-findings/F-003.json"])
        self.assertIn("request_evidence_self_output_only", str(ctx.exception))

    def test_a_repository_ref_beside_it_is_admitted(self) -> None:
        row = self._mint(["aria-findings/F-003.json", "aria-kernel/aria_kernel/cycle.py:10"])
        self.assertTrue(row["request_id"])

    def test_other_roles_are_not_judged_by_this_rule(self) -> None:
        row = self._mint(
            ["aria-tools/queue.json"], role="maintenance_utility", target="aria-autonomy-planner",
        )
        self.assertTrue(row["request_id"])


if __name__ == "__main__":
    unittest.main()
