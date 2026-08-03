from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from aria_kernel.agent_invocations import (
    _submit_legacy_invocation_result_internal,
    create_agent_invocation_request,
    list_agent_invocation_requests,
)
from aria_kernel.agent_network import agent_network_index, latest_agent_network_hash
from aria_kernel.capability_gap import detect_capability_gaps
from aria_kernel.impact_graph import plan_downstream_impact
from aria_kernel.ledger import load_jsonl
from aria_kernel.tool_registry import covered_tool_ledgers, ensure_tools_dir
from aria_kernel.workspace import ensure_workspace, workspace_paths
from tests._helpers.declared_fixtures import append_declared_fixture


class Phase4AgentNetworkInvocationTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.repo = Path(self.tmp.name) / "repo"
        self.repo.mkdir()
        agents = self.repo / ".claude" / "agents"
        (agents / "_maintenance").mkdir(parents=True)
        (agents / "farm-expert.md").write_text(
            "---\nname: farm-expert\ndescription: Farm expert.\n---\nOwns `apps/farm-service/**`.\n",
            encoding="utf-8",
        )
        (agents / "_maintenance" / "prompt-writer.md").write_text(
            "---\nname: prompt-writer\ndescription: Prompt writer.\n---\n",
            encoding="utf-8",
        )
        (self.repo / ".claude" / "shared").mkdir(parents=True)
        (self.repo / ".claude" / "shared" / "orchestrator-routing-table.md").write_text("farm -> farm-expert\n", encoding="utf-8")
        (self.repo / ".claude" / "skills").mkdir(parents=True)
        (self.repo / ".claude" / "skills" / "README.md").write_text("skills\n", encoding="utf-8")
        self.tools_dir = ensure_tools_dir(Path(self.tmp.name) / "aria-tools")
        self.paths = workspace_paths(self.repo, Path(self.tmp.name) / "workspaces")
        ensure_workspace(self.paths)

    def tearDown(self):
        self.tmp.cleanup()

    def test_agent_network_index_is_cached_and_marks_dispatchable_agents(self):
        first = agent_network_index(workspace_root=self.repo, base_dir=self.tools_dir, cycle_id="cyc-1")
        second = agent_network_index(workspace_root=self.repo, base_dir=self.tools_dir, cycle_id="cyc-2")
        self.assertEqual(first["status"], "rebuilt")
        self.assertEqual(second["status"], "cached")
        self.assertIn("farm-expert", second["dispatchable_agents"])
        self.assertNotIn("prompt-writer", second["dispatchable_agents"])
        self.assertEqual(latest_agent_network_hash(base_dir=self.tools_dir), first["index_hash"])

    def test_agent_invocation_result_hash_and_path_mismatch(self):
        expected = self.tools_dir / "agent-invocations" / "outputs" / "C-1" / "round-1-cross-review.md"
        # Plan 024 §B-2 — request row carries strict fields so the legacy
        # path-mismatch rejection still works under the renamed
        # _submit_legacy_invocation_result_internal helper. The legacy
        # helper itself does not require strict fields on the response,
        # but the request row does (for any future strict-path claim
        # to remain unaffected).
        request = create_agent_invocation_request(
            target_agent="farm-expert",
            role="cross_review",
            suggested_prompt="review this plan",
            must_satisfy=[
                {"id": "phase4-cross-review", "criterion": "review concludes"},
            ],
            allowed_scope=["aria-kernel/**"],
            convergence_id="C-1",
            round_number=1,
            expected_output_path=expected.as_posix(),
            base_dir=self.tools_dir,
        )
        wrong = self.tools_dir / "wrong.md"
        wrong.write_text("wrong\n", encoding="utf-8")
        # Plan 024 §B-1 — `submit_agent_invocation_result` was renamed to
        # `_submit_legacy_invocation_result_internal` and gated behind
        # `operator_migration_approval_ref`. This test still exercises the
        # path-mismatch rejection logic of the legacy helper, so it
        # carries the approval ref.
        rejected = _submit_legacy_invocation_result_internal(
            request_id=request["request_id"],
            output_path=wrong,
            base_dir=self.tools_dir,
            operator_migration_approval_ref="OP-PHASE4-LEGACY-PATH-MISMATCH-TEST",
        )
        self.assertEqual(rejected["reason"], "agent_invocation_path_mismatch")
        expected.parent.mkdir(parents=True)
        expected.write_text("review\n", encoding="utf-8")
        accepted = _submit_legacy_invocation_result_internal(
            request_id=request["request_id"],
            output_path=expected,
            by="operator",
            base_dir=self.tools_dir,
            operator_migration_approval_ref="OP-PHASE4-LEGACY-PATH-MISMATCH-TEST",
        )
        self.assertEqual(accepted["status"], "completed")
        self.assertTrue(accepted["content_hash"].startswith("sha256:"))
        self.assertEqual(len(list_agent_invocation_requests(base_dir=self.tools_dir, convergence_id="C-1")), 1)

    def test_tool_integrity_covers_new_optional_ledgers(self):
        append_declared_fixture(self.tools_dir / "plans" / "events.jsonl", {"schema_version": 1, "event_type": "noop"}, expected_surface="plan_convergence_events")
        append_declared_fixture(self.tools_dir / "agent-invocations" / "requests.jsonl", {"schema_version": 1, "request_id": "AIR-1"}, expected_surface="agent_invocation_requests")
        append_declared_fixture(self.tools_dir / "agent-invocations" / "results.jsonl", {"schema_version": 1, "request_id": "AIR-1"}, expected_surface="agent_invocation_results")
        ledgers = covered_tool_ledgers(self.tools_dir)
        # Coverage keys are the manifest surface names now (glob surfaces
        # key each match as name:relative/path) — the hand-list aliases
        # these pins used to assert died with the hand list itself.
        self.assertIn("plan_convergence_events:plans/events.jsonl", ledgers)
        self.assertIn("agent_invocation_requests", ledgers)
        self.assertIn("agent_invocation_results", ledgers)

    def test_capability_gap_pressure_source_records_index_hash(self):
        index = agent_network_index(workspace_root=self.repo, base_dir=self.tools_dir, cycle_id="cyc-index")
        append_declared_fixture(
            self.paths.ledgers["pressure"],
            {
                "$schema": "aria/pressure-event/v2",
                "schema_version": 2,
                "event_id": "PE-1",
                "primitive": "REPETITION",
                "subtype": "missing routing",
                "capability_gap_key": "farm:routing:ts",
                "magnitude": 3,
                "threshold": 3,
                "exceeds_threshold": True,
                "evidence_refs": ["apps/farm-service/src/app.ts:1"],
                "feedback_event_ids": [],
                "detected_at": "2026-05-06T00:00:00Z",
                "drives": ["skill_birth"],
            },
            expected_surface="workspace_memory_pressure",
        )
        result = detect_capability_gaps(cycle_id="cyc-gap", paths=self.paths, base_dir=self.tools_dir)
        gap = result["gaps"][0]
        self.assertEqual(gap["capability_gap_key"], "farm:routing:ts")
        self.assertEqual(gap["primary_source"], "pressure")
        self.assertEqual(gap["index_hash_at_decision"], index["index_hash"])

    def test_impact_graph_normalization_preserves_dot_github(self):
        (self.repo / ".github" / "workflows").mkdir(parents=True)
        (self.repo / ".github" / "workflows" / "ci.yml").write_text("name: ci\n", encoding="utf-8")
        result = plan_downstream_impact(changed_files=[".github/workflows/ci.yml:1"], workspace_root=self.repo, base_dir=self.tools_dir)
        self.assertIn(".github/workflows/ci.yml", result["unknown_files"])


if __name__ == "__main__":
    unittest.main()
