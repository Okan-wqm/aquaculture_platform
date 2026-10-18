"""ARIA-HIGH-194 — a planning envelope cannot be minted on ARIA's own output.

Both live round-1 challengers (`AIR-aria-challenger-planner-2d16fdbb749e`,
`-9f069578375a`) carried only `aria-findings/F-*.json`: gitignored, under
`evidence_trust.SELF_OUTPUT_PREFIXES`, resolvable at no workspace SHA. The
planners refused, the refusal was lost, and each burned its budget to
HUMAN_REQUIRED. ARIA-HIGH-181/183 fixed the synthesizer; the mint refused the
shape when it was a planner's ONLY evidence.

ARIA-MEDIUM-385 — that rule is now the planner case of one law: the mint
refuses, for every role, a ref the submit law refuses
(`evidence_validator.agent_ref_mint_refusal`). A self-output ref beside a
repository ref is refused too: the planner cites the refs its envelope hands
it, and an answer citing that one is refused at the submit.
"""
from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from aria_kernel.agent_invocations import create_agent_invocation_request
from aria_kernel.tool_registry import GovernanceError, ensure_tools_dir
from aria_kernel.request_admission import admit_request


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
            admission=admit_request("operator_cli.request", role, base_dir=self.tools),
        )

    def test_self_output_only_is_refused(self) -> None:
        with self.assertRaises(GovernanceError) as ctx:
            self._mint(["aria-findings/F-003.json"])
        self.assertIn("request_evidence_not_agent_citable", str(ctx.exception))
        self.assertIn("agent_evidence_self_output", str(ctx.exception))

    def test_a_repository_ref_beside_it_does_not_admit_it(self) -> None:
        with self.assertRaises(GovernanceError) as ctx:
            self._mint(["aria-findings/F-003.json", "aria-kernel/aria_kernel/cycle.py:10"])
        self.assertIn("aria-findings/F-003.json:agent_evidence_self_output", str(ctx.exception))

    def test_the_repository_ref_alone_mints(self) -> None:
        row = self._mint(["aria-kernel/aria_kernel/cycle.py:10"])
        self.assertTrue(row["request_id"])

    def test_every_role_is_judged_by_the_same_law(self) -> None:
        with self.assertRaises(GovernanceError) as ctx:
            self._mint(["aria-tools/queue.json"], role="maintenance_utility", target="aria-autonomy-planner")
        self.assertIn("request_evidence_not_agent_citable", str(ctx.exception))


if __name__ == "__main__":
    unittest.main()
