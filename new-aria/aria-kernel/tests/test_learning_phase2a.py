from __future__ import annotations

import json
import os
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

from aria_kernel.learning import LEARNING_HOOK_ORDER, load_decay_thresholds, run_learning_pass
from aria_kernel.ledger import LedgerIntegrityError, read_jsonl
from aria_kernel.pressure import effective_workspace_pressures
from aria_kernel.tool_registry import ensure_tools_binding
from aria_kernel.workspace import ensure_workspace, workspace_paths
from tests._helpers.declared_fixtures import append_declared_fixture


class LearningPhase2ATests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.repo = Path(self.tmp.name) / "repo"
        self.repo.mkdir()
        self.workspace_base = Path(self.tmp.name) / "workspaces"
        self.paths = workspace_paths(self.repo, self.workspace_base)
        ensure_workspace(self.paths)
        self.tools_dir = ensure_tools_binding(Path(self.tmp.name) / "aria-tools", workspace_root=self.repo)

    def tearDown(self):
        self.tmp.cleanup()

    def test_learning_pass_hook_order_and_decay_idempotency(self):
        now = datetime(2026, 5, 5, tzinfo=timezone.utc)
        append_declared_fixture(
            self.paths.ledgers["pressure"],
            self._pressure("PE-old", now - timedelta(days=190)),
            expected_surface="workspace_memory_pressure",
        )

        first = run_learning_pass(self.paths, cycle_id="cyc-20260505T000000Z", tools_root=self.tools_dir, now=now)
        self.assertEqual([row["hook_name"] for row in first["hooks"]], list(LEARNING_HOOK_ORDER))
        self.assertTrue(all(row["status"] == "ok" for row in first["hooks"]))
        self.assertEqual(first["hooks"][0]["result"]["transition_count"], 1)

        states = read_jsonl(self.paths.ledgers["pressure_state"])
        self.assertEqual(len(states), 1)
        self.assertEqual(states[0]["to_state"], "sleeping")
        governance = read_jsonl(self.paths.ledgers["governance"])
        self.assertEqual([row["kind"] for row in governance if row["kind"] == "pressure_decayed"][-1], "pressure_decayed")

        second = run_learning_pass(self.paths, cycle_id="cyc-20260505T000001Z", tools_root=self.tools_dir, now=now)
        self.assertEqual(second["hooks"][0]["result"]["transition_count"], 0)
        self.assertEqual(len(read_jsonl(self.paths.ledgers["pressure_state"])), 1)

    def test_decay_threshold_override_changes_effective_transition(self):
        now = datetime(2026, 5, 5, tzinfo=timezone.utc)
        config = self.paths.workspace_root / "aria-config" / "decay_thresholds.json"
        config.parent.mkdir(parents=True)
        config.write_text(
            json.dumps({"faded": "1d", "sleeping": "2d", "archived": "30d"}) + "\n",
            encoding="utf-8",
        )
        append_declared_fixture(
            self.paths.ledgers["pressure"],
            self._pressure("PE-override", now - timedelta(days=2)),
            expected_surface="workspace_memory_pressure",
        )

        self.assertEqual(load_decay_thresholds(self.paths)["sleeping"], 2)
        run_learning_pass(self.paths, cycle_id="cyc-20260505T000000Z", tools_root=self.tools_dir, now=now)
        pressure = effective_workspace_pressures(self.paths, now=now, decay_thresholds=load_decay_thresholds(self.paths))[0]
        self.assertEqual(pressure["effective_state"], "sleeping")
        self.assertEqual(read_jsonl(self.paths.ledgers["pressure_state"])[0]["details"]["decay_thresholds"]["faded"], 1)

    def test_terminal_pressures_do_not_decay(self):
        now = datetime(2026, 5, 5, tzinfo=timezone.utc)
        append_declared_fixture(
            self.paths.ledgers["pressure"],
            self._pressure("PE-closed", now - timedelta(days=400)),
            expected_surface="workspace_memory_pressure",
        )
        append_declared_fixture(
            self.paths.ledgers["pressure_state"],
            {
                "$schema": "aria/pressure-state-event/v1",
                "event_id": "PSE-closed",
                "pressure_event_id": "PE-closed",
                "from_state": "active",
                "to_state": "closed",
                "reason": "manual",
                "cycle_id": None,
                "ts": now.isoformat().replace("+00:00", "Z"),
                "actor": {"kind": "test", "id": "test"},
                "evidence_refs": ["manual:closed"],
                "feedback_event_ids": [],
                "details": {},
                "schema_version": 1,
            },
            expected_surface="workspace_memory_pressure_state",
        )

        result = run_learning_pass(self.paths, cycle_id="cyc-20260505T000000Z", tools_root=self.tools_dir, now=now)
        self.assertEqual(result["hooks"][0]["result"]["transition_count"], 0)
        self.assertEqual(read_jsonl(self.paths.ledgers["pressure_state"])[0]["to_state"], "closed")

    def test_hook_failure_records_governance_and_continues(self):
        now = datetime(2026, 5, 5, tzinfo=timezone.utc)
        config = self.paths.workspace_root / "aria-config" / "decay_thresholds.json"
        config.parent.mkdir(parents=True)
        config.write_text("{not-json\n", encoding="utf-8")
        old_cycle = self.paths.cycle_dir / "cyc-20240101T000000Z.json"
        old_cycle.write_text("{}\n", encoding="utf-8")

        result = run_learning_pass(self.paths, cycle_id="cyc-20260505T000000Z", tools_root=self.tools_dir, now=now)
        self.assertEqual(result["hooks"][0]["status"], "failed")
        self.assertEqual(result["hooks"][1]["status"], "ok")
        self.assertFalse(old_cycle.exists())
        kinds = [row["kind"] for row in read_jsonl(self.paths.ledgers["governance"])]
        self.assertIn("learning_hook_failed", kinds)
        self.assertIn("cycle_artifact_archived", kinds)

    def test_integrity_failure_aborts_before_hooks(self):
        now = datetime(2026, 5, 5, tzinfo=timezone.utc)
        append_declared_fixture(
            self.paths.ledgers["pressure"],
            self._pressure("PE-tampered", now),
            expected_surface="workspace_memory_pressure",
        )
        payload = self.paths.ledgers["pressure"].read_text(encoding="utf-8")
        self.paths.ledgers["pressure"].write_text(payload.replace("PE-tampered", "PE-mutated"), encoding="utf-8")

        with self.assertRaises(LedgerIntegrityError):
            run_learning_pass(self.paths, cycle_id="cyc-20260505T000000Z", tools_root=self.tools_dir, now=now)
        kinds = [row["kind"] for row in read_jsonl(self.paths.ledgers["governance"])]
        self.assertNotIn("learning_hook_failed", kinds)

    def test_artifact_prune_archives_only_non_ledger_cycle_artifacts(self):
        now = datetime(2026, 5, 5, tzinfo=timezone.utc)
        old_workspace_cycle = self.paths.cycle_dir / "cyc-20240101T000000Z.json"
        old_workspace_cycle.write_text('{"cycle_id":"cyc-20240101T000000Z"}\n', encoding="utf-8")
        recent_workspace_cycle = self.paths.cycle_dir / "cyc-20260501T000000Z.json"
        recent_workspace_cycle.write_text("{}\n", encoding="utf-8")
        old_discovery = self.tools_dir / "discovery" / "not-timestamped-old-cycle"
        old_discovery.mkdir(parents=True)
        (old_discovery / "COMPLETION_PROOF.json").write_text("{}\n", encoding="utf-8")
        old_mtime = datetime(2024, 1, 1, tzinfo=timezone.utc).timestamp()
        os.utime(old_discovery, (old_mtime, old_mtime))
        cycles_ledger = self.tools_dir / "cycles.jsonl"
        cycles_ledger.write_text("", encoding="utf-8")

        result = run_learning_pass(self.paths, cycle_id="cyc-20260505T000000Z", tools_root=self.tools_dir, now=now)
        prune = result["hooks"][1]["result"]
        self.assertEqual(prune["archived_count"], 2)
        self.assertFalse(old_workspace_cycle.exists())
        self.assertTrue(recent_workspace_cycle.exists())
        self.assertFalse(old_discovery.exists())
        self.assertTrue((self.paths.workspace_root / ".archive" / "2024" / "aria-state" / "cycles" / "cyc-20240101T000000Z.json").exists())
        self.assertTrue((self.tools_dir / ".archive" / "2024" / "discovery" / "not-timestamped-old-cycle").exists())
        self.assertTrue(cycles_ledger.exists())

    def test_vocabulary_reload_check_is_marker_based(self):
        now = datetime(2026, 5, 5, tzinfo=timezone.utc)
        run_learning_pass(self.paths, cycle_id="cyc-20260505T000000Z", tools_root=self.tools_dir, now=now)
        initial_count = sum(1 for row in read_jsonl(self.paths.ledgers["governance"]) if row["kind"] == "vocabulary_loaded")
        run_learning_pass(self.paths, cycle_id="cyc-20260505T000001Z", tools_root=self.tools_dir, now=now)
        self.assertEqual(sum(1 for row in read_jsonl(self.paths.ledgers["governance"]) if row["kind"] == "vocabulary_loaded"), initial_count)

        override = self.paths.workspace_root / "aria-config" / "failure_mode_vocabulary.json"
        override.parent.mkdir(parents=True, exist_ok=True)
        override.write_text(
            json.dumps({"$schema": "aria/failure-mode-vocab/v3", "modes": [{"id": "new_mode"}]}) + "\n",
            encoding="utf-8",
        )
        run_learning_pass(self.paths, cycle_id="cyc-20260505T000002Z", tools_root=self.tools_dir, now=now)
        self.assertEqual(sum(1 for row in read_jsonl(self.paths.ledgers["governance"]) if row["kind"] == "vocabulary_loaded"), initial_count + 1)

    def _pressure(self, event_id: str, detected_at: datetime) -> dict[str, object]:
        return {
            "$schema": "aria/pressure-event/v2",
            "event_id": event_id,
            "cycle_id": None,
            "primitive": "UNKNOWN",
            "subtype": "fixture",
            "capability_gap_key": "backend:schema_drift:ts",
            "magnitude": 3,
            "threshold": 3,
            "exceeds_threshold": True,
            "evidence_refs": [],
            "feedback_event_ids": [],
            "legacy_feedback_event_ids": [],
            "legacy_event_ids": [],
            "evidence_fingerprint": f"sha256:{event_id}",
            "detected_at": detected_at.isoformat().replace("+00:00", "Z"),
            "drives": ["adapter_birth"],
            "schema_version": 2,
        }


if __name__ == "__main__":
    unittest.main()
