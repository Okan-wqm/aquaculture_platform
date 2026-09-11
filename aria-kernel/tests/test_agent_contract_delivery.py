"""ARIA-HIGH-073 — the model is shown the contract it is told to obey.

What this pins, one property per test:

* The agent body is delivered without its YAML frontmatter, under a heading
  that names the agent, behind a runtime note that says every cited file is
  inlined and only the message's evidence counts.
* Every `@.claude/knowledge/...md` citation in the body is inlined once, in
  citation order, inside a fence that names its path.
* A citation the budget cannot hold, or one that does not resolve under the
  repository root (a missing file, a `../` escape), is LISTED as omitted —
  never silently dropped.
* The hash is over the delivered text and changes when a cited file changes.
* An agent that does not exist is a named refusal, not an empty contract.
* The real `aria-challenger-planner` contract carries its canonical-envelope
  knowledge file inline — the file the first completed native planner run
  could not read.
* ARIA-HIGH-078 — every delivered contract ends with the response validator's
  own rules, rendered from the code that enforces them: the first live
  managed-Claude cross-review was refused for a missing `note` on a
  `contradicted` verdict after its prose contract had said the kernel reads
  `id` + `verdict` only. The rendered text names what the validator checks,
  and the validator behaves as the text says.
"""
from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from aria_kernel.agent_contract_delivery import (
    AgentContractUnavailable,
    render_agent_contract,
)

_REPO_ROOT = Path(__file__).resolve().parents[2]


class _Fixture(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="aria-contract-"))
        self.addCleanup(lambda: __import__("shutil").rmtree(self.tmp, ignore_errors=True))
        (self.tmp / ".claude/agents").mkdir(parents=True)
        (self.tmp / ".claude/knowledge").mkdir(parents=True)
        (self.tmp / ".claude/knowledge/layer-2-shape.md").write_text("# Shape\n\nseven keys\n", encoding="utf-8")
        (self.tmp / ".claude/knowledge/layer-1-laws.md").write_text("# Laws\n\nno prose\n", encoding="utf-8")
        (self.tmp / ".claude/agents/fixture-agent.md").write_text(
            "---\nname: fixture-agent\nmodel: opus\n---\n"
            "# Fixture agent\n\nAnswer with plan_content.\n\n"
            "- `@.claude/knowledge/layer-2-shape.md`\n"
            "Also read @.claude/knowledge/layer-1-laws.md and again `@.claude/knowledge/layer-2-shape.md`.\n",
            encoding="utf-8",
        )


class Delivery(_Fixture):
    def test_frontmatter_is_stripped_and_the_body_is_framed(self) -> None:
        delivery = render_agent_contract("fixture-agent", repo_root=self.tmp)
        self.assertNotIn("model: opus", delivery.text)
        self.assertTrue(delivery.text.startswith("# Agent contract: fixture-agent\n"))
        self.assertIn("Runtime note:", delivery.text)
        self.assertIn("Answer with plan_content.", delivery.text)
        self.assertEqual(delivery.agent_path, ".claude/agents/fixture-agent.md")

    def test_citations_are_inlined_once_in_order_inside_named_fences(self) -> None:
        delivery = render_agent_contract("fixture-agent", repo_root=self.tmp)
        self.assertEqual(delivery.inlined_refs, (".claude/knowledge/layer-2-shape.md", ".claude/knowledge/layer-1-laws.md"))
        self.assertEqual(delivery.omitted_refs, ())
        self.assertEqual(delivery.text.count("<inlined_knowledge_file>"), 2)
        shape = delivery.text.index("## Inlined knowledge file: `.claude/knowledge/layer-2-shape.md`")
        laws = delivery.text.index("## Inlined knowledge file: `.claude/knowledge/layer-1-laws.md`")
        self.assertLess(shape, laws)
        self.assertIn("seven keys", delivery.text)
        self.assertIn("no prose", delivery.text)

    def test_a_citation_over_budget_is_listed_as_omitted(self) -> None:
        delivery = render_agent_contract("fixture-agent", repo_root=self.tmp, inline_budget_bytes=10)
        self.assertEqual(delivery.inlined_refs, ())
        self.assertEqual(set(delivery.omitted_refs), {".claude/knowledge/layer-2-shape.md", ".claude/knowledge/layer-1-laws.md"})
        self.assertIn("## Cited knowledge files NOT inlined", delivery.text)

    def test_a_missing_or_escaping_citation_is_listed_not_dropped(self) -> None:
        (self.tmp / ".claude/agents/escaper.md").write_text(
            "---\nname: escaper\n---\nSee @.claude/knowledge/../../etc/passwd.md and @.claude/knowledge/absent.md\n",
            encoding="utf-8",
        )
        delivery = render_agent_contract("escaper", repo_root=self.tmp)
        self.assertEqual(delivery.inlined_refs, ())
        self.assertEqual(delivery.omitted_refs, (".claude/knowledge/../../etc/passwd.md", ".claude/knowledge/absent.md"))

    def test_the_hash_binds_the_delivered_text(self) -> None:
        first = render_agent_contract("fixture-agent", repo_root=self.tmp)
        again = render_agent_contract("fixture-agent", repo_root=self.tmp)
        self.assertEqual(first.contract_hash, again.contract_hash)
        (self.tmp / ".claude/knowledge/layer-1-laws.md").write_text("# Laws\n\nchanged\n", encoding="utf-8")
        changed = render_agent_contract("fixture-agent", repo_root=self.tmp)
        self.assertNotEqual(first.contract_hash, changed.contract_hash)
        self.assertTrue(changed.contract_hash.startswith("sha256:"))

    def test_an_unknown_agent_is_a_named_refusal(self) -> None:
        with self.assertRaises(AgentContractUnavailable) as caught:
            render_agent_contract("no-such-agent", repo_root=self.tmp)
        self.assertIn("agent_file_unavailable", str(caught.exception))
        with self.assertRaises(AgentContractUnavailable):
            render_agent_contract("../escape", repo_root=self.tmp)


