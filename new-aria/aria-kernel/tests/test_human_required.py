"""Tests for the Plan 016 Faz D9 HUMAN_REQUIRED escalation surface."""
from __future__ import annotations

import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

from aria_kernel.agent_invocations import (
    DEFAULT_MAX_REQUEUES,
    claim_request,
    create_agent_invocation_request,
    release_claim,
)
from aria_kernel.human_required import (
    SLA_WINDOWS,
    list_human_required,
    record_human_required,
    resolve_human_required,
    sweep_lease_lifecycle_for_human_required,
)
from aria_kernel.tool_registry import GovernanceError, ensure_tools_dir


class HumanRequiredRecordTests(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.tools = Path(self._tmp.name) / "aria-tools"
        ensure_tools_dir(self.tools)

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def test_record_creates_file_and_governance_event(self) -> None:
        row = record_human_required(
            request_id="req-001",
            severity="HIGH",
            reason="convergence loop exhausted MAX_REQUEUES",
            base_dir=self.tools,
        )
        self.assertEqual(row["status"], "open")
        self.assertEqual(row["severity"], "HIGH")
        path = self.tools / "human-required" / "req-001.json"
        self.assertTrue(path.exists())

    def test_idempotent_record_returns_existing(self) -> None:
        first = record_human_required(
            request_id="req-002",
            severity="MEDIUM",
            reason="manual escalation",
            base_dir=self.tools,
        )
        second = record_human_required(
            request_id="req-002",
            severity="CRITICAL",  # ignored when already recorded
            reason="should be ignored",
            base_dir=self.tools,
        )
        self.assertEqual(first["sla_deadline"], second["sla_deadline"])

    def test_sla_deadline_per_severity(self) -> None:
        ts = datetime(2026, 5, 7, 0, 0, tzinfo=timezone.utc)
        for sev, expected_window in SLA_WINDOWS.items():
            row = record_human_required(
                request_id=f"req-{sev}",
                severity=sev,
                reason="severity test",
                base_dir=self.tools,
                now=ts,
            )
            recorded = datetime.fromisoformat(row["sla_deadline"].replace("Z", "+00:00"))
            self.assertEqual(recorded - ts, expected_window)

    def test_unknown_severity_falls_back_to_high(self) -> None:
        row = record_human_required(
            request_id="req-fallback",
            severity="OBSCURE",
            reason="severity fallback test",
            base_dir=self.tools,
        )
        self.assertEqual(row["severity"], "HIGH")

    def test_empty_reason_rejected(self) -> None:
        with self.assertRaisesRegex(GovernanceError, "reason"):
            record_human_required(
                request_id="req-empty",
                severity="LOW",
                reason="",
                base_dir=self.tools,
            )


class HumanRequiredListResolveTests(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.tools = Path(self._tmp.name) / "aria-tools"
        ensure_tools_dir(self.tools)

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def test_list_filters_resolved_by_default(self) -> None:
        record_human_required(
            request_id="req-A", severity="HIGH", reason="open", base_dir=self.tools
        )
        record_human_required(
            request_id="req-B", severity="MEDIUM", reason="will be resolved", base_dir=self.tools
        )
        resolve_human_required(
            request_id="req-B",
            resolution_note="operator addressed manually",
            base_dir=self.tools,
        )
        open_rows = list_human_required(base_dir=self.tools)
        self.assertEqual([r["request_id"] for r in open_rows], ["req-A"])
        all_rows = list_human_required(base_dir=self.tools, include_resolved=True)
        self.assertEqual({r["request_id"] for r in all_rows}, {"req-A", "req-B"})

    def test_list_sorted_by_sla_deadline(self) -> None:
        ts = datetime(2026, 5, 7, 0, 0, tzinfo=timezone.utc)
        record_human_required(
            request_id="req-low", severity="LOW", reason="low priority",
            base_dir=self.tools, now=ts,
        )
        record_human_required(
            request_id="req-critical", severity="CRITICAL", reason="critical",
            base_dir=self.tools, now=ts,
        )
        rows = list_human_required(base_dir=self.tools)
        # CRITICAL has the earliest deadline (72h < 14d).
        self.assertEqual(rows[0]["request_id"], "req-critical")

    def test_resolve_missing_record_raises(self) -> None:
        with self.assertRaisesRegex(GovernanceError, "not found"):
            resolve_human_required(
                request_id="req-nope",
                resolution_note="never recorded",
                base_dir=self.tools,
            )

    def test_resolve_empty_note_rejected(self) -> None:
        record_human_required(
            request_id="req-X", severity="HIGH", reason="open", base_dir=self.tools
        )
        with self.assertRaisesRegex(GovernanceError, "resolution_note"):
            resolve_human_required(
                request_id="req-X", resolution_note="", base_dir=self.tools
            )


class SweepLeaseLifecycleTests(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.tools = Path(self._tmp.name) / "aria-tools"
        ensure_tools_dir(self.tools)

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def _exhaust_request_to_human_required(self) -> str:
        # Plan 024 §B-2 — strict fields required on the request row so
        # claim_request does not reject via _strict_request_view. The
        # human-required sweep test cycles through claims + releases;
        # the matrix content itself is not the test's focus.
        request = create_agent_invocation_request(
            target_agent="aria-primary-planner",
            role="primary_plan",
            suggested_prompt="exhaust requeues",
            must_satisfy=[
                {"id": "exhaust-test", "criterion": "request reaches human_required"},
            ],
            allowed_scope=["aria-kernel/**"],
            convergence_id="conv-sweep-001",
            base_dir=self.tools,
        )
        rid = request["request_id"]
        for i in range(DEFAULT_MAX_REQUEUES + 1):
            claim = claim_request(
                request_id=rid, agent_id=f"worker-{i}", base_dir=self.tools
            )
            release_claim(
                claim_id=claim["claim_id"],
                agent_id=f"worker-{i}",
                lease_token=claim["lease_token"],
                reason=f"abort {i}",
                base_dir=self.tools,
            )
        return rid

    def test_sweep_creates_record_for_lease_human_required(self) -> None:
        rid = self._exhaust_request_to_human_required()
        result = sweep_lease_lifecycle_for_human_required(base_dir=self.tools)
        self.assertEqual(len(result["created"]), 1)
        self.assertEqual(result["created"][0]["request_id"], rid)
        # Idempotent: second sweep skips the already-recorded entry.
        again = sweep_lease_lifecycle_for_human_required(base_dir=self.tools)
        self.assertEqual(len(again["created"]), 0)
        self.assertEqual(len(again["skipped"]), 1)


if __name__ == "__main__":
    unittest.main()
