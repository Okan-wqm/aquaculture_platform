"""WP-D3 — the agent is ASKED for defect claims, in the words the bridge enforces.

SPEC point 1: the ``change_intelligence`` agent contract gains ``details.defect_claims[]``
next to ``impact_map`` — in the agent's prompt file, in the contract text the kernel
delivers to every model (``agent_contract.render_response_validator_contract``, rendered
from code so the prose cannot promise what the bridge refuses), and in the request the
mint hands the agent (``pr_tracking.dispatch_change_intelligence``): an agent that is never
asked for claims returns none, and the bridge has nothing to turn into rows.

The claim shape is the one the bridge reads (``_helpers.change_review_claims.CLAIM_FIELDS``);
the families a claim may name are the registered tool's, so the delivered contract lists
exactly the families ``change-review`` declares. The 200-line cap and the prompt-shape
invariants of the agent file are enforced by ``tests/invariants/agent-size-limit.spec.ts``
and its siblings, not repeated here. Claim text is untrusted model output: the prompt says
so, and the delivered contract never promotes a claim to a finding.
"""
from __future__ import annotations

import unittest

from aria_kernel import pr_tracking
from aria_kernel.agent_contract import render_response_validator_contract
from aria_kernel.agent_invocations import list_agent_invocation_requests
from tests._helpers.change_review_claims import CLAIM_FIELDS, REPO_ROOT, ChangeReviewCase

AGENT_PROMPT = REPO_ROOT / ".claude" / "agents" / "aria-change-intelligence.md"
DEFECT_CLAIMS = "details.defect_claims"


class AgentContractTests(ChangeReviewCase):
    def test_the_agent_prompt_file_names_defect_claims_beside_impact_map(self) -> None:
        text = AGENT_PROMPT.read_text(encoding="utf-8")

        self.assertIn(DEFECT_CLAIMS, text, "aria-change-intelligence.md never mentions details.defect_claims")
        self.assertIn("details.impact_map", text, "the impact map is still part of the contract")

    def test_the_delivered_contract_states_the_claim_shape_and_the_families(self) -> None:
        text = render_response_validator_contract()

        self.assertIn(DEFECT_CLAIMS, text, "the contract every model receives does not describe details.defect_claims")
        tail = text[text.index(DEFECT_CLAIMS):]
        for field in CLAIM_FIELDS:
            with self.subTest(field=field):
                self.assertIn(field, tail, f"the delivered claim shape omits {field}")
        self.assertTrue(self.families.registered, "change-review is not registered, so there are no families to state")
        for family in self.families.names:
            with self.subTest(family=family):
                self.assertIn(family, tail, f"the delivered contract does not name the claim family {family}")

    def test_the_mint_asks_the_agent_for_defect_claims(self) -> None:
        subject = pr_tracking.resolve_change_subject(
            self.change.repo, change_base=self.change.base, change_head=self.change.head,
        )

        pr_tracking.dispatch_change_intelligence(cycle_id="cyc-d3-mint", base_dir=self.tools, subject=subject)

        rows = [
            row for row in list_agent_invocation_requests(base_dir=self.tools, role=pr_tracking.CHANGE_INTELLIGENCE_ROLE)
            if row.get("subject_ref") == self.change.subject
        ]
        self.assertEqual(len(rows), 1, "one change-intelligence request for the operator's subject")
        self.assertIn(DEFECT_CLAIMS, rows[0]["suggested_prompt"], "the request never asks for details.defect_claims")


if __name__ == "__main__":
    unittest.main()
