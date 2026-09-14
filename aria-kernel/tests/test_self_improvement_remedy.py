"""ARIA-MEDIUM-128 — the mission opener routes a signal by its REMEDY, not by its priority alone.

CONFIRMED on a throwaway store over the lane tree: five registry findings 30
days past their deadline and one quarantined MCP server; night after night
`open_self_improvement_missions` spent its three slots on
`deadline_due:registry_finding:*` rows (`deadline_due` sorts before
`mcp_quarantine` at priority 2) and the quarantined server never got a
mission. The minted missions carried `propose_self_change` — a contract that
can only name a change under `SELF_CHANGE_ALLOWED_PREFIXES` — for a repo
finding and an operator SLA, and each accepted answer would have minted a
HUMAN_REQUIRED adjudication that itself becomes a `human_required_sla` row.
On the live checkout 132 registry rows have lapsed, so the starvation was
permanent from the first `self_improve` tick.

These pins hold: a signal kind owns exactly one remedy (`SIGNAL_REMEDIES`),
`deadline_due` is ANNOUNCED and never minted, and an announced row cannot
take a slot from a self-change row beside it.
"""
from __future__ import annotations

import json
import subprocess
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest import mock

from aria_kernel import deadlines, mcp_client, self_improvement as si
from aria_kernel.human_required import record_human_required
from aria_kernel.mission import list_open_missions
from aria_kernel.tool_registry import GovernanceError, ensure_tools_dir


class _Store(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        root = Path(self._tmp.name)
        self.ws = root / "repo"
        self.ws.mkdir()
        subprocess.run(["git", "init", "-q", str(self.ws)], check=True)
        self.tools = ensure_tools_dir(root / "aria-tools")
        self.now = datetime.now(timezone.utc)
        manifest = deadlines.surface_waivers.waiver_manifest_path(self.ws)
        manifest.parent.mkdir(parents=True, exist_ok=True)
        manifest.write_text("{}", encoding="utf-8")

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def write_registry(self, findings: list[dict]) -> None:
        path = self.ws.joinpath(*deadlines.REGISTRY_FINDINGS_RELPATH)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("".join(json.dumps(row) + "\n" for row in findings), encoding="utf-8")

    def lapsed_registry(self, count: int) -> None:
        self.write_registry([
            {"id": f"X-MEDIUM-{n:03d}", "state": "OPEN", "severity": "MEDIUM", "deadline": (self.now - timedelta(days=30)).date().isoformat()}
            for n in range(count)
        ])

    def self_improvement_missions(self) -> list[dict]:
        return [m for m in list_open_missions(base_dir=self.tools) if m["source_kind"] == si.SELF_IMPROVEMENT_SOURCE_KIND]


class RemedyVocabulary(unittest.TestCase):
    def test_every_kind_owns_exactly_one_closed_remedy(self) -> None:
        self.assertEqual(tuple(si.SIGNAL_REMEDIES), si.SIGNAL_KINDS)
        self.assertEqual(set(si.SIGNAL_REMEDIES.values()), {si.SELF_CHANGE_REMEDY, si.ANNOUNCE_REMEDY})
        self.assertEqual(si.SELF_CHANGE_SIGNAL_KINDS, ("capability_gap", "funnel_stall", "delivery_slo_gap", "mcp_quarantine", "doctor_fail"))
        self.assertEqual(si.SIGNAL_REMEDIES["deadline_due"], si.ANNOUNCE_REMEDY)
        self.assertEqual(si.Signal("deadline_due", "registry_finding:X-LOW-001", "t").remedy, si.ANNOUNCE_REMEDY)
        self.assertEqual(si.Signal("mcp_quarantine", "context7", "t").to_dict()["remedy"], si.SELF_CHANGE_REMEDY)

    def test_a_kind_without_a_remedy_cannot_be_built(self) -> None:
        with self.assertRaises(GovernanceError) as refused:
            si.Signal("registry_finding", "X-LOW-001", "t")
        self.assertEqual(str(refused.exception), "signal_kind_unknown:registry_finding")

    def test_the_opener_orders_by_remedy_before_priority(self) -> None:
        announced = si.Signal("deadline_due", "registry_finding:A-LOW-001", "t", priority=1)
        quarantine = si.Signal("mcp_quarantine", "context7", "t", priority=2)
        fault = si.Signal("doctor_fail", "queue", "t", priority=1)
        self.assertEqual(si.self_change_signals([announced, quarantine, fault]), [fault, quarantine])


class OpenerRouting(_Store):
    def test_lapsed_registry_rows_do_not_starve_a_quarantined_server(self) -> None:
        self.lapsed_registry(5)
        with mock.patch.object(mcp_client, "quarantined_servers", return_value=frozenset({"context7"})):
            signals = si.scan_signals(base_dir=self.tools, workspace_root=self.ws)
            self.assertEqual(sum(1 for s in signals if s.kind == "deadline_due"), 5, "the rows are still announced by the scan")
            opened = si.open_self_improvement_missions(base_dir=self.tools, workspace_root=self.ws, max_new=3)
        self.assertEqual([(o["signal"], o["key"], o["idempotent"]) for o in opened], [("mcp_quarantine", "context7", False)])
        self.assertEqual([m["source_id"] for m in self.self_improvement_missions()], ["mcp_quarantine:context7"])

    def test_a_deadline_due_signal_never_becomes_a_propose_self_change_mission(self) -> None:
        self.lapsed_registry(2)
        record_human_required(request_id="AIR-late", severity="HIGH", reason="late", base_dir=self.tools, now=self.now - timedelta(days=5))
        signals = si.scan_signals(base_dir=self.tools, workspace_root=self.ws)
        keys = {s.key for s in signals if s.kind == "deadline_due"}
        self.assertEqual(keys, {"registry_finding:X-MEDIUM-000", "registry_finding:X-MEDIUM-001", "human_required_sla:AIR-late"})
        for _night in range(3):
            si.open_self_improvement_missions(base_dir=self.tools, workspace_root=self.ws, max_new=3)
        for mission in self.self_improvement_missions():
            self.assertFalse(str(mission["source_id"]).startswith("deadline_due:"), mission)
            self.assertNotIn(mission["source_id"], {f"deadline_due:{key}" for key in keys})
        # The lapsed SLA is a FAULT: it still reaches the opener as the
        # `deadlines` organ's own FAIL, which IS a self-change contract.
        self.assertIn("doctor_fail:deadlines", [m["source_id"] for m in self.self_improvement_missions()])


if __name__ == "__main__":
    unittest.main()
