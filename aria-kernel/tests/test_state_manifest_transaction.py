from __future__ import annotations

import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from aria_kernel.ledger import load_jsonl, state_transaction
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

    def test_state_transaction_appends_hash_chained_rows(self) -> None:
        with tempfile.TemporaryDirectory(prefix="aria-state-txn-") as tmp:
            root = ensure_tools_dir(Path(tmp) / "aria-tools")
            target = root / "queues" / "next_cycle_queue.jsonl"
            with state_transaction([target]) as txn:
                txn.append_declared_jsonl(target, {"event": "one"}, expected_surface="next_cycle_queue")
                txn.append_declared_jsonl(target, {"event": "two"}, expected_surface="next_cycle_queue")
            rows = load_jsonl(target, verify=True)
            self.assertEqual([row["event"] for row in rows], ["one", "two"])
            self.assertEqual(rows[1]["previous_ledger_hash"], rows[0]["ledger_hash"])

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
