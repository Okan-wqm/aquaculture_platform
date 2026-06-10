from __future__ import annotations

import json
import os
import subprocess
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

from aria_kernel.fitness import agent_fitness_score, latest_agent_fitness
from aria_kernel.ledger import append_declared_jsonl, read_jsonl
from aria_kernel.report_ingestion import report_ingestion_scan
from aria_kernel.semantic_dedup import semantic_dedup_compute
from aria_kernel.telemetry import export_telemetry
from aria_kernel.triage import triage_policy_apply
from aria_kernel.verification_gate import submit_worker_result, verify_worker_result
from aria_kernel.worker_dispatch import claim_assignment, create_dispatch_request
from aria_kernel.workspace import ensure_workspace, workspace_paths
from aria_kernel.tool_registry import ensure_tools_binding


class Phase3AutonomousLearningTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.repo = Path(self.tmp.name) / "repo"
        self.repo.mkdir()
        self._git("init")
        self._git("config", "user.email", "aria@example.test")
        self._git("config", "user.name", "ARIA Test")
        (self.repo / "docs").mkdir()
        (self.repo / "docs" / "note.md").write_text("one\n", encoding="utf-8")
        self._git("add", "docs/note.md")
        self._git("commit", "-m", "initial")
        self.paths = workspace_paths(self.repo, Path(self.tmp.name) / "workspaces")
        ensure_workspace(self.paths)
        self.tools_dir = ensure_tools_binding(Path(self.tmp.name) / "aria-tools", workspace_root=self.repo)

    def tearDown(self):
        self.tmp.cleanup()

    def test_report_ingestion_baselines_then_ingests_open_findings(self):
        registry = self.repo / "docs" / "reviews" / "_registry"
        registry.mkdir(parents=True)
        findings = registry / "findings.jsonl"
        findings.write_text(
            json.dumps({"id": "F-1", "status": "OPEN", "owner_agent": "docs-agent", "severity": "high", "summary": "missing docs check", "refs": ["docs/note.md:1"]}) + "\n",
            encoding="utf-8",
        )

        first = report_ingestion_scan(self.paths, cycle_id="cyc-one", tools_root=self.tools_dir)
        self.assertEqual(first["status"], "baselined")
        self.assertEqual(first["ingested_count"], 0)

        with findings.open("a", encoding="utf-8") as handle:
            handle.write(json.dumps({"id": "F-2", "status": "OPEN", "owner_agent": "docs-agent", "severity": "medium", "summary": "new docs gap", "refs": ["docs/note.md:1"]}) + "\n")
        second = report_ingestion_scan(self.paths, cycle_id="cyc-two", tools_root=self.tools_dir)
        self.assertEqual(second["ingested_count"], 1)
        self.assertEqual(read_jsonl(self.paths.ledgers["missed_signals"])[-1]["summary"], "new docs gap")
        self.assertIn("aria_agent_report_ingested_total", export_telemetry(self.paths, tools_root=self.tools_dir))

    def test_semantic_triage_dispatch_result_verification_and_fitness(self):
        route = self.tools_dir / "triage" / "agent-routing.json"
        route.parent.mkdir(parents=True)
        route.write_text(json.dumps({"routes": {"docs": "docs-agent"}}), encoding="utf-8")
        # Plan 023 v3 §R-4 — patch the missing-fitness default cap to
        # 'auto_fix_safe' for THIS test so the autonomous-learning
        # loop fixture can exercise its full dispatch+verification
        # path. Pre-Plan-023 this fixture relied on the no-fitness-
        # no-cap bypass; §R-4 closed it for production paths but the
        # test fixture explicitly opts back in to the path-class
        # behavior since fitness computation is what the test is
        # exercising (the test computes fitness AFTER dispatch, so the
        # initial triage cannot rely on a pre-seeded fitness row
        # without conflicting with the weekly-gate compute path).
        from unittest.mock import patch
        with patch("aria_kernel.triage._enforce_max_triage_tier",
                   lambda *, classified_tier, fitness_row: (classified_tier, [])):
            self._run_phase3_loop_body()

    def _run_phase3_loop_body(self):
        append_declared_jsonl(
            self.paths.ledgers["pressure"],
            self._pressure("PE-docs-1", "docs/note.md:1", subtype="missing docs check"),
            expected_surface="workspace_memory_pressure",
        )
        append_declared_jsonl(
            self.paths.ledgers["pressure"],
            self._pressure("PE-docs-2", "docs/note.md:2", subtype="missing docs check repeated"),
            expected_surface="workspace_memory_pressure",
        )

        clusters = semantic_dedup_compute(self.paths, cycle_id="cyc-cluster", tools_root=self.tools_dir)
        self.assertEqual(clusters["merged_count"], 1)
        self.assertTrue((self.tools_dir / "problem_clusters.jsonl").exists())

        triage = triage_policy_apply(self.paths, cycle_id="cyc-triage", tools_root=self.tools_dir)
        tiers = {row["pressure_event_id"]: row["triage_tier"] for row in triage["decisions"]}
        self.assertEqual(tiers["PE-docs-1"], "auto_fix_safe")

        request = create_dispatch_request(
            self.paths,
            pressure_event_id="PE-docs-1",
            tools_root=self.tools_dir,
            prepare_worktree=True,
            acknowledge=True,
        )
        # Plan 026R §E.4 — skill_birth pressures route to
        # skill_genesis via the kernel constant; the assignment_id
        # prefix reflects the new target_agent.
        self.assertRegex(
            request["assignment_id"],
            r"^A-(docs-agent|skill-genesis)-[0-9a-f]{8}$",
        )
        worktree = Path(request["worktree_path"])
        (worktree / "docs" / "note.md").write_text("two\n", encoding="utf-8")
        subprocess.run(["git", "add", "docs/note.md"], cwd=worktree, check=True)
        subprocess.run(["git", "commit", "-m", "fix docs", "-m", "Closes-Pressure: PE-docs-1"], cwd=worktree, text=True, capture_output=True, check=True)

        claim = claim_assignment(
            assignment_id=request["assignment_id"],
            agent_id="phase3-test-worker",
            base_dir=self.tools_dir,
        )
        accepted = submit_worker_result(
            from_worktree=worktree,
            assignment_id=request["assignment_id"],
            tools_root=self.tools_dir,
            lease_token=claim["lease_token"],
        )
        self.assertEqual(accepted["state"], "accepted")
        verified = verify_worker_result(assignment_id=request["assignment_id"], tools_root=self.tools_dir)
        self.assertEqual(verified["status"], "passed")
        self.assertFalse(verified["auto_merge_evaluated"])

        os.environ["ARIA_FITNESS_CLOCK_OVERRIDE"] = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
        try:
            fitness = agent_fitness_score(cycle_id="cyc-fit", base_dir=self.tools_dir)
        finally:
            os.environ.pop("ARIA_FITNESS_CLOCK_OVERRIDE", None)
        self.assertEqual(fitness["status"], "computed")
        latest = latest_agent_fitness(base_dir=self.tools_dir)[0]
        self.assertEqual(latest["tier"], "ACTIVE")

        os.environ["ARIA_FITNESS_CLOCK_OVERRIDE"] = (datetime.now(timezone.utc) + timedelta(days=1)).isoformat().replace("+00:00", "Z")
        try:
            skipped = agent_fitness_score(cycle_id="cyc-fit-two", base_dir=self.tools_dir)
        finally:
            os.environ.pop("ARIA_FITNESS_CLOCK_OVERRIDE", None)
        self.assertEqual(skipped["status"], "skipped")

    def test_worker_result_rejects_wrong_worktree_and_trailer_mismatch(self):
        route = self.tools_dir / "triage" / "agent-routing.json"
        route.parent.mkdir(parents=True)
        route.write_text(json.dumps({"routes": {"docs": "docs-agent"}}), encoding="utf-8")
        append_declared_jsonl(
            self.paths.ledgers["pressure"],
            self._pressure("PE-docs-3", "docs/note.md:1"),
            expected_surface="workspace_memory_pressure",
        )
        # Plan 023 v3 §R-4 — patch the missing-fitness default cap so
        # this fixture (which has no pre-seeded fitness row for
        # docs-agent) still triages PE-docs-3 at auto_fix_safe and the
        # downstream dispatch+worker-result gate fires. Production
        # paths still get the §R-4 cap; this is a test-fixture bypass.
        from unittest.mock import patch
        with patch("aria_kernel.triage._enforce_max_triage_tier",
                   lambda *, classified_tier, fitness_row: (classified_tier, [])):
            triage_policy_apply(self.paths, cycle_id="cyc-triage", tools_root=self.tools_dir)
        request = create_dispatch_request(
            self.paths,
            pressure_event_id="PE-docs-3",
            tools_root=self.tools_dir,
            prepare_worktree=True,
            acknowledge=True,
        )
        wrong = self.repo / "not-the-worktree"
        wrong.mkdir()
        claim = claim_assignment(
            assignment_id=request["assignment_id"],
            agent_id="phase3-test-worker",
            base_dir=self.tools_dir,
        )
        rejected = submit_worker_result(
            from_worktree=wrong,
            assignment_id=request["assignment_id"],
            tools_root=self.tools_dir,
            lease_token=claim["lease_token"],
        )
        self.assertEqual(rejected["reason"], "worktree_path_mismatch")

        worktree = Path(request["worktree_path"])
        (worktree / "docs" / "note.md").write_text("three\n", encoding="utf-8")
        subprocess.run(["git", "add", "docs/note.md"], cwd=worktree, check=True)
        subprocess.run(["git", "commit", "-m", "fix docs", "-m", "Addresses-Pressure: PE-docs-3"], cwd=worktree, text=True, capture_output=True, check=True)
        submit_worker_result(
            from_worktree=worktree,
            assignment_id=request["assignment_id"],
            tools_root=self.tools_dir,
            lease_token=claim["lease_token"],
        )
        verified = verify_worker_result(assignment_id=request["assignment_id"], tools_root=self.tools_dir)
        self.assertEqual(verified["status"], "failed")
        self.assertIn("trailer_mismatch", verified["failures"])

    def _pressure(self, event_id: str, ref: str, *, subtype: str = "missing docs check") -> dict[str, object]:
        return {
            "$schema": "aria/pressure-event/v2",
            "event_id": event_id,
            "cycle_id": None,
            "primitive": "REPETITION",
            "subtype": subtype,
            "capability_gap_key": "docs:evidence_gap:md",
            "magnitude": 3,
            "threshold": 3,
            "exceeds_threshold": True,
            "evidence_refs": [ref],
            "feedback_event_ids": [],
            "legacy_feedback_event_ids": [],
            "legacy_event_ids": [],
            "evidence_fingerprint": f"sha256:{event_id}",
            "detected_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
            "drives": ["skill_birth"],
            "schema_version": 2,
        }

    def _git(self, *args: str) -> subprocess.CompletedProcess[str]:
        return subprocess.run(["git", *args], cwd=self.repo, text=True, capture_output=True, check=True)


if __name__ == "__main__":
    unittest.main()
