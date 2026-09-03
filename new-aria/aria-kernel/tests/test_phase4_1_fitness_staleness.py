from __future__ import annotations

import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

from aria_kernel.tool_registry import ensure_tools_dir
from aria_kernel.triage import FITNESS_STALENESS_DAYS, _is_fitness_stale, triage_policy_apply
from aria_kernel.workspace import ensure_workspace, workspace_paths
from tests._helpers.declared_fixtures import append_declared_fixture


class FitnessStalenessHelperTests(unittest.TestCase):
    def test_empty_row_is_not_stale(self):
        # No fitness record → caller short-circuits before reaching this branch.
        self.assertFalse(_is_fitness_stale({}))

    def test_missing_recorded_at_is_stale(self):
        self.assertTrue(_is_fitness_stale({"agent_name": "x"}))

    def test_unparseable_recorded_at_is_stale(self):
        self.assertTrue(_is_fitness_stale({"agent_name": "x", "recorded_at": "not-a-date"}))

    def test_fresh_recorded_at_is_not_stale(self):
        recent = (datetime.now(timezone.utc) - timedelta(days=1)).isoformat().replace("+00:00", "Z")
        self.assertFalse(_is_fitness_stale({"agent_name": "x", "recorded_at": recent}))

    def test_old_recorded_at_is_stale(self):
        old = (datetime.now(timezone.utc) - timedelta(days=8)).isoformat().replace("+00:00", "Z")
        self.assertTrue(_is_fitness_stale({"agent_name": "x", "recorded_at": old}))

    def test_threshold_boundary(self):
        boundary = (datetime.now(timezone.utc) - timedelta(days=FITNESS_STALENESS_DAYS, hours=1)).isoformat().replace("+00:00", "Z")
        self.assertTrue(_is_fitness_stale({"agent_name": "x", "recorded_at": boundary}))


class FitnessStalenessTriageTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.repo = Path(self.tmp.name) / "repo"
        self.repo.mkdir()
        self.tools_dir = ensure_tools_dir(Path(self.tmp.name) / "aria-tools")
        self.paths = workspace_paths(self.repo, Path(self.tmp.name) / "workspaces")
        ensure_workspace(self.paths)
        # Seed one auto_fix_safe-eligible pressure (low-risk path).
        append_declared_fixture(
            self.paths.ledgers["pressure"],
            {
                "$schema": "aria/pressure-event/v2",
                "schema_version": 2,
                "event_id": "PE-fresh",
                "primitive": "REPETITION",
                "subtype": "doc gap",
                "magnitude": 3,
                "threshold": 3,
                "exceeds_threshold": True,
                "evidence_refs": ["docs/aria/notes.md"],
                "feedback_event_ids": [],
                "detected_at": "2026-05-06T00:00:00Z",
            },
            expected_surface="workspace_memory_pressure",
        )
        # Routing table maps the pressure to "farm-expert".
        # Note: resolve_target_agent lowercases the primitive key for lookup.
        routing_path = self.tools_dir / "triage" / "agent-routing.json"
        routing_path.parent.mkdir(parents=True, exist_ok=True)
        routing_path.write_text('{"routes": {"repetition": "farm-expert"}}', encoding="utf-8")

    def tearDown(self):
        self.tmp.cleanup()

    def _seed_fitness(self, recorded_at: str, tier: str = "ACTIVE") -> None:
        append_declared_fixture(
            self.tools_dir / "fitness" / "agent-fitness.jsonl",
            {
                "$schema": "aria/agent-fitness/v1",
                "schema_version": 1,
                "agent_name": "farm-expert",
                "tier": tier,
                "max_triage_tier": "auto_fix_safe",
                "score": 0.9,
                "recorded_at": recorded_at,
            },
            expected_surface="fitness_agent",
        )

    def test_fresh_fitness_keeps_auto_fix_safe(self):
        recent = (datetime.now(timezone.utc) - timedelta(days=1)).isoformat().replace("+00:00", "Z")
        self._seed_fitness(recent)
        result = triage_policy_apply(self.paths, cycle_id="cyc-fresh", tools_root=self.tools_dir)
        decision = result["decisions"][0]
        self.assertEqual(decision["triage_tier"], "auto_fix_safe")
        self.assertNotIn("agent_fitness_stale", decision["reasons"])

    def test_stale_fitness_downgrades_auto_fix_safe(self):
        old = (datetime.now(timezone.utc) - timedelta(days=8)).isoformat().replace("+00:00", "Z")
        self._seed_fitness(old)
        result = triage_policy_apply(self.paths, cycle_id="cyc-stale", tools_root=self.tools_dir)
        decision = result["decisions"][0]
        self.assertEqual(decision["triage_tier"], "needs_review")
        self.assertIn("agent_fitness_stale", decision["reasons"])

    def test_missing_recorded_at_counts_as_stale_for_routing(self):
        append_declared_fixture(
            self.tools_dir / "fitness" / "agent-fitness.jsonl",
            {
                "$schema": "aria/agent-fitness/v1",
                "schema_version": 1,
                "agent_name": "farm-expert",
                "tier": "ACTIVE",
                "max_triage_tier": "auto_fix_safe",
                "score": 0.9,
            },
            expected_surface="fitness_agent",
        )
        result = triage_policy_apply(self.paths, cycle_id="cyc-missing", tools_root=self.tools_dir)
        decision = result["decisions"][0]
        self.assertEqual(decision["triage_tier"], "needs_review")
        self.assertIn("agent_fitness_stale", decision["reasons"])


if __name__ == "__main__":
    unittest.main()
