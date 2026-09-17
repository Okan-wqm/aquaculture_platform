"""Typed operator approval — bare strings stop being authority.

ARIA-AUDIT-015: three promotion surfaces accepted any non-empty string
(runtime_artifacts' operator_approval_ref), any >=16-char string
(knowledge_graph's operator_signature), and nothing at all
(finding_promotion's consensus batch). Each now routes through
operator_approval.verify_operator_approval_ref, whose grammar resolves
the reference against recorded authority — governance event, review
document, or operator-injected env acknowledgment — and refuses
everything else.
"""
from __future__ import annotations

import json
import shutil
import tempfile
import unittest
from pathlib import Path

from aria_kernel.operator_approval import (
    OperatorApprovalUnrecorded,
    verify_operator_approval_ref,
)
from aria_kernel.tool_registry import ensure_tools_dir, GovernanceError


class TypedOperatorApprovalTests(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = Path(tempfile.mkdtemp(prefix="aria-opa-"))
        self.addCleanup(lambda: shutil.rmtree(self._tmp, ignore_errors=True))
        self.root = ensure_tools_dir(self._tmp / "aria-tools")

    def _record_governance_event(self, event_id: str) -> None:
        from aria_kernel.tool_registry import append_tools_governance

        append_tools_governance(
            self.root, "operator_action", {"event_id": event_id, "action": "approve"},
        )

    def test_bare_strings_refuse(self) -> None:
        for bogus in ("", "   ", "yes", "approved-by-bob", "x" * 40):
            with self.subTest(ref=bogus), self.assertRaises(OperatorApprovalUnrecorded):
                verify_operator_approval_ref(bogus, base_dir=self.root, surface="test")

    def test_gov_reference_resolves_only_when_recorded(self) -> None:
        self._record_governance_event("evt-123")
        proof = verify_operator_approval_ref("gov:evt-123", base_dir=self.root, surface="test")
        self.assertEqual(proof["kind"], "gov")
        with self.assertRaises(OperatorApprovalUnrecorded):
            verify_operator_approval_ref("gov:evt-forged", base_dir=self.root, surface="test")

    def test_review_reference_requires_the_anchor_on_disk(self) -> None:
        doc = self._tmp / "review.md"
        doc.write_text("## OP-1 approved\n", encoding="utf-8")
        proof = verify_operator_approval_ref(f"review:{doc}#OP-1", base_dir=self.root, surface="test")
        self.assertEqual(proof["anchor"], "OP-1")
        with self.assertRaises(OperatorApprovalUnrecorded):
            verify_operator_approval_ref(f"review:{doc}#OP-2", base_dir=self.root, surface="test")

    def test_ack_env_requires_a_nonempty_variable(self) -> None:
        import os

        os.environ["ARIA_TEST_ACK"] = "operator-approved"
        self.addCleanup(os.environ.pop, "ARIA_TEST_ACK", None)
        proof = verify_operator_approval_ref("ack-env:ARIA_TEST_ACK", base_dir=self.root, surface="test")
        self.assertEqual(proof["kind"], "ack-env")
        with self.assertRaises(OperatorApprovalUnrecorded):
            verify_operator_approval_ref("ack-env:ARIA_TEST_ACK_UNSET", base_dir=self.root, surface="test")

    def test_runtime_artifacts_promotion_refuses_unresolvable_refs(self) -> None:
        from aria_kernel.runtime_artifacts import approve_runtime_v2_promotion

        bundle = self.root / "runtime" / "v2" / "bundle.json"
        bundle.parent.mkdir(parents=True, exist_ok=True)
        bundle.write_text("{}", encoding="utf-8")
        with self.assertRaises(GovernanceError) as ctx:
            approve_runtime_v2_promotion(
                evidence_bundle=bundle,
                operator_approval_ref="approved-by-producer",
                base_dir=self.root,
            )
        self.assertIn("operator_approval", str(ctx.exception))

    def test_knowledge_graph_signature_refuses_bare_strings(self) -> None:
        from aria_kernel.knowledge_graph import (
            KnowledgeGraphSignatureMissing,
            record_anti_pattern,
        )

        with self.assertRaises((KnowledgeGraphSignatureMissing, OperatorApprovalUnrecorded)):
            record_anti_pattern(
                {"pattern_type": "anti_pattern", "expression": "getRepository("},
                workspace_root=self._tmp,
                reason_class="tool_design",
                operator_signature="looks-legit-signature-16chars",
            )

    def test_anti_pattern_approval_and_append_use_the_same_explicit_root(self) -> None:
        from aria_kernel import knowledge_graph as kg
        from aria_kernel.tool_registry import append_tools_governance

        tools = ensure_tools_dir(self._tmp / "store/tools")
        workspace = self._tmp / "checkout"
        legacy = ensure_tools_dir(workspace / "aria-tools")
        append_tools_governance(legacy, "operator_action", {"event_id": "legacy-only", "action": "approve"})
        pattern = kg.Pattern(
            pattern_id="avoid-duplicate-store", pattern_type="anti_pattern", confidence=1.0,
            evidence_refs=("docs/aria/SPEC.md:1",), discovered_by_cycle_id="approval-root",
            observed_at="2026-09-10T00:00:00Z",
        )
        with self.assertRaises(kg.KnowledgeGraphSignatureMissing):
            kg.record_anti_pattern(
                pattern, base_dir=tools, workspace_root=workspace,
                reason_class="architecture_class", operator_signature="gov:legacy-only",
            )
        self.assertFalse((tools / "knowledge-graph/anti-patterns.jsonl").exists())
        append_tools_governance(tools, "operator_action", {"event_id": "canonical-only", "action": "approve"})
        path = kg.record_anti_pattern(
            pattern, base_dir=tools, workspace_root=workspace,
            reason_class="architecture_class", operator_signature="gov:canonical-only",
        )
        self.assertEqual(path, tools / "knowledge-graph/anti-patterns.jsonl")
        self.assertEqual(
            [r["pattern_id"] for r in kg.anti_patterns_for_paths(
                base_dir=tools, workspace_root=workspace, paths=["docs/aria/SPEC.md"],
            )], [pattern.pattern_id],
        )
        self.assertFalse((legacy / "knowledge-graph/anti-patterns.jsonl").exists())

    def test_anti_pattern_cli_forwards_the_resolved_tools_root(self) -> None:
        import io
        from contextlib import redirect_stdout
        from aria_kernel import cli
        from aria_kernel.ledger import load_declared_jsonl
        from aria_kernel.tool_registry import append_tools_governance

        tools = ensure_tools_dir(self._tmp / "store/tools")
        workspace = self._tmp / "checkout"
        workspace.mkdir()
        append_tools_governance(tools, "operator_action", {"event_id": "cli-approval", "action": "approve"})
        self.assertEqual(verify_operator_approval_ref("gov:cli-approval", base_dir=tools, surface="test")["kind"], "gov")
        output = io.StringIO()
        with redirect_stdout(output):
            code = cli.main([
                "anti-pattern", "record", "--tools-dir", str(tools),
                "--workspace-root", str(workspace), "--pattern-id", "avoid-shadow-state",
                "--reason-class", "architecture_class", "--evidence-ref", "docs/aria/SPEC.md:1",
                "--cycle-id", "cli-root", "--operator-signature", "gov:cli-approval",
            ])
        self.assertEqual(code, 0)
        path = tools / "knowledge-graph/anti-patterns.jsonl"
        self.assertEqual(json.loads(output.getvalue())["written"], str(path))
        self.assertEqual([r["pattern_id"] for r in load_declared_jsonl(path, expected_surface="kg_anti_patterns")], ["avoid-shadow-state"])
        self.assertFalse((workspace / "aria-tools").exists())


if __name__ == "__main__":
    unittest.main()
