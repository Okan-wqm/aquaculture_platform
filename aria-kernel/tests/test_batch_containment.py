"""Direct behaviour of ``batch_containment``'s two primitives.

``test_batch_containment_gate.py`` is the AST gate: it scans the CALLERS'
source for committing loops that are not wrapped in ``guard_item``.
``test_learning_batch_containment.py`` exercises containment only through real
learning hooks. Neither pins the primitives' own contract, which ten kernel
modules rely on: a legitimate ``None`` is not a failure, the failure row's
fields, ``LedgerIntegrityError`` is never contained, and ``item_failures`` is
present only when an item failed.
"""
from __future__ import annotations

import unittest
from typing import Any

from aria_kernel.batch_containment import guard_item, with_item_failures
from aria_kernel.ledger import LedgerIntegrityError


class GuardItemBehavior(unittest.TestCase):
    def test_success_returns_true_and_value(self) -> None:
        failures: list[dict[str, Any]] = []
        ok, value = guard_item(
            failures, item_kind="dispatch", item_id="a1", work=lambda: 42,
        )
        self.assertTrue(ok)
        self.assertEqual(value, 42)
        self.assertEqual(failures, [])

    def test_legitimate_none_result_is_not_a_failure(self) -> None:
        # The (ok, value) pair exists so a purposeful None is never read as a
        # failure.
        failures: list[dict[str, Any]] = []
        ok, value = guard_item(
            failures, item_kind="dispatch", item_id="a1", work=lambda: None,
        )
        self.assertTrue(ok)
        self.assertIsNone(value)
        self.assertEqual(failures, [])

    def test_item_exception_is_recorded_not_raised(self) -> None:
        failures: list[dict[str, Any]] = []

        def boom() -> int:
            raise ValueError("item exploded")

        ok, value = guard_item(
            failures, item_kind="dispatch", item_id="item-2", work=boom,
        )
        self.assertFalse(ok)
        self.assertIsNone(value)
        self.assertEqual(
            failures,
            [{
                "item_kind": "dispatch",
                "item_id": "item-2",
                "error_class": "ValueError",
                "error_message": "item exploded",
            }],
        )

    def test_ledger_integrity_error_is_never_contained(self) -> None:
        # A corrupt ledger is the cycle's problem, not one item's: the
        # primitive re-raises it and records nothing.
        failures: list[dict[str, Any]] = []

        def corrupt() -> int:
            raise LedgerIntegrityError("ledger corrupt")

        with self.assertRaises(LedgerIntegrityError):
            guard_item(failures, item_kind="dispatch", item_id="a1", work=corrupt)
        self.assertEqual(failures, [])

    def test_one_bad_item_costs_that_item_never_the_batch(self) -> None:
        # ORPHAN-HIGH-575's shape: a 4-item batch where item 2 raises. Items
        # 1, 3 and 4 still commit, and only item 2 is in the failure list.
        failures: list[dict[str, Any]] = []
        committed: list[str] = []

        def make_work(item: str, *, fail: bool = False):
            def _work() -> str:
                if fail:
                    raise RuntimeError(f"{item} failed")
                committed.append(item)
                return item

            return _work

        results = [
            guard_item(
                failures,
                item_kind="dispatch",
                item_id=item,
                work=make_work(item, fail=(item == "i2")),
            )
            for item in ("i1", "i2", "i3", "i4")
        ]
        self.assertEqual([ok for ok, _ in results], [True, False, True, True])
        self.assertEqual(committed, ["i1", "i3", "i4"])
        self.assertEqual([f["item_id"] for f in failures], ["i2"])
        self.assertEqual(failures[0]["error_class"], "RuntimeError")


class WithItemFailuresBehavior(unittest.TestCase):
    def test_healthy_batch_carries_no_item_failures_key(self) -> None:
        # Absence is the signal: an always-present empty list would make
        # "partial" meaningless upstream.
        payload = with_item_failures({"status": "ok"}, [])
        self.assertEqual(payload, {"status": "ok"})

    def test_failed_batch_carries_the_failure_list(self) -> None:
        failures = [
            {
                "item_kind": "dispatch",
                "item_id": "i2",
                "error_class": "RuntimeError",
                "error_message": "i2 failed",
            },
        ]
        payload = with_item_failures({"status": "partial"}, failures)
        self.assertEqual(payload, {"status": "partial", "item_failures": failures})


if __name__ == "__main__":
    unittest.main()
