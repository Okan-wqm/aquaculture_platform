"""Plan 024 v3 followup §E (ORPHAN-LOW-057) — unit tests for the
cycles.jsonl read-time upcaster.

The upcaster is the tier-2 "make automatic" backward-compat surface
that derives status from event for legacy schema_version=2 rows. The
tier-1 invariant (cycle.py writer always emits status at v3+) is
covered separately by E Implementer-A's test suite; this module only
tests the read-time transformation.

Architectural contract (also asserted here):
  * v3+ rows pass through unchanged (writer is SSoT).
  * v2 rows are augmented with a status field derived from event.
  * Unknown / missing events raise GovernanceError (closed-set defense).
  * The input dict is NEVER mutated (callers rely on the original
    reference for ledger-hash recomputation).
  * Bulk variant preserves order.
"""
from __future__ import annotations

import unittest

from aria_kernel.tool_registry import GovernanceError
from aria_kernel.upcasters import upcast_cycle_row, upcast_cycle_rows


class V3PassThroughTests(unittest.TestCase):
    def test_v3_row_passes_through_unchanged(self) -> None:
        row = {
            "schema_version": 3,
            "at": "2026-05-10T00:00:00+00:00",
            "cycle_id": "cyc-v3-001",
            "event": "completed",
            "status": "completed",
            "ledger_hash": "sha256:abc",
        }
        result = upcast_cycle_row(row)
        # Equality (not identity) required — but the upcaster MAY return
        # the input row unchanged for v3 short-circuit; either way the
        # value must equal the input exactly.
        self.assertEqual(result, row)
        # Status must remain whatever the writer emitted, not be
        # re-derived from event.
        self.assertEqual(result["status"], "completed")

    def test_v3_row_with_status_different_from_event_preserved(self) -> None:
        # Edge case: a future v3 row could legally carry status='aborted'
        # while event='started' if a cycle is aborted before the
        # complete event. The upcaster MUST NOT overwrite the writer's
        # status with one derived from event for v3+ rows.
        row = {
            "schema_version": 3,
            "cycle_id": "cyc-v3-aborted-mid-flight",
            "event": "started",
            "status": "aborted",
        }
        result = upcast_cycle_row(row)
        self.assertEqual(result["status"], "aborted")
        self.assertEqual(result["event"], "started")


class V2EventToStatusTests(unittest.TestCase):
    def test_v2_started_row_gets_status_started(self) -> None:
        row = {
            "schema_version": 2,
            "at": "2026-05-06T05:22:59+00:00",
            "cycle_id": "e2e-2a-001",
            "event": "started",
            "ledger_hash": "sha256:abc",
        }
        result = upcast_cycle_row(row)
        self.assertEqual(result["status"], "started")
        # All original fields preserved.
        self.assertEqual(result["cycle_id"], "e2e-2a-001")
        self.assertEqual(result["event"], "started")
        self.assertEqual(result["schema_version"], 2)

    def test_v2_completed_row_gets_status_completed(self) -> None:
        row = {
            "schema_version": 2,
            "cycle_id": "cyc-completed",
            "event": "completed",
            "tool_decision_count": 5,
        }
        result = upcast_cycle_row(row)
        self.assertEqual(result["status"], "completed")
        self.assertEqual(result["tool_decision_count"], 5)

    def test_v2_failed_row_gets_status_failed(self) -> None:
        row = {
            "schema_version": 2,
            "cycle_id": "cyc-failed",
            "event": "failed",
        }
        result = upcast_cycle_row(row)
        self.assertEqual(result["status"], "failed")

    def test_v2_stopped_row_gets_status_stopped(self) -> None:
        row = {
            "schema_version": 2,
            "cycle_id": "cyc-stop",
            "event": "stopped",
        }
        result = upcast_cycle_row(row)
        self.assertEqual(result["status"], "stopped")

    def test_v2_aborted_row_gets_status_aborted(self) -> None:
        # Pre-fix aborted rows were never persisted in production
        # cycles.jsonl, but the upcaster must still support the event
        # in case any are recovered from ledger snapshots / backups.
        row = {
            "schema_version": 2,
            "cycle_id": "cyc-aborted-recovered",
            "event": "aborted",
        }
        result = upcast_cycle_row(row)
        self.assertEqual(result["status"], "aborted")

    def test_v1_row_treated_as_legacy_and_upcast(self) -> None:
        # schema_version absent -> default 1 -> legacy path. This covers
        # rows from before schema_version was introduced; if event is in
        # the closed set, the upcaster must still derive status.
        row = {
            "cycle_id": "cyc-v1-historical",
            "event": "completed",
        }
        result = upcast_cycle_row(row)
        self.assertEqual(result["status"], "completed")


