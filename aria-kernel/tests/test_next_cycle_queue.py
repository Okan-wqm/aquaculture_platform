"""Plan 026R §F.2 — next_cycle_queue bounded scheduler queue.

4 tests:

* append + read_pending round-trip.
* depth cap blocks above ARIA_NEXT_CYCLE_QUEUE_DEPTH.
* mark_consumed excludes from read_pending.
* read_pending limit honored.
"""
from __future__ import annotations

import os
import tempfile
import threading
import unittest
from contextlib import contextmanager
from pathlib import Path
from unittest import mock

from aria_kernel import ledger as ledger_module
from aria_kernel import next_cycle_queue as queue_module
from aria_kernel.file_lock import with_exclusive_lock
from aria_kernel.ledger import StateTransaction, load_jsonl
from aria_kernel.next_cycle_queue import (
    DEFAULT_QUEUE_DEPTH,
    QUEUE_DEPTH_ENV,
    append_pending,
    mark_consumed,
    queue_depth,
    read_pending,
)
from aria_kernel.runtime_profile import set_profile


class NextCycleQueueTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="aria-f2-"))
        self.base = self.tmp / "aria-tools"
        set_profile(
            "standard", operator_approval_ref="f2-t", base_dir=self.base,
        )
        # Reset any prior env override.
        self._prior_env = os.environ.pop(QUEUE_DEPTH_ENV, None)

    def tearDown(self) -> None:
        import shutil
        shutil.rmtree(self.tmp, ignore_errors=True)
        if self._prior_env is not None:
            os.environ[QUEUE_DEPTH_ENV] = self._prior_env
        else:
            os.environ.pop(QUEUE_DEPTH_ENV, None)

    def test_append_and_read_pending_round_trip(self) -> None:
        row = append_pending(
            self.base,
            source_cycle_id="cyc-2026-05-11",
            pressure_id="pe-1",
            recommended_action="run-tool-X",
            candidate_tools=["tool-a", "tool-b"],
        )
        self.assertIsNotNone(row)
        self.assertEqual(row["state"], "pending")
        self.assertIn("queue_item_id", row)
        pending = read_pending(self.base)
        self.assertEqual(len(pending), 1)
        self.assertEqual(pending[0]["pressure_id"], "pe-1")
        self.assertEqual(
            pending[0]["candidate_tools"], ["tool-a", "tool-b"],
        )

    def test_depth_cap_blocks_excess_appends(self) -> None:
        os.environ[QUEUE_DEPTH_ENV] = "3"
        self.assertEqual(queue_depth(), 3)
        for i in range(3):
            row = append_pending(
                self.base,
                source_cycle_id="cyc-c",
                pressure_id=f"pe-{i}",
            )
            self.assertIsNotNone(row)
        # 4th append must hit the cap.
        overflow = append_pending(
            self.base,
            source_cycle_id="cyc-c",
            pressure_id="pe-overflow",
        )
        self.assertIsNotNone(overflow)
        self.assertEqual(overflow["state"], "blocked")
        self.assertEqual(overflow["reason"], "queue_depth_exceeded")
        self.assertEqual(len(read_pending(self.base)), 3)

    def test_mark_consumed_excludes_from_pending(self) -> None:
        row = append_pending(
            self.base,
            source_cycle_id="cyc-c",
            pressure_id="pe-x",
        )
        assert row is not None
        qid = row["queue_item_id"]
        self.assertEqual(len(read_pending(self.base)), 1)
        mark_consumed(
            self.base,
            queue_item_id=qid,
            consumed_by="test-consumer",
        )
        self.assertEqual(read_pending(self.base), [])

    def test_read_pending_limit_truncates(self) -> None:
        for i in range(5):
            append_pending(
                self.base,
                source_cycle_id="cyc-c",
                pressure_id=f"pe-{i}",
            )
        self.assertEqual(len(read_pending(self.base, limit=2)), 2)
        self.assertEqual(len(read_pending(self.base, limit=10)), 5)

    def test_same_pressure_id_is_idempotent(self) -> None:
        """C10/E8 — a persistent pressure re-enqueued every cycle must NOT
        mint a new pending row each time. Pre-fix every row was keyed on a
        fresh uuid, so the queue bloated until the depth cap "blocked" it —
        the overflow report read as capacity pressure when it was the same
        item N times. A second enqueue of a still-pending pressure is a no-op
        that returns the standing row."""
        first = append_pending(
            self.base,
            source_cycle_id="cyc-1",
            pressure_id="pe-persistent",
        )
        second = append_pending(
            self.base,
            source_cycle_id="cyc-2",
            pressure_id="pe-persistent",
        )
        assert first is not None and second is not None
        # No second row: one pending item, same identity.
        self.assertEqual(second["queue_item_id"], first["queue_item_id"])
        pending = read_pending(self.base)
        self.assertEqual(len(pending), 1)

    def test_distinct_pressure_ids_still_each_enqueue(self) -> None:
        append_pending(self.base, source_cycle_id="cyc-1", pressure_id="pe-a")
        append_pending(self.base, source_cycle_id="cyc-1", pressure_id="pe-b")
        self.assertEqual(len(read_pending(self.base)), 2)

    def test_reenqueue_after_consume_is_allowed(self) -> None:
        """Idempotency is scoped to PENDING rows only: once consumed, the
        same pressure may legitimately re-enter (the work recurred)."""
        row = append_pending(
            self.base, source_cycle_id="cyc-1", pressure_id="pe-recurring"
        )
        assert row is not None
        mark_consumed(
            self.base, queue_item_id=row["queue_item_id"], consumed_by="drain"
        )
        again = append_pending(
            self.base, source_cycle_id="cyc-2", pressure_id="pe-recurring"
        )
        assert again is not None
        self.assertNotEqual(again["queue_item_id"], row["queue_item_id"])
        self.assertEqual(len(read_pending(self.base)), 1)

    def test_overflow_uses_global_governance_then_queue_lock_order(self) -> None:
        os.environ[QUEUE_DEPTH_ENV] = "1"
        append_pending(
            self.base,
            source_cycle_id="cyc-fill",
            pressure_id="pe-fill",
        )
        governance_group = (
            self.base / "locks" / "state-groups" / "governance.lock"
        ).resolve()
        queue_group = (
            self.base / "locks" / "state-groups" / "queue.lock"
        ).resolve()
        governance_path = (self.base / "governance.jsonl").resolve()
        concrete_queue_path = (
            self.base / "queues" / "next_cycle_queue.jsonl"
        ).resolve()
        expected_transaction_locks = ledger_module._transaction_lock_paths(
            [governance_path, concrete_queue_path],
        )
        real_lock = ledger_module.with_exclusive_lock
        real_transaction = queue_module.state_transaction
        governance_held = threading.Event()
        overflow_started = threading.Event()
        queue_acquired = threading.Event()
        transaction_active = threading.local()
        public_transaction_paths: list[tuple[Path, ...]] = []
        writer_transaction_locks: list[Path] = []
        errors: list[BaseException] = []
        results: list[dict[str, object] | None] = []

        @contextmanager
        def observed_transaction(paths, **kwargs):
            resolved_paths = tuple(Path(path).resolve() for path in paths)
            public_transaction_paths.append(resolved_paths)
            transaction_active.value = True
            try:
                with real_transaction(paths, **kwargs) as transaction:
                    yield transaction
            finally:
                transaction_active.value = False

        @contextmanager
        def observed_lock(path, **kwargs):
            kwargs["timeout_seconds"] = min(
                float(kwargs.get("timeout_seconds", 5.0)),
                1.0,
            )
            with real_lock(path, **kwargs) as handle:
                resolved = Path(path).resolve()
                if (
                    threading.current_thread().name == "overflow-writer"
                    and getattr(transaction_active, "value", False)
                ):
                    writer_transaction_locks.append(resolved)
                if (
                    threading.current_thread().name == "overflow-writer"
                    and resolved == queue_group
                ):
                    queue_acquired.set()
                yield handle

        def recovery_order() -> None:
            try:
                with with_exclusive_lock(
                    governance_group,
                    timeout_seconds=1.0,
                ):
                    governance_held.set()
                    if not overflow_started.wait(timeout=5):
                        raise TimeoutError("overflow did not start")
                    queue_acquired.wait(timeout=0.25)
                    with with_exclusive_lock(
                        queue_group,
                        timeout_seconds=1.0,
                    ):
                        pass
            except BaseException as exc:  # noqa: BLE001 - thread handoff
                errors.append(exc)

        def overflow() -> None:
            try:
                overflow_started.set()
                results.append(
                    append_pending(
                        self.base,
                        source_cycle_id="cyc-overflow",
                        pressure_id="pe-overflow",
                    )
                )
            except BaseException as exc:  # noqa: BLE001 - thread handoff
                errors.append(exc)

        with mock.patch.object(
            ledger_module,
            "with_exclusive_lock",
            side_effect=observed_lock,
        ), mock.patch.object(
            queue_module,
            "state_transaction",
            side_effect=observed_transaction,
        ):
            recovery = threading.Thread(target=recovery_order, daemon=True)
            recovery.start()
            self.assertTrue(governance_held.wait(timeout=5))
            writer = threading.Thread(
                target=overflow,
                daemon=True,
                name="overflow-writer",
            )
            writer.start()
            recovery.join(timeout=5)
            writer.join(timeout=5)

        self.assertFalse(recovery.is_alive())
        self.assertFalse(writer.is_alive())
        self.assertEqual(errors, [])
        self.assertEqual(len(results), 1)
        self.assertEqual(results[0]["state"], "blocked")
        self.assertEqual(len(public_transaction_paths), 1)
        self.assertEqual(
            set(public_transaction_paths[0]),
            {governance_path, concrete_queue_path},
        )
        self.assertEqual(
            len(expected_transaction_locks),
            len(set(expected_transaction_locks)),
        )
        self.assertEqual(
            expected_transaction_locks[:2],
            [governance_group, queue_group],
        )
        self.assertEqual(
            writer_transaction_locks[: len(expected_transaction_locks)],
            expected_transaction_locks,
        )
        queue_rows = load_jsonl(
            self.base / "queues" / "next_cycle_queue.jsonl",
            verify=True,
        )
        governance_rows = load_jsonl(
            self.base / "governance.jsonl",
            verify=True,
        )
        self.assertEqual(
            sum(row.get("state") == "blocked" for row in queue_rows),
            1,
        )
        self.assertEqual(
            sum(
                row.get("kind") == "next_cycle_queue_overflow_blocked"
                for row in governance_rows
            ),
            1,
        )

    def test_overflow_governance_failure_writes_no_blocked_queue_row(self) -> None:
        os.environ[QUEUE_DEPTH_ENV] = "1"
        append_pending(
            self.base,
            source_cycle_id="cyc-fill",
            pressure_id="pe-fill",
        )
        real_append = StateTransaction.append_declared_jsonl

        def fail_governance(
            transaction,
            path,
            record,
            *,
            expected_surface,
            bypass_profile_gate=False,
        ):
            if expected_surface == "tools_governance":
                raise OSError("injected governance failure")
            return real_append(
                transaction,
                path,
                record,
                expected_surface=expected_surface,
                bypass_profile_gate=bypass_profile_gate,
            )

        with mock.patch.object(
            StateTransaction,
            "append_declared_jsonl",
            new=fail_governance,
        ), self.assertRaisesRegex(OSError, "injected governance failure"):
            append_pending(
                self.base,
                source_cycle_id="cyc-overflow",
                pressure_id="pe-overflow",
            )

        rows = load_jsonl(
            self.base / "queues" / "next_cycle_queue.jsonl",
            verify=True,
        )
        self.assertFalse(any(row.get("state") == "blocked" for row in rows))

    def test_overflow_retry_after_governance_crash_is_exactly_once(self) -> None:
        os.environ[QUEUE_DEPTH_ENV] = "1"
        append_pending(
            self.base,
            source_cycle_id="cyc-fill",
            pressure_id="pe-fill",
        )
        real_append = StateTransaction.append_declared_jsonl
        crashed = False

        def append_governance_then_crash(
            transaction,
            path,
            record,
            *,
            expected_surface,
            bypass_profile_gate=False,
        ):
            nonlocal crashed
            stored = real_append(
                transaction,
                path,
                record,
                expected_surface=expected_surface,
                bypass_profile_gate=bypass_profile_gate,
            )
            if expected_surface == "tools_governance" and not crashed:
                crashed = True
                raise OSError("injected crash after governance append")
            return stored

        with mock.patch.object(
            StateTransaction,
            "append_declared_jsonl",
            new=append_governance_then_crash,
        ), self.assertRaisesRegex(OSError, "injected crash after governance append"):
            append_pending(
                self.base,
                source_cycle_id="cyc-overflow",
                pressure_id="pe-overflow",
            )

        retried = append_pending(
            self.base,
            source_cycle_id="cyc-overflow",
            pressure_id="pe-overflow",
        )
        self.assertEqual(retried["state"], "blocked")
        queue_rows = load_jsonl(
            self.base / "queues" / "next_cycle_queue.jsonl",
            verify=True,
        )
        governance_rows = load_jsonl(
            self.base / "governance.jsonl",
            verify=True,
        )
        self.assertEqual(
            sum(row.get("state") == "blocked" for row in queue_rows),
            1,
        )
        self.assertEqual(
            sum(
                row.get("kind") == "next_cycle_queue_overflow_blocked"
                for row in governance_rows
            ),
            1,
        )

    def test_concurrent_same_pressure_overflow_is_exactly_once(self) -> None:
        os.environ[QUEUE_DEPTH_ENV] = "1"
        append_pending(
            self.base,
            source_cycle_id="cyc-fill",
            pressure_id="pe-fill",
        )
        start = threading.Barrier(2)
        results: list[dict[str, object] | None] = []
        errors: list[BaseException] = []

        def overflow() -> None:
            try:
                start.wait(timeout=5)
                results.append(
                    append_pending(
                        self.base,
                        source_cycle_id="cyc-overflow",
                        pressure_id="pe-overflow",
                    )
                )
            except BaseException as exc:  # noqa: BLE001 - thread handoff
                errors.append(exc)

        threads = [threading.Thread(target=overflow, daemon=True) for _ in range(2)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join(timeout=10)

        self.assertTrue(all(not thread.is_alive() for thread in threads))
        self.assertEqual(errors, [])
        self.assertEqual(len(results), 2)
        self.assertEqual(
            {result["queue_item_id"] for result in results if result is not None},
            {results[0]["queue_item_id"]},
        )
        queue_rows = load_jsonl(
            self.base / "queues" / "next_cycle_queue.jsonl",
            verify=True,
        )
        governance_rows = load_jsonl(
            self.base / "governance.jsonl",
            verify=True,
        )
        self.assertEqual(
            sum(row.get("state") == "blocked" for row in queue_rows),
            1,
        )
        self.assertEqual(
            sum(
                row.get("kind") == "next_cycle_queue_overflow_blocked"
                for row in governance_rows
            ),
            1,
        )


if __name__ == "__main__":
    unittest.main()