class TheValidatorSpeaksLast(_Fixture):
    def test_the_delivered_contract_ends_with_the_validators_rules(self) -> None:
        from aria_kernel.agent_contract import (
            REASON_CLASSES,
            RESPONSE_STATUSES,
            SATISFACTION_VERDICTS,
            render_response_validator_contract,
        )

        delivery = render_agent_contract("fixture-agent", repo_root=self.tmp)
        rendered = render_response_validator_contract()
        self.assertTrue(delivery.text.endswith(rendered), delivery.text[-400:])
        self.assertLess(delivery.text.index("<inlined_knowledge_file>"), delivery.text.index(rendered))
        for word in (*SATISFACTION_VERDICTS, *RESPONSE_STATUSES, *REASON_CLASSES, "`note`", "evidence_refs"):
            self.assertIn(word, rendered, word)
        self.assertNotIn("id` + `verdict` only", rendered)

    def test_the_rendered_rule_is_the_rule_the_validator_enforces(self) -> None:
        from aria_kernel.agent_contract import validate_response
        from aria_kernel.tool_registry import GovernanceError

        # The live envelope's shape: reason under `evidence`, no `note`.
        envelope = {
            "$schema": "aria/agent-response/v1", "request_id": "AIR-aria-cross-reviewer-1da71e60e0ee",
            "claim_id": "claim_f7acce6ca4be2ad1", "agent_id": "aria-flow-cross-reviewer-claude-trial-six",
            "role": "cross_review", "status": "submitted",
            "satisfaction_matrix": [{"id": "flow-behavior", "verdict": "contradicted",
                                     "evidence": "the hook discards the mutation payload",
                                     "evidence_refs": ["web/shell/src/hooks/useNotifications.ts:142"]}],
        }
        with self.assertRaises(GovernanceError) as caught:
            validate_response(envelope)
        self.assertIn("satisfaction_matrix[0].note required when verdict='contradicted'", str(caught.exception))
        envelope["satisfaction_matrix"][0]["note"] = "the hook discards the mutation payload"
        validate_response(envelope)


class TheRealPlannerContract(unittest.TestCase):
    def test_the_challenger_planner_carries_its_canonical_envelope_knowledge(self) -> None:
        delivery = render_agent_contract("aria-challenger-planner", repo_root=_REPO_ROOT)
        self.assertIn(".claude/knowledge/layer-2-aria-canonical-envelope.md", delivery.inlined_refs)
        self.assertIn("plan_content", delivery.text)
        self.assertEqual(delivery.omitted_refs, ())


if __name__ == "__main__":
    unittest.main()