class GovernanceErrorTests(unittest.TestCase):
    def test_unknown_event_raises_governance_error(self) -> None:
        row = {
            "schema_version": 2,
            "cycle_id": "cyc-bad-event",
            "event": "garbage",
        }
        with self.assertRaises(GovernanceError) as cm:
            upcast_cycle_row(row)
        self.assertIn("cycle_row_upcast_unknown_legacy_event", str(cm.exception))
        self.assertIn("garbage", str(cm.exception))
        # Closed-set hint must appear in the error so the operator can
        # immediately see the supported vocabulary without reading code.
        self.assertIn("started", str(cm.exception))
        self.assertIn("completed", str(cm.exception))

    def test_missing_event_raises_governance_error(self) -> None:
        row = {
            "schema_version": 2,
            "cycle_id": "cyc-missing-event",
        }
        with self.assertRaises(GovernanceError) as cm:
            upcast_cycle_row(row)
        self.assertIn("cycle_row_upcast_event_missing_or_invalid", str(cm.exception))

    def test_event_non_string_raises_governance_error(self) -> None:
        # Defensive check: a corrupted ledger row could carry event as
        # int / None / list; upcaster must reject all non-string events.
        for bad_event in (None, 42, ["completed"], {"event": "completed"}):
            with self.subTest(bad_event=bad_event):
                row = {"schema_version": 2, "event": bad_event}
                with self.assertRaises(GovernanceError):
                    upcast_cycle_row(row)


class InputImmutabilityTests(unittest.TestCase):
    def test_input_dict_not_mutated(self) -> None:
        # The upcaster must NOT mutate the input dict; callers (e.g.
        # ledger-hash recomputation) rely on the original row reference
        # being unchanged after read-time augmentation.
        original = {
            "schema_version": 2,
            "cycle_id": "cyc-immutable",
            "event": "completed",
        }
        snapshot_before = dict(original)
        result = upcast_cycle_row(original)
        # Result has status; original does not.
        self.assertIn("status", result)
        self.assertNotIn("status", original)
        # Original still equals the snapshot.
        self.assertEqual(original, snapshot_before)
        # And the result is a different dict object.
        self.assertIsNot(result, original)

    def test_repeated_calls_dont_share_state(self) -> None:
        # Pass the SAME row reference twice; first call must not affect
        # second call's input or output.
        row = {
            "schema_version": 2,
            "cycle_id": "cyc-repeat",
            "event": "started",
        }
        first = upcast_cycle_row(row)
        second = upcast_cycle_row(row)
        self.assertEqual(first, second)
        self.assertIsNot(first, second)
        # And the original row was not mutated in either call.
        self.assertNotIn("status", row)


class BulkVariantTests(unittest.TestCase):
    def test_bulk_variant_preserves_order(self) -> None:
        rows = [
            {"schema_version": 2, "cycle_id": "a", "event": "started"},
            {"schema_version": 3, "cycle_id": "b", "event": "completed", "status": "completed"},
            {"schema_version": 2, "cycle_id": "c", "event": "failed"},
        ]
        result = upcast_cycle_rows(rows)
        self.assertEqual(len(result), 3)
        self.assertEqual([r["cycle_id"] for r in result], ["a", "b", "c"])
        self.assertEqual([r["status"] for r in result], ["started", "completed", "failed"])

    def test_bulk_variant_empty_list_returns_empty(self) -> None:
        self.assertEqual(upcast_cycle_rows([]), [])

    def test_bulk_variant_propagates_governance_error(self) -> None:
        # If any row fails, the bulk call must raise — no partial
        # success / silent skip.
        rows = [
            {"schema_version": 2, "cycle_id": "a", "event": "started"},
            {"schema_version": 2, "cycle_id": "b", "event": "garbage"},
        ]
        with self.assertRaises(GovernanceError):
            upcast_cycle_rows(rows)

    def test_bulk_variant_does_not_mutate_inputs(self) -> None:
        rows = [
            {"schema_version": 2, "cycle_id": "x", "event": "started"},
            {"schema_version": 2, "cycle_id": "y", "event": "completed"},
        ]
        before = [dict(r) for r in rows]
        upcast_cycle_rows(rows)
        self.assertEqual(rows, before)


if __name__ == "__main__":
    unittest.main()
