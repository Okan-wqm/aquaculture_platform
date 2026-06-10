from __future__ import annotations

import argparse
import subprocess
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

from aria_kernel.agent_satisfaction import agent_satisfaction_scan
from aria_kernel.feedback import add_feedback, build_feedback_event
from aria_kernel.ledger import append_declared_jsonl, read_jsonl
from aria_kernel.pressure import effective_workspace_pressures
from aria_kernel.reverify import reverify_pressures
from aria_kernel.telemetry import export_telemetry
from aria_kernel.tool_registry import ensure_tools_binding
from aria_kernel.trailer_scan import git_trailer_scan
from aria_kernel.trust import trust_escalation_derive
from aria_kernel.workspace import ensure_workspace, record_workspace_governance, workspace_paths


class Phase2RemainingTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.repo = Path(self.tmp.name) / "repo"
        self.repo.mkdir()
        self._git("init")
        self._git("config", "user.email", "aria@example.test")
        self._git("config", "user.name", "ARIA Test")
        (self.repo / "src").mkdir()
        (self.repo / "src" / "a.ts").write_text("one\n", encoding="utf-8")
        self._git("add", "src/a.ts")
        self._git("commit", "-m", "initial")
        self.initial_sha = self._git("rev-parse", "HEAD").stdout.strip()
        self.workspace_base = Path(self.tmp.name) / "workspaces"
        self.paths = workspace_paths(self.repo, self.workspace_base)
        ensure_workspace(self.paths)
        self.tools_dir = ensure_tools_binding(Path(self.tmp.name) / "aria-tools", workspace_root=self.repo)

    def tearDown(self):
        self.tmp.cleanup()

    def test_git_trailer_closes_pressure_without_manual_threshold(self):
        append_declared_jsonl(self.tools_dir / "cycles.jsonl", {"schema_version": 2, "cycle_id": "cyc-prev", "event": "completed", "git_head_sha_at_cycle": self.initial_sha}, expected_surface="cycles")
        append_declared_jsonl(self.paths.ledgers["pressure"], self._pressure("PE-trailer"), expected_surface="workspace_memory_pressure")
        (self.repo / "src" / "a.ts").write_text("two\n", encoding="utf-8")
        self._git("add", "src/a.ts")
        self._git("commit", "-m", "fix pressure", "-m", "Closes-Pressure: PE-trailer")

        result = git_trailer_scan(self.paths, cycle_id="cyc-now", tools_root=self.tools_dir)

        self.assertEqual(result["closed_count"], 1)
        pressure = effective_workspace_pressures(self.paths)[0]
        self.assertEqual(pressure["effective_state"], "closed")
        states = read_jsonl(self.paths.ledgers["pressure_state"])
        self.assertEqual(states[-1]["reason"], "commit_trailer_closed")
        kinds = [row["kind"] for row in read_jsonl(self.paths.ledgers["governance"])]
        self.assertIn("pressure_closed_via_trailer", kinds)

    def test_git_trailer_ignored_classification_for_unknown_and_comma(self):
        append_declared_jsonl(self.tools_dir / "cycles.jsonl", {"schema_version": 2, "cycle_id": "cyc-prev", "event": "completed", "git_head_sha_at_cycle": self.initial_sha}, expected_surface="cycles")
        append_declared_jsonl(self.paths.ledgers["pressure"], self._pressure("PE-known"), expected_surface="workspace_memory_pressure")
        (self.repo / "src" / "a.ts").write_text("three\n", encoding="utf-8")
        self._git("add", "src/a.ts")
        self._git("commit", "-m", "bad trailers", "-m", "Closes-Pressure: PE-known, PE-other\nAddresses-Pressure: PE-missing")

        result = git_trailer_scan(self.paths, cycle_id="cyc-now", tools_root=self.tools_dir)

        self.assertEqual(result["ignored_count"], 2)
        ignored = [row for row in read_jsonl(self.paths.ledgers["governance"]) if row["kind"] == "pressure_trailer_ignored"]
        self.assertEqual({row["details"]["reason"] for row in ignored}, {"malformed_trailer", "unknown_pressure"})

    def test_agent_satisfaction_requires_address_evidence_and_tracks_removal(self):
        append_declared_jsonl(self.paths.ledgers["pressure"], self._pressure("PE-agent"), expected_surface="workspace_memory_pressure")
        agent_path = self.repo / ".claude" / "agents" / "aria-test.md"
        agent_path.parent.mkdir(parents=True)
        agent_path.write_text("---\nname: aria-test\naddresses_pressure: [PE-agent]\n---\nbody\n", encoding="utf-8")

        first = agent_satisfaction_scan(self.paths, cycle_id="cyc-one", tools_root=self.tools_dir)
        self.assertEqual(first["satisfied_count"], 0)
        record_workspace_governance(
            self.paths,
            "pressure_addresses_recorded",
            {
                "pressure_event_id": "PE-agent",
                "commit_sha": self.initial_sha,
                "trailer_kind": "Addresses-Pressure",
                "changed_files": [".claude/agents/aria-test.md"],
                "cycle_id": "cyc-one",
            },
        )
        second = agent_satisfaction_scan(self.paths, cycle_id="cyc-two", tools_root=self.tools_dir)
        self.assertEqual(second["satisfied_count"], 1)
        self.assertEqual(effective_workspace_pressures(self.paths)[0]["effective_state"], "satisfied")

        agent_path.unlink()
        third = agent_satisfaction_scan(self.paths, cycle_id="cyc-three", tools_root=self.tools_dir)
        self.assertEqual(third["removed_count"], 1)
        self.assertEqual(effective_workspace_pressures(self.paths)[0]["effective_state"], "satisfied")

    def test_feedback_evidence_chain_observed_commit_and_trust(self):
        head = self._git("rev-parse", "HEAD").stdout.strip()
        for source, ref in (("operator", "src/a.ts:1"), ("external_scanner", "src/a.ts:2"), ("ai_judge", "src/a.ts:3")):
            args = argparse.Namespace(
                kind="unknown_capability",
                summary=f"{source} saw gap",
                ref=ref,
                concept="gap",
                source=source,
                surface="backend",
                failure_mode="evidence_gap",
                parser_kind="ts",
                capability_gap_key="backend:evidence_gap:ts",
                cycle_id=None,
                evidence_ref=[],
                evidence_chain=['{"source_type":"operator","reference":"review","trust_level":"medium"}'],
            )
            event = build_feedback_event(args, paths=self.paths)
            self.assertEqual(event["observed_commit"], head)
            add_feedback(self.paths, event)

        result = trust_escalation_derive(self.paths, cycle_id="cyc-trust")
        self.assertEqual(result["escalated_count"], 1)
        pressure = effective_workspace_pressures(self.paths)[0]
        self.assertTrue(pressure["trusted_effective"])

    def test_reverify_and_telemetry_export(self):
        old = (datetime.now(timezone.utc) - timedelta(days=120)).isoformat().replace("+00:00", "Z")
        append_declared_jsonl(
            self.paths.ledgers["missed_signals"],
            {
                "$schema": "aria/feedback-event/v2",
                "event_id": "FB-old",
                "kind": "missed_signal",
                "source": "operator",
                "refs": ["src/missing.ts:1"],
                "summary": "old missing ref",
                "capability_gap_key": "backend:evidence_gap:ts",
                "failure_mode": "evidence_gap",
                "evidence_refs": [],
                "evidence_chain": [],
                "observed_commit": self.initial_sha,
                "trusted": False,
                "legacy_event_ids": [],
                "created_at": old,
                "schema_version": 2,
            },
            expected_surface="workspace_memory_missed_signals",
        )
        append_declared_jsonl(
            self.paths.ledgers["pressure"],
            self._pressure("PE-reverify", feedback_ids=["FB-old"], detected_at=datetime.now(timezone.utc) - timedelta(days=100)),
            expected_surface="workspace_memory_pressure",
        )
        record_workspace_governance(
            self.paths,
            "ref_stale_detected",
            {"feedback_event_id": "FB-old", "ref": "src/missing.ts:1", "status": "missing", "observed_commit": self.initial_sha},
        )

        dry = reverify_pressures(self.paths, sample_rate=1, dry_run=True)
        self.assertEqual(dry["actions"][0]["action"], "archive")
        self.assertFalse((self.paths.state_dir / "reverify_cursor.json").exists())
        applied = reverify_pressures(self.paths, sample_rate=1, dry_run=False, apply=True, acknowledge=True, reason="test")
        self.assertEqual(applied["actions"][0]["action"], "archive")
        self.assertTrue((self.paths.state_dir / "reverify_cursor.json").exists())
        self.assertIn("aria_pressure_count", export_telemetry(self.paths, format="prometheus"))

    def _pressure(self, event_id: str, feedback_ids: list[str] | None = None, detected_at: datetime | None = None) -> dict[str, object]:
        detected_at = detected_at or datetime.now(timezone.utc)
        return {
            "$schema": "aria/pressure-event/v2",
            "event_id": event_id,
            "cycle_id": None,
            "primitive": "UNKNOWN",
            "subtype": "fixture",
            "capability_gap_key": "backend:evidence_gap:ts",
            "magnitude": 3,
            "threshold": 3,
            "exceeds_threshold": True,
            "evidence_refs": [],
            "feedback_event_ids": feedback_ids or [],
            "legacy_feedback_event_ids": [],
            "legacy_event_ids": [],
            "evidence_fingerprint": f"sha256:{event_id}",
            "detected_at": detected_at.isoformat().replace("+00:00", "Z"),
            "drives": ["skill_birth"],
            "schema_version": 2,
        }

    def _git(self, *args: str) -> subprocess.CompletedProcess[str]:
        return subprocess.run(["git", *args], cwd=self.repo, text=True, capture_output=True, check=True)


if __name__ == "__main__":
    unittest.main()
