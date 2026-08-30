"""X4 (ORPHAN-699) — bounded panel re-open + SLA tier ladder.

The mint-once rule stays true for LIVE panels (the existing
one-panel-ever pin keeps passing untouched); what changes is the dead
end: a panel whose every envelope is terminally dead may be re-opened
at most MAX_PANEL_REOPENS times, after which the sweep discloses
exhaustion — the honest "a human genuinely must act" terminal.
"""
from __future__ import annotations

import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import patch

from aria_kernel.human_required import record_human_required
from aria_kernel.human_required_adjudication import (
    MAX_PANEL_REOPENS,
    _panel_is_terminally_dead,
    _panel_rows_for,
    sweep_human_required_adjudications,
)
from aria_kernel.tool_registry import ensure_tools_dir


class ReopenTests(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory(prefix="aria-x4-")
        self.tools = Path(self._tmp.name) / "aria-tools"
        ensure_tools_dir(self.tools)
        record_human_required(
            request_id="req-dead-001",
            reason="lease lifecycle exhausted requeues for request req-dead-001",
            context={"kind": "lease_lifecycle"},
            base_dir=self.tools,
        )

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def test_dead_panel_reopens_with_lineage(self) -> None:
        first = sweep_human_required_adjudications(base_dir=self.tools)
        self.assertEqual(first["opened"], ["req-dead-001"])
        with patch(
            "aria_kernel.agent_invocations.derive_request_state",
            return_value="ANCHOR_STALE",
        ):
            second = sweep_human_required_adjudications(base_dir=self.tools)
        self.assertEqual(second["reopened"], ["req-dead-001"])
        rows = _panel_rows_for(self.tools, "req-dead-001")
        self.assertEqual(len(rows), 2)
        self.assertEqual(rows[-1]["attempt"], 2)
        self.assertEqual(rows[-1]["reopen_of"], rows[0].get("ledger_hash"))

    def test_reopen_budget_exhausts_with_disclosure(self) -> None:
        sweep_human_required_adjudications(base_dir=self.tools)
        with patch(
            "aria_kernel.agent_invocations.derive_request_state",
            return_value="ANCHOR_STALE",
        ):
            for _ in range(MAX_PANEL_REOPENS):
                sweep_human_required_adjudications(base_dir=self.tools)
            exhausted = sweep_human_required_adjudications(base_dir=self.tools)
        self.assertEqual(exhausted["reopen_exhausted"], ["req-dead-001"])
        self.assertEqual(exhausted["reopened"], [])
        rows = _panel_rows_for(self.tools, "req-dead-001")
        self.assertEqual(len(rows), 1 + MAX_PANEL_REOPENS)
        governance = (self.tools / "governance.jsonl").read_text(encoding="utf-8")
        self.assertIn("human_required_adjudication_reopen_exhausted", governance)

    def test_live_envelope_blocks_reopen(self) -> None:
        # Fresh envelopes are PENDING — the one-panel-ever discipline holds.
        sweep_human_required_adjudications(base_dir=self.tools)
        again = sweep_human_required_adjudications(base_dir=self.tools)
        self.assertEqual(again["reopened"], [])
        self.assertEqual(len(_panel_rows_for(self.tools, "req-dead-001")), 1)

    def test_rejected_member_panel_reopens(self) -> None:
        # ORPHAN-715: submit rejection is terminal (the envelope is
        # unclaimable afterwards), so a panel whose members were all
        # rejected — the pre-#1271 evidence-law contradiction produced
        # exactly that — must be reopenable instead of wedging forever.
        sweep_human_required_adjudications(base_dir=self.tools)
        with patch(
            "aria_kernel.agent_invocations.derive_request_state",
            return_value="REJECTED",
        ):
            second = sweep_human_required_adjudications(base_dir=self.tools)
        self.assertEqual(second["reopened"], ["req-dead-001"])

    def test_non_incomplete_fold_reason_never_reopens(self) -> None:
        # A panel that folded for independence/split reasons carries live
        # judge work; re-opening would discard it.
        self.assertFalse(
            _panel_is_terminally_dead(
                self.tools,
                escalation_request_id="req-dead-001",
                verdict_reason="panel_not_independent:shared_principal",
            )
        )


class SlaTierTests(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory(prefix="aria-x4-sla-")
        self.tools = Path(self._tmp.name) / "aria-tools"
        ensure_tools_dir(self.tools)

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def test_breach_age_sets_escalation_tier(self) -> None:
        from aria_kernel.reflection import _human_required_summary

        record_human_required(
            request_id="req-old-001",
            reason="ancient escalation for tier arithmetic",
            context={"kind": "lease_lifecycle"},
            base_dir=self.tools,
        )
        # rewrite the record's timestamps: window = 1h, breached 6 windows ago
        record_path = self.tools / "human-required" / "req-old-001.json"
        import json

        payload = json.loads(record_path.read_text(encoding="utf-8"))
        now = datetime.now(timezone.utc)
        payload["recorded_at"] = (now - timedelta(hours=7)).strftime("%Y-%m-%dT%H:%M:%SZ")
        payload["sla_deadline"] = (now - timedelta(hours=6)).strftime("%Y-%m-%dT%H:%M:%SZ")
        record_path.write_text(json.dumps(payload), encoding="utf-8")

        summary = _human_required_summary(self.tools)
        self.assertEqual(summary["breaching_sla"], 1)
        self.assertEqual(summary["tiers"], {"critical_attention": 1})
        self.assertEqual(summary["items"][0]["sla_tier"], "critical_attention")


if __name__ == "__main__":
    unittest.main()
