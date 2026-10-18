"""ARIA-MEDIUM-127 — one surface lists every decision ARIA waits on the operator for.

Before: HUMAN_REQUIRED records, lapsing waivers and missions parked for a
person each lived behind their own ledger and verb, and no reader put them
together (502 HUMAN_REQUIRED records open on the live store, 2026-10-16).
The inbox reads each owner through its own reader, answers nothing itself,
names the command that answers each item, and names an unreadable source
instead of showing it empty.
"""
from __future__ import annotations

import json
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path
from unittest import mock

from aria_kernel.tool_registry import ensure_tools_dir

_NOW = datetime(2026, 11, 25, 12, 0, tzinfo=timezone.utc)


def _record(tools: Path, request_id: str, **fields: object) -> None:
    directory = tools / "human-required"
    directory.mkdir(parents=True, exist_ok=True)
    record = {
        "$schema": "aria/human-required/v1", "schema_version": "1", "request_id": request_id,
        "status": "open", "severity": "HIGH", "reason": f"why {request_id}",
        "recorded_at": "2026-11-01T00:00:00Z", "sla_deadline": "2026-12-01T00:00:00Z",
        "context": {"kind": "anchor_stale"},
    }
    record.update(fields)
    (directory / f"{request_id}.json").write_text(json.dumps(record), encoding="utf-8")


class OperatorInboxTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory(prefix="aria-inbox-")
        self.addCleanup(self.tmp.cleanup)
        self.tools = ensure_tools_dir(Path(self.tmp.name) / "aria-tools")
        _record(self.tools, "AIR-late", sla_deadline="2026-11-20T00:00:00Z")
        _record(self.tools, "AIR-panel", severity="CRITICAL", panel_disposition="escalate_operator",
                context={"kind": "consensus_escalation"})
        _record(self.tools, "AIR-later")
        _record(self.tools, "AIR-done", status="resolved")
        # A checkout holding one dated waiver manifest: lapsed, due inside the
        # warning window, and far away, read through the deadlines organ.
        self.workspace = Path(self.tmp.name) / "checkout"
        manifest = self.workspace / "aria-kernel" / "surface-reachability.unwritten.json"
        manifest.parent.mkdir(parents=True)
        manifest.write_text(json.dumps({"surface_x": {
            state: {"expires_on": day, "finding_id": "ORPHAN-HIGH-001", "owner": "okan", "reason": "r"}
            for state, day in (("LAPSED", "2026-11-10"), ("SOON", "2026-11-28"), ("FAR", "2027-03-01"))
        }}), encoding="utf-8")
        self.held = {"mission_id": "M-held", "state": "HUMAN_REQUIRED", "title": "decide", "next_action": "pick"}
        missions = mock.patch("aria_kernel.mission.list_open_missions", return_value=[
            self.held, {"mission_id": "M-busy", "state": "PLANNING", "title": "t", "next_action": "n"},
        ])
        missions.start()
        self.addCleanup(missions.stop)

    def _inbox(self, **kwargs):
        from aria_kernel.operator_inbox import read_operator_inbox

        return read_operator_inbox(tools_dir=self.tools, workspace_root=kwargs.pop("workspace_root", self.workspace),
                                   now=_NOW, **kwargs)

    def test_every_owner_is_listed_with_the_command_that_answers_it(self) -> None:
        inbox = self._inbox()
        self.assertEqual(inbox["schema"], "aria/operator-inbox/v1")
        self.assertEqual(inbox["undecided"], [])
        human = inbox["sections"]["human_required"]
        self.assertEqual((human["open"], human["escalated_by_panel"], human["sla_lapsed"]), (3, 1, 1))
        self.assertEqual(human["by_kind"], {"anchor_stale": 2, "consensus_escalation": 1})
        # The panel's escalation first, then soonest SLA first.
        self.assertEqual([item["request_id"] for item in human["items"]], ["AIR-panel", "AIR-late", "AIR-later"])
        self.assertEqual(human["items"][0]["answer"],
                         "aria-kernel human-required resolve --request-id AIR-panel --resolution-note '<decision>'")
        missions = inbox["sections"]["missions"]
        self.assertEqual(missions["held"], 1)
        self.assertEqual([item["mission_id"] for item in missions["items"]], ["M-held"])
        self.assertIn("aria-kernel mission transition --mission-id M-held", missions["items"][0]["answer"])
        waivers = inbox["sections"]["waivers"]
        self.assertEqual((waivers["lapsed"], waivers["due_soon"]), (1, 1))
        self.assertEqual([(item["key"], item["lapsed"]) for item in waivers["items"]],
                         [("surface_x.LAPSED", True), ("surface_x.SOON", False)])
        self.assertEqual(waivers["items"][0]["answer"],
                         "renew or remove surface_x.LAPSED in aria-kernel/surface-reachability.unwritten.json "
                         "through a reviewed PR")

    def test_an_unreadable_source_is_named_never_empty(self) -> None:
        inbox = self._inbox(workspace_root=None)
        self.assertEqual(inbox["undecided"], ["waivers:checkout_unbound"])
        self.assertNotIn("waivers", inbox["sections"])
        with mock.patch("aria_kernel.mission.list_open_missions", side_effect=OSError("disk")):
            inbox = self._inbox()
        self.assertEqual(inbox["undecided"], ["missions:OSError"])
        self.assertIn("human_required", inbox["sections"], "the other owners are still read")
        from aria_kernel.operator_inbox import render_operator_inbox

        self.assertIn("UNDECIDED missions:OSError", render_operator_inbox(inbox))

    def test_the_limit_bounds_items_never_counts(self) -> None:
        inbox = self._inbox(limit=1)
        human = inbox["sections"]["human_required"]
        self.assertEqual((human["open"], len(human["items"])), (3, 1))
        with self.assertRaises(ValueError):
            self._inbox(limit=0)


if __name__ == "__main__":
    unittest.main()
