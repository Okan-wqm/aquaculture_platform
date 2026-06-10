from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from aria_kernel.capability_gap import detect_capability_gaps
from aria_kernel.genesis_policy import OVERRIDE_RELPATH
from aria_kernel.learning import _skill_or_agent_genesis
from aria_kernel.ledger import append_jsonl as _append_jsonl, load_jsonl
from aria_kernel.tool_registry import ensure_tools_dir
from aria_kernel.workspace import ensure_workspace, workspace_paths


def append_jsonl(path, record):
    return _append_jsonl(path, record, test_fixture=True)


class GenesisHookTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.repo = Path(self.tmp.name) / "repo"
        self.repo.mkdir()
        self.tools_dir = ensure_tools_dir(Path(self.tmp.name) / "aria-tools")
        self.paths = workspace_paths(self.repo, Path(self.tmp.name) / "workspaces")
        ensure_workspace(self.paths)

    def tearDown(self):
        self.tmp.cleanup()

    def _seed_pressure(self, event_id: str, capability_gap_key: str) -> None:
        append_jsonl(
            self.paths.ledgers["pressure"],
            {
                "$schema": "aria/pressure-event/v2",
                "schema_version": 2,
                "event_id": event_id,
                "primitive": "REPETITION",
                "subtype": "missing routing",
                "capability_gap_key": capability_gap_key,
                "magnitude": 3,
                "threshold": 3,
                "exceeds_threshold": True,
                "evidence_refs": ["apps/farm-service/src/app.ts"],
                "feedback_event_ids": [],
                "detected_at": "2026-05-06T00:00:00Z",
            },
        )

    def _detect_gaps(self) -> None:
        # Drive the same path the cycle uses so capability gap rows exist.
        detect_capability_gaps(cycle_id="cyc-pre", paths=self.paths, base_dir=self.tools_dir)

    def _write_override(self, payload: dict) -> None:
        override_path = self.repo / OVERRIDE_RELPATH
        override_path.parent.mkdir(parents=True, exist_ok=True)
        override_path.write_text(json.dumps(payload), encoding="utf-8")

    def test_disabled_policy_skips_request_generation(self):
        self._seed_pressure("PE-1", "farm:routing:ts")
        self._detect_gaps()
        self._write_override({"enable_request_generation": False})
        result = _skill_or_agent_genesis(cycle_id="cyc-1", paths=self.paths, tools_root=self.tools_dir)
        self.assertEqual(result["status"], "skipped")
        self.assertEqual(result["reason"], "genesis_disabled")
        self.assertEqual(load_jsonl(self.tools_dir / "agent-genesis" / "requests.jsonl"), [])

    def test_enabled_policy_emits_request_for_actionable_gap(self):
        self._seed_pressure("PE-2", "farm:routing:ts")
        self._detect_gaps()
        result = _skill_or_agent_genesis(cycle_id="cyc-2", paths=self.paths, tools_root=self.tools_dir)
        self.assertEqual(result["status"], "ok")
        self.assertEqual(result["requested_count"], 1)
        rows = load_jsonl(self.tools_dir / "agent-genesis" / "requests.jsonl")
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["status"], "requested")
        self.assertEqual(rows[0]["capability_gap_key"], "farm:routing:ts")

    def test_dedup_skips_already_requested_keys(self):
        self._seed_pressure("PE-3", "farm:routing:ts")
        self._detect_gaps()
        first = _skill_or_agent_genesis(cycle_id="cyc-3a", paths=self.paths, tools_root=self.tools_dir)
        self.assertEqual(first["requested_count"], 1)
        second = _skill_or_agent_genesis(cycle_id="cyc-3b", paths=self.paths, tools_root=self.tools_dir)
        self.assertEqual(second["requested_count"], 0)
        self.assertEqual(second["skipped_already_requested"], 1)
        self.assertEqual(len(load_jsonl(self.tools_dir / "agent-genesis" / "requests.jsonl")), 1)

    def test_max_requests_per_cycle_caps_emission(self):
        for i in range(7):
            self._seed_pressure(f"PE-{i}", f"farm:k{i}")
        self._detect_gaps()
        self._write_override({"max_requests_per_cycle": 3})
        result = _skill_or_agent_genesis(cycle_id="cyc-cap", paths=self.paths, tools_root=self.tools_dir)
        self.assertEqual(result["status"], "ok")
        self.assertEqual(result["requested_count"], 3)
        self.assertGreaterEqual(result["capped_count"], 4)

    def test_existing_agent_extension_recorded_as_audit(self):
        # Append a capability gap row directly with gap_type="existing_agent_extension"
        # so the hook routes it to the extension-decisions.jsonl audit surface.
        # This isolates the hook routing logic from related_agents_for_paths detection.
        from aria_kernel.tool_registry import utc_now
        append_jsonl(
            self.tools_dir / "capability-gaps" / "gaps.jsonl",
            {
                "schema_version": 1,
                "recorded_at": utc_now(),
                "cycle_id": "cyc-pre",
                "gaps": [
                    {
                        "schema_version": 1,
                        "gap_id": "gap-ext-1",
                        "gap_type": "existing_agent_extension",
                        "capability_gap_key": "farm:ext",
                        "title": "extend farm-expert for new pattern",
                        "evidence_refs": ["apps/farm-service/src/app.ts"],
                        "related_existing_agents": ["farm-expert"],
                        "score": 80,
                        "blocked_by": [],
                        "primary_source": "pressure",
                        "source_types": ["pressure"],
                        "index_hash_at_decision": None,
                    }
                ],
            },
        )
        result = _skill_or_agent_genesis(cycle_id="cyc-ext", paths=self.paths, tools_root=self.tools_dir)
        ext_rows = load_jsonl(self.tools_dir / "agent-genesis" / "extension-decisions.jsonl")
        self.assertEqual(len(ext_rows), 1)
        self.assertEqual(ext_rows[0]["status"], "operator_review_required")
        self.assertEqual(ext_rows[0]["capability_gap_key"], "farm:ext")
        self.assertEqual(result["extension_audit_count"], 1)
        self.assertEqual(result["requested_count"], 0)


if __name__ == "__main__":
    unittest.main()
