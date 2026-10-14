"""agent_satisfaction_scan — per-agent containment on the READ side (ARIA-LOW-480).

The removals loop already ran under ``guard_item`` (ORPHAN-HIGH-575's
shape), but the scan itself did not: one truncated agent .md — an unclosed
frontmatter block — raised ``ValueError`` out of
``_parse_addresses_pressure`` and replaced the whole hook's report with a
failure naming neither the file nor the stage.

Containment alone is not enough. An agent that exists but cannot be read
this cycle is not REMOVED: reporting it as ``agent_removed`` and dropping
it from ``agent_index.json`` would trade the crash for a false audit row.
These tests pin both halves.
"""
from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from aria_kernel.agent_satisfaction import agent_satisfaction_scan
from aria_kernel.ledger import load_jsonl
from aria_kernel.workspace import ensure_workspace, workspace_paths

_TRUNCATED = "---\nname: truncated-agent\nnever closed..."


class AgentSatisfactionScanContainment(unittest.TestCase):
    def setUp(self) -> None:
        self._td = tempfile.TemporaryDirectory()
        repo = Path(self._td.name)
        self.agents = repo / ".claude" / "agents"
        self.agents.mkdir(parents=True)
        (self.agents / "good-agent.md").write_text(
            "---\nname: good-agent\n---\n# good agent\n", encoding="utf-8",
        )
        (self.agents / "another-good.md").write_text(
            "---\nname: another-good\n---\n# fine\n", encoding="utf-8",
        )
        self.paths = workspace_paths(repo, workspace_base=repo / "ws")
        ensure_workspace(self.paths)

    def tearDown(self) -> None:
        self._td.cleanup()

    def _index_rows(self) -> dict[str, dict]:
        index = self.paths.state_dir / "agent_index.json"
        return {row["path"]: row for row in json.loads(index.read_text(encoding="utf-8"))["agents"]}

    def test_a_truncated_agent_is_contained_and_named(self) -> None:
        (self.agents / "truncated-agent.md").write_text(_TRUNCATED, encoding="utf-8")
        report = agent_satisfaction_scan(self.paths, cycle_id="cyc-scan-1")
        failures = report.get("item_failures", [])
        self.assertEqual(len(failures), 1, msg=f"expected one named failure, got {report}")
        self.assertEqual(failures[0]["item_kind"], "agent_scan")
        self.assertEqual(failures[0]["item_id"], ".claude/agents/truncated-agent.md")
        self.assertIn("agent_frontmatter_unclosed", failures[0]["error_message"])
        rows = self._index_rows()
        self.assertEqual(
            sorted(rows), [".claude/agents/another-good.md", ".claude/agents/good-agent.md"],
        )
        self.assertEqual(report["indexed_count"], len(rows))

    def test_an_agent_unreadable_next_cycle_is_not_reported_removed(self) -> None:
        late = self.agents / "late-truncated.md"
        late.write_text("---\nname: late-truncated\n---\n# fine for now\n", encoding="utf-8")
        agent_satisfaction_scan(self.paths, cycle_id="cyc-scan-1")
        before = self._index_rows()[".claude/agents/late-truncated.md"]

        late.write_text(_TRUNCATED, encoding="utf-8")
        report = agent_satisfaction_scan(self.paths, cycle_id="cyc-scan-2")

        self.assertEqual(report["removed_count"], 0)
        removed = [
            row for row in load_jsonl(self.paths.ledgers["governance"])
            if row.get("kind") == "agent_removed"
        ]
        self.assertEqual(removed, [])
        rows = self._index_rows()
        self.assertEqual(rows[".claude/agents/late-truncated.md"]["content_sha256"], before["content_sha256"])
        self.assertEqual(report["indexed_count"], 3)

    def test_a_deleted_agent_is_still_reported_removed(self) -> None:
        gone = self.agents / "gone-agent.md"
        gone.write_text("---\nname: gone-agent\n---\n", encoding="utf-8")
        agent_satisfaction_scan(self.paths, cycle_id="cyc-scan-1")
        gone.unlink()
        report = agent_satisfaction_scan(self.paths, cycle_id="cyc-scan-2")
        self.assertEqual(report["removed_count"], 1)
        self.assertNotIn(".claude/agents/gone-agent.md", self._index_rows())


if __name__ == "__main__":
    unittest.main()
