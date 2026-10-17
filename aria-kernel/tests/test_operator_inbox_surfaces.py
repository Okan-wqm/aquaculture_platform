"""ARIA-MEDIUM-127 — the operator inbox is served by one CLI verb and one MCP read tool, the same payload.

Kept apart from ``test_operator_inbox.py`` on purpose: this module parses the
CLI's JSON output, and a module that also seeds dated waiver manifests would
read as a waiver gate with a parser of its own
(``test_deadlines.UnregisteredWaiverManifests``). The checkout here holds no
waiver manifest, so the waiver section is read and empty.
"""
from __future__ import annotations

import io
import json
import tempfile
import unittest
from contextlib import redirect_stdout
from datetime import datetime, timezone
from pathlib import Path
from unittest import mock

from aria_kernel.human_required import record_human_required
from aria_kernel.tool_registry import ensure_tools_dir


class OperatorInboxSurfaceTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory(prefix="aria-inbox-surface-")
        self.addCleanup(self.tmp.cleanup)
        self.tools = ensure_tools_dir(Path(self.tmp.name) / "aria-tools")
        self.workspace = Path(self.tmp.name) / "checkout"
        self.workspace.mkdir()
        recorded = datetime(2026, 10, 16, 12, 0, tzinfo=timezone.utc)
        for request_id in ("AIR-one", "AIR-two", "AIR-three"):
            record_human_required(request_id=request_id, severity="HIGH", reason=f"why {request_id}",
                                  context={"kind": "anchor_stale"}, base_dir=self.tools, now=recorded)
        missions = mock.patch("aria_kernel.mission.list_open_missions", return_value=[])
        missions.start()
        self.addCleanup(missions.stop)

    def _cli(self, *argv: str) -> str:
        from aria_kernel.cli import main

        out = io.StringIO()
        with redirect_stdout(out):
            code = main(["operator", "inbox", "--tools-dir", str(self.tools), "--workspace-root", str(self.workspace),
                         *argv])
        self.assertEqual(code, 0)
        return out.getvalue()

    def test_the_cli_verb_and_the_mcp_read_tool_serve_the_inbox(self) -> None:
        from aria_kernel.mcp_server import READ_TOOLS, TOOL_MANIFEST, AriaMcpServer

        payload = json.loads(self._cli("--json"))
        self.assertEqual(payload["schema"], "aria/operator-inbox/v1")
        self.assertEqual(payload["undecided"], [])
        self.assertEqual(payload["sections"]["human_required"]["open"], 3)
        self.assertEqual(payload["sections"]["waivers"]["items"], [], "no manifest in the checkout: read, and empty")
        self.assertIn("HUMAN_REQUIRED: 3 open, 0 escalated by the panel", self._cli())
        self.assertIn("operator_inbox", READ_TOOLS)
        self.assertIn("operator_inbox", TOOL_MANIFEST)
        server = AriaMcpServer(base_dir=self.tools, workspace_root=self.workspace)
        served = server._operator_inbox({"limit": 2})
        self.assertEqual(served["sections"]["human_required"]["open"], 3)
        self.assertEqual(len(served["sections"]["human_required"]["items"]), 2, "the limit bounds items")
        with self.assertRaises(ValueError):
            server._operator_inbox({"limit": 0})
        called = server.call_tool("operator_inbox", {})
        self.assertFalse(called["isError"])
        self.assertEqual(json.loads(called["content"][0]["text"])["sections"]["human_required"]["open"], 3)

    def test_reading_the_inbox_writes_nothing(self) -> None:
        from aria_kernel.operator_inbox import read_operator_inbox

        before = {p: p.read_bytes() for p in sorted(Path(self.tmp.name).rglob("*")) if p.is_file()}
        read_operator_inbox(tools_dir=self.tools, workspace_root=self.workspace)
        after = {p: p.read_bytes() for p in sorted(Path(self.tmp.name).rglob("*")) if p.is_file()}
        self.assertEqual(after, before)


if __name__ == "__main__":
    unittest.main()
