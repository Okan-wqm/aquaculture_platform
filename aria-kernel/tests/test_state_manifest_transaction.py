from __future__ import annotations

import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from aria_kernel.ledger import (
    LedgerIntegrityError,
    append_declared_jsonl,
    append_jsonl,
    load_declared_jsonl,
    load_jsonl,
    rewrite_declared_jsonl,
    rewrite_jsonl,
    state_transaction,
)
from aria_kernel.next_cycle_queue import append_pending, read_pending
from aria_kernel.state_manifest import surface_for_path, surface_by_name
from aria_kernel.tool_registry import ensure_tools_dir


class StateManifestTransactionTests(unittest.TestCase):
    def test_manifest_resolves_ack_and_queue_paths(self) -> None:
        with tempfile.TemporaryDirectory(prefix="aria-state-manifest-") as tmp:
            root = ensure_tools_dir(Path(tmp) / "aria-tools")
            ack = root / "acks" / "acks.jsonl"
            queue = root / "queues" / "next_cycle_queue.jsonl"
            self.assertEqual(surface_for_path(ack)[0].name, "ack_ledger")
            self.assertEqual(surface_for_path(queue)[0].name, "next_cycle_queue")
            self.assertEqual(
                surface_by_name("ack_ledger").path_pattern,
                "acks/acks.jsonl",
            )

    def test_manifest_rejects_unbound_rogue_absolute_path(self) -> None:
        with tempfile.TemporaryDirectory(prefix="aria-state-rogue-") as tmp:
            rogue = Path(tmp) / "rogue" / "context-audits.jsonl"
            self.assertIsNone(surface_for_path(rogue))

    def test_declared_context_audit_append_and_load(self) -> None:
        with tempfile.TemporaryDirectory(prefix="aria-declared-ledger-") as tmp:
            root = ensure_tools_dir(Path(tmp) / "aria-tools")
            target = root / "context-audits.jsonl"
            stored = append_declared_jsonl(
                target,
                {"event": "audit", "schema_version": 1},
                expected_surface="context_audits",
            )
            rows = load_declared_jsonl(target, expected_surface="context_audits")
            self.assertEqual(rows, [stored])
            self.assertTrue(rows[0]["ledger_hash"].startswith("sha256:"))

    def test_raw_context_audit_append_load_and_rewrite_reject(self) -> None:
        with tempfile.TemporaryDirectory(prefix="aria-raw-declared-reject-") as tmp:
            root = ensure_tools_dir(Path(tmp) / "aria-tools")
            target = root / "context-audits.jsonl"
            with self.assertRaisesRegex(LedgerIntegrityError, "declared_surface_requires_append_api"):
                append_jsonl(target, {"event": "raw"})
            append_declared_jsonl(
                target,
                {"event": "declared", "schema_version": 1},
                expected_surface="context_audits",
            )
            with self.assertRaisesRegex(LedgerIntegrityError, "declared_surface_requires_load_declared_jsonl"):
                load_jsonl(target, verify=True)
            with self.assertRaisesRegex(LedgerIntegrityError, "declared_surface_requires_rewrite_api"):
                rewrite_jsonl(target, [{"event": "raw-rewrite"}])

    def test_declared_rewrite_requires_migration_id(self) -> None:
        with tempfile.TemporaryDirectory(prefix="aria-declared-rewrite-") as tmp:
            root = ensure_tools_dir(Path(tmp) / "aria-tools")
            target = root / "context-audits.jsonl"
            with self.assertRaisesRegex(LedgerIntegrityError, "declared_rewrite_requires_migration_id"):
                rewrite_declared_jsonl(
                    target,
                    [{"event": "rewrite"}],
                    expected_surface="context_audits",
                    migration_id="",
                )
            rewrite_declared_jsonl(
                target,
                [{"event": "rewrite"}],
                expected_surface="context_audits",
                migration_id="MIG-ctx-001",
            )
            rows = load_declared_jsonl(target, expected_surface="context_audits")
            self.assertEqual(rows[0]["event"], "rewrite")

    def test_state_transaction_appends_hash_chained_rows(self) -> None:
        with tempfile.TemporaryDirectory(prefix="aria-state-txn-") as tmp:
            root = ensure_tools_dir(Path(tmp) / "aria-tools")
            target = root / "queues" / "next_cycle_queue.jsonl"
            with state_transaction([target]) as txn:
                txn.append_jsonl(target, {"event": "one"})
                txn.append_jsonl(target, {"event": "two"})
            rows = load_jsonl(target, verify=True)
            self.assertEqual([row["event"] for row in rows], ["one", "two"])
            self.assertEqual(rows[1]["previous_ledger_hash"], rows[0]["ledger_hash"])

    def test_transaction_raw_declared_append_rejects(self) -> None:
        with tempfile.TemporaryDirectory(prefix="aria-state-txn-declared-") as tmp:
            root = ensure_tools_dir(Path(tmp) / "aria-tools")
            target = root / "context-audits.jsonl"
            with state_transaction([target]) as txn:
                with self.assertRaisesRegex(LedgerIntegrityError, "declared_surface_requires_append_api"):
                    txn.append_jsonl(target, {"event": "raw"})
                stored = txn.append_declared_jsonl(
                    target,
                    {"event": "declared", "schema_version": 1},
                    expected_surface="context_audits",
                )
            rows = load_declared_jsonl(target, expected_surface="context_audits")
            self.assertEqual(rows, [stored])

    def test_declared_api_rejects_wrong_expected_surface(self) -> None:
        with tempfile.TemporaryDirectory(prefix="aria-surface-mismatch-") as tmp:
            root = ensure_tools_dir(Path(tmp) / "aria-tools")
            target = root / "context-audits.jsonl"
            with self.assertRaisesRegex(LedgerIntegrityError, "declared_surface_mismatch"):
                append_declared_jsonl(
                    target,
                    {"event": "wrong-surface"},
                    expected_surface="agent_invocation_contexts",
                )

    def test_queue_depth_check_runs_under_transaction(self) -> None:
        with tempfile.TemporaryDirectory(prefix="aria-queue-txn-") as tmp:
            root = Path(tmp) / "aria-tools"
            with patch.dict(os.environ, {"ARIA_NEXT_CYCLE_QUEUE_DEPTH": "1"}):
                first = append_pending(
                    root,
                    source_cycle_id="cycle-1",
                    pressure_id="p-1",
                )
                second = append_pending(
                    root,
                    source_cycle_id="cycle-2",
                    pressure_id="p-2",
                )
            self.assertIsNotNone(first)
            self.assertIsNotNone(second)
            self.assertEqual(second["state"], "blocked")
            self.assertEqual(second["reason"], "queue_depth_exceeded")
            self.assertEqual(len(read_pending(root)), 1)
            governance = load_jsonl(root / "governance.jsonl", verify=True)
            self.assertEqual(governance[-1]["kind"], "next_cycle_queue_overflow_blocked")


if __name__ == "__main__":
    unittest.main()
