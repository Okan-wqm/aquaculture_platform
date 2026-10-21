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
    HUMAN_REQUIRED_SLA_WINDOWS,
    list_human_required,
    record_human_required,
    resolve_human_required,
    sweep_lease_lifecycle_for_human_required,
)
from aria_kernel.tool_registry import GovernanceError, ensure_tools_dir
from aria_kernel.request_admission import admit_request


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
        for sev, expected_window in HUMAN_REQUIRED_SLA_WINDOWS.items():
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
        open_rows = list_human_required(base_dir=self.tools).rows
        self.assertEqual([r["request_id"] for r in open_rows], ["req-A"])
        all_rows = list_human_required(base_dir=self.tools, include_resolved=True).rows
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
        rows = list_human_required(base_dir=self.tools).rows
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


class HumanRequiredGovernedWriteTests(unittest.TestCase):
    """ARIA-MEDIUM-461 — the record file is a declared ``rewrite_fsync`` surface.

    Every write goes through the governed declared-JSON writer
    (``StateTransaction.rewrite_declared_json``: manifest assertion, profile
    gate, atomic fsync'd rename) in the same transaction as its governance
    row, and a resolve refuses at entry under a profile that forbids the
    surface — before, the record was already rewritten as resolved when the
    governance append refused.
    """

    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.tools = Path(self._tmp.name) / "aria-tools"
        ensure_tools_dir(self.tools)

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def _status(self, request_id: str) -> str:
        import json

        from aria_kernel.human_required import _human_required_path

        return json.loads(_human_required_path(self.tools, request_id).read_text(encoding="utf-8"))["status"]

    def test_frozen_profile_refuses_resolve_before_any_write(self) -> None:
        from aria_kernel.runtime_profile import set_profile

        record_human_required(request_id="req-frozen", severity="HIGH", reason="r", base_dir=self.tools)
        set_profile("frozen", operator_approval_ref="op:freeze", base_dir=self.tools)
        with self.assertRaisesRegex(GovernanceError, "human_required"):
            resolve_human_required(request_id="req-frozen", resolution_note="n", base_dir=self.tools)
        self.assertEqual(self._status("req-frozen"), "open")

    def test_every_record_write_shares_one_transaction_with_its_governance_row(self) -> None:
        # The governed writer AND the bound: the record and its audit row are
        # written under one `state_transaction` (one lock wait, the one
        # `HUMAN_REQUIRED_RECORD_WAIT_SECONDS` prices), never a record
        # transaction followed by a second, independent governance one.
        from unittest import mock

        from aria_kernel import human_required, ledger
        from aria_kernel.human_required import refresh_open_record_context

        opened: list[list[str]] = []
        surfaces: list[str] = []
        real_transaction = ledger.state_transaction
        real_rewrite = ledger.StateTransaction.rewrite_declared_json

        def recording_transaction(paths, *args, **kwargs):
            opened.append(sorted(Path(path).name for path in paths))
            return real_transaction(paths, *args, **kwargs)

        def recording_rewrite(transaction, path, payload, *, expected_surface, **kwargs):
            surfaces.append(expected_surface)
            return real_rewrite(transaction, path, payload, expected_surface=expected_surface, **kwargs)

        with mock.patch.object(human_required, "state_transaction", recording_transaction), \
                mock.patch.object(ledger, "state_transaction", recording_transaction), \
                mock.patch.object(ledger.StateTransaction, "rewrite_declared_json", recording_rewrite), \
                mock.patch.object(human_required, "notify_best_effort"):
            record_human_required(
                request_id="req-w", severity="HIGH", reason="r", base_dir=self.tools,
                context={"kind": "human_merge", "pr": 1},
            )
            refresh_open_record_context(
                request_id="req-w", context={"kind": "human_merge", "pr": 2}, base_dir=self.tools,
            )
            resolve_human_required(request_id="req-w", resolution_note="n", base_dir=self.tools)
        self.assertEqual(surfaces, ["human_required_requests"] * 3)
        record_transactions = [paths for paths in opened if "req-w.json" in paths]
        self.assertEqual(record_transactions, [["governance.jsonl", "req-w.json"]] * 3)
        lone_governance = [
            paths for paths in opened
            if "governance.jsonl" in paths and "req-w.json" not in paths
            and "integrity_index.json" not in paths
        ]
        self.assertEqual(lone_governance, [])
        self.assertEqual(self._status("req-w"), "resolved")

    def test_a_kernel_disposition_writes_its_record_alone(self) -> None:
        # The disposition's caller writes the batch's governance rows, so
        # its record transaction is the record only.
        from unittest import mock

        from aria_kernel import human_required
        from aria_kernel.human_required import RESOLVED_BY_KERNEL, write_kernel_disposition

        opened: list[list[str]] = []
        real_transaction = human_required.state_transaction

        def recording_transaction(paths, *args, **kwargs):
            opened.append(sorted(Path(path).name for path in paths))
            return real_transaction(paths, *args, **kwargs)

        with mock.patch.object(human_required, "state_transaction", recording_transaction):
            written = write_kernel_disposition(base_dir=self.tools, item={
                "request_id": "req-k", "severity": "HIGH", "reason": "expired", "context": {"kind": "k"},
                "status": "resolved", "disposition": {"disposition": "reminted", "reason": "rule"},
            })
        self.assertEqual(opened, [["req-k.json"]])
        self.assertEqual(written["resolved_by"], RESOLVED_BY_KERNEL)
        self.assertEqual(self._status("req-k"), "resolved")

    def test_no_raw_record_writes_remain(self) -> None:
        import ast

        kernel = Path(__file__).resolve().parents[1] / "aria_kernel"
        raw: list[str] = []
        for name in ("human_required.py", "human_required_adjudication.py"):
            tree = ast.parse((kernel / name).read_text(encoding="utf-8"))
            raw.extend(
                f"{name}:{node.lineno}"
                for node in ast.walk(tree)
                if isinstance(node, ast.Call)
                and isinstance(node.func, ast.Attribute)
                and node.func.attr == "write_text"
            )
        self.assertEqual(raw, [])


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
                {"id": "exhaust-test", "description": "request reaches human_required"},
            ],
            allowed_scope=["aria-kernel/**"],
            convergence_id="conv-sweep-001",
            base_dir=self.tools,
            admission=admit_request("operator_cli.request", "primary_plan", base_dir=self.tools),
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
