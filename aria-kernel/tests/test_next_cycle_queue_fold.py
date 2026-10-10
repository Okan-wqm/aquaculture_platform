"""ARIA-MEDIUM-428 — the next-cycle queue holds one live item per pressure.

aria/state f5c5c86a1: ``read_pending`` returned 32 items (``DEFAULT_QUEUE_DEPTH``)
holding 10 pressures, and ``append_pending`` of a new pressure wrote
``state: blocked, queue_depth_exceeded``. 27 of the 32 had been consumed in
September and put back by the anchor-stale disposition
(``reoffer_item``, ARIA-HIGH-360), which asked about the item and never about
its pressure; the drain then left them pending because request admission
refused it (backlog over the drain budget). The C10 dedupe in
``append_pending`` only refused a SECOND pending row for a new pressure.

Pins:

* the fold keeps, per pressure, the item enqueued last; its siblings are
  superseded by an appended row, once, and the old ledger bytes are kept;
* the depth cap counts live pressures, so a new pressure is admitted;
* consuming the live item does not bring a superseded sibling back;
* a re-offer of an item whose pressure is live writes nothing and returns
  ``REOFFER_ALREADY_PENDING``, which the anchor-stale disposition records as
  re-offered (no operator item);
* an item not offered within the request-anchor window expires, and the next
  reflection queues its pressure again with that night's snapshot.
"""
from __future__ import annotations

import os
import shutil
import tempfile
import unittest
from collections import Counter
from datetime import timedelta
from pathlib import Path
from typing import Any
from unittest import mock

from aria_kernel import next_cycle_queue as queue_module
from aria_kernel.anchor_stale_effects import DISPOSITION_REOFFERED
from aria_kernel.ledger import load_jsonl, state_transaction
from aria_kernel.next_cycle_queue import (
    ANSWERED_REASON,
    EXPIRED,
    EXPIRED_REASON,
    QUEUE_DEPTH_ENV,
    REOFFER_ALREADY_PENDING,
    REOFFER_QUEUE_FULL,
    REOFFERED,
    SUPERSEDED,
    SUPERSEDED_REASON,
    append_pending,
    defer_projection,
    item_max_age_seconds,
    mark_consumed,
    queue_path,
    read_pending,
    reoffer_item,
)
from aria_kernel.runtime_profile import set_profile
from aria_kernel.tool_registry import utc_now
from tests import test_autonomy_orchestrator as orchestrator_fixtures
from tests._helpers.anchor_stale_store import AnchorStaleStore
from tests.test_failed_cycle_reflection import _PRESSURE_ID, _payload_failed_cycle_runner


class _QueueStore(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="aria-428-"))
        self.base = self.tmp / "aria-tools"
        set_profile("standard", operator_approval_ref="aria-428", base_dir=self.base)
        self._prior_depth = os.environ.pop(QUEUE_DEPTH_ENV, None)
        self._legacy = 0

    def tearDown(self) -> None:
        shutil.rmtree(self.tmp, ignore_errors=True)
        if self._prior_depth is not None:
            os.environ[QUEUE_DEPTH_ENV] = self._prior_depth
        else:
            os.environ.pop(QUEUE_DEPTH_ENV, None)

    def legacy_pending(self, pressure_id: str, *, cycle: str) -> str:
        """A pending item as the pre-C10 writer appended it: no pressure dedupe."""
        self._legacy += 1
        qid = f"qi-legacy{self._legacy:04d}"
        path = queue_path(self.base)
        path.parent.mkdir(parents=True, exist_ok=True)
        with state_transaction([path]) as txn:
            txn.append_declared_jsonl(path, {
                "schema_version": 1, "queue_item_id": qid, "source_cycle_id": cycle,
                "pressure_id": pressure_id, "recommended_action": "act", "candidate_tools": [],
                "state": "pending", "recorded_at": utc_now(),
            }, expected_surface="next_cycle_queue")
        return qid

    def legacy_reoffer(self, qid: str) -> None:
        """The pre-fix ``reoffer_item`` row: the item's pressure never asked."""
        path = queue_path(self.base)
        with state_transaction([path]) as txn:
            txn.append_declared_jsonl(path, {
                "schema_version": 1, "queue_item_id": qid, "state": "pending",
                "reoffered_reason": "anchor_stale:AIR-legacy", "recorded_at": utc_now(),
            }, expected_surface="next_cycle_queue")

    def rows(self) -> list[dict[str, Any]]:
        path = queue_path(self.base)
        return load_jsonl(path, verify=True) if path.exists() else []

    def ledger_bytes(self) -> bytes:
        return queue_path(self.base).read_bytes()


class OneLiveItemPerPressure(_QueueStore):
    def seed_production_shape(self) -> dict[str, list[str]]:
        """Three pressures, four items each: 12 pending rows, 3 pressures."""
        items: dict[str, list[str]] = {}
        for night in range(4):
            for pressure in ("pressure:a", "pressure:b", "pressure:c"):
                items.setdefault(pressure, []).append(self.legacy_pending(pressure, cycle=f"cyc-{night}"))
        return items

    def test_the_cap_counts_pressures_and_a_new_pressure_is_admitted(self) -> None:
        os.environ[QUEUE_DEPTH_ENV] = "4"
        items = self.seed_production_shape()
        live = read_pending(self.base)
        # One per pressure, the item enqueued last, in enqueue order.
        self.assertEqual([row["queue_item_id"] for row in live], [items[p][-1] for p in ("pressure:a", "pressure:b", "pressure:c")])
        self.assertEqual([row["source_cycle_id"] for row in live], ["cyc-3"] * 3)

        before = self.ledger_bytes()
        admitted = append_pending(self.base, source_cycle_id="cyc-4", pressure_id="pressure:new")
        assert admitted is not None
        self.assertEqual(admitted["state"], "pending")
        self.assertEqual(len(read_pending(self.base)), 4)
        # Append-only: every earlier byte is still there.
        self.assertTrue(self.ledger_bytes().startswith(before))
        superseded = [row for row in self.rows() if row.get("state") == SUPERSEDED]
        self.assertEqual(len(superseded), 9)
        for row in superseded:
            self.assertEqual(row["reason"], SUPERSEDED_REASON)
            self.assertEqual(row["superseded_by"], items[row["pressure_id"]][-1])

        # The cap is now full of distinct pressures; the fifth is refused.
        blocked = append_pending(self.base, source_cycle_id="cyc-4", pressure_id="pressure:fifth")
        assert blocked is not None
        self.assertEqual((blocked["state"], blocked["pending_count"]), ("blocked", 4))

    def test_the_verdicts_are_written_once(self) -> None:
        self.seed_production_shape()
        append_pending(self.base, source_cycle_id="cyc-4", pressure_id="pressure:new")
        count = len(self.rows())
        # A second writer, and a re-enqueue of a live pressure, append nothing.
        standing = append_pending(self.base, source_cycle_id="cyc-5", pressure_id="pressure:a")
        assert standing is not None
        self.assertEqual(standing["source_cycle_id"], "cyc-3")
        self.assertEqual(len(self.rows()), count)
        self.assertEqual(Counter(row["state"] for row in self.rows())[SUPERSEDED], 9)

    def test_a_reader_never_sees_a_duplicate_before_any_writer(self) -> None:
        self.seed_production_shape()
        before = self.ledger_bytes()
        self.assertEqual(len(read_pending(self.base)), 3)
        self.assertEqual(self.ledger_bytes(), before, "read_pending is a pure read")

    def test_the_freshest_snapshot_is_kept_over_an_older_reoffered_item(self) -> None:
        # Production: qi-8ff3447c3894 (cycle 2026-09-19, re-offered 10-08) beside
        # qi-5fe46ad90ba9 (cycle 2026-10-07) for one pressure.
        older = self.legacy_pending("pressure:a", cycle="cyc-1")
        mark_consumed(self.base, queue_item_id=older, consumed_by="drain")
        newer = self.legacy_pending("pressure:a", cycle="cyc-2")
        self.legacy_reoffer(older)
        self.assertEqual([(row["queue_item_id"], row["source_cycle_id"]) for row in read_pending(self.base)],
                         [(newer, "cyc-2")])

    def test_consuming_the_live_item_does_not_bring_a_sibling_back(self) -> None:
        older = self.legacy_pending("pressure:a", cycle="cyc-1")
        newer = self.legacy_pending("pressure:a", cycle="cyc-2")
        self.assertEqual([row["queue_item_id"] for row in read_pending(self.base)], [newer])
        mark_consumed(self.base, queue_item_id=newer, consumed_by="drain")
        self.assertEqual(read_pending(self.base), [])
        states = {row["queue_item_id"]: row["state"] for row in self.rows()}
        self.assertEqual(states, {older: SUPERSEDED, newer: "consumed"})


class AReofferAsksAboutThePressure(_QueueStore):
    def test_a_reoffer_beside_a_live_sibling_writes_nothing(self) -> None:
        first = append_pending(self.base, source_cycle_id="cyc-1", pressure_id="pressure:a")
        assert first is not None
        mark_consumed(self.base, queue_item_id=first["queue_item_id"], consumed_by="drain")
        second = append_pending(self.base, source_cycle_id="cyc-2", pressure_id="pressure:a")
        assert second is not None
        count = len(self.rows())
        # The pre-fix reoffer appended a second live row for pressure:a here.
        self.assertEqual(
            reoffer_item(self.base, queue_item_id=first["queue_item_id"], reason="anchor_stale:AIR-x"),
            REOFFER_ALREADY_PENDING,
        )
        self.assertEqual(len(self.rows()), count)
        self.assertEqual([row["queue_item_id"] for row in read_pending(self.base)], [second["queue_item_id"]])

    def test_the_full_check_counts_pressures(self) -> None:
        os.environ[QUEUE_DEPTH_ENV] = "2"
        for night in range(3):
            self.legacy_pending("pressure:a", cycle=f"cyc-{night}")
            self.legacy_pending("pressure:b", cycle=f"cyc-{night}")
        # The cap is full: two pressures, six pending rows.
        third = self.legacy_pending("pressure:c", cycle="cyc-0")
        mark_consumed(self.base, queue_item_id=third, consumed_by="drain")
        self.assertEqual(reoffer_item(self.base, queue_item_id=third, reason="anchor_stale:AIR-c"),
                         REOFFER_QUEUE_FULL)
        os.environ[QUEUE_DEPTH_ENV] = "3"
        self.assertEqual(reoffer_item(self.base, queue_item_id=third, reason="anchor_stale:AIR-c"), REOFFERED)
        self.assertEqual(len(read_pending(self.base)), 3)


class AnItemAgesOutByTheAnchorWindow(_QueueStore):
    def later(self, seconds: int) -> mock._patch:
        now = queue_module._now() + timedelta(seconds=seconds)
        return mock.patch.object(queue_module, "_now", return_value=now)

    def test_an_item_not_offered_within_the_window_expires(self) -> None:
        window = item_max_age_seconds(self.base)
        queued = append_pending(self.base, source_cycle_id="cyc-1", pressure_id="pressure:a")
        assert queued is not None
        with self.later(window - 60):
            self.assertEqual(len(read_pending(self.base)), 1)
        with self.later(window + 60):
            self.assertEqual(read_pending(self.base), [])
            # The pressure still holds: the next reflection queues it again,
            # with that cycle's snapshot, and the aged item is recorded.
            fresh = append_pending(self.base, source_cycle_id="cyc-9", pressure_id="pressure:a")
        assert fresh is not None
        self.assertNotEqual(fresh["queue_item_id"], queued["queue_item_id"])
        self.assertEqual([row["source_cycle_id"] for row in read_pending(self.base)], ["cyc-9"])
        expired = [row for row in self.rows() if row.get("state") == EXPIRED]
        self.assertEqual(len(expired), 1)
        self.assertEqual(
            (expired[0]["queue_item_id"], expired[0]["reason"], expired[0]["max_age_seconds"]),
            (queued["queue_item_id"], EXPIRED_REASON, window),
        )

    def test_a_drain_pass_across_the_window_never_ages_what_it_acts_on(self) -> None:
        # Review of 314c6a18e (zai): the drain reads, then writes one row per
        # item; the window can close in between.
        window = item_max_age_seconds(self.base)
        x = append_pending(self.base, source_cycle_id="cyc-1", pressure_id="pressure:x")
        y = append_pending(self.base, source_cycle_id="cyc-1", pressure_id="pressure:y")
        assert x is not None and y is not None
        with self.later(window - 5):
            self.assertEqual(len(read_pending(self.base)), 2)
        with self.later(window + 5):
            mark_consumed(self.base, queue_item_id=y["queue_item_id"], consumed_by="drain")
            self.assertEqual(defer_projection(self.base, queue_item_id=x["queue_item_id"],
                                              reason="host_fault", budget=3), 1)
            mark_consumed(self.base, queue_item_id=x["queue_item_id"], consumed_by="drain")
        self.assertEqual(
            [(row["queue_item_id"], row["state"]) for row in self.rows()],
            [(x["queue_item_id"], "pending"), (y["queue_item_id"], "pending"),
             (y["queue_item_id"], "consumed"), (x["queue_item_id"], "pending"),
             (x["queue_item_id"], "consumed")],
        )

    def test_a_reoffer_is_a_new_offer(self) -> None:
        window = item_max_age_seconds(self.base)
        queued = append_pending(self.base, source_cycle_id="cyc-1", pressure_id="pressure:a")
        assert queued is not None
        mark_consumed(self.base, queue_item_id=queued["queue_item_id"], consumed_by="drain")
        with self.later(window - 60), mock.patch.object(
            queue_module, "utc_now", return_value=(queue_module._now() + timedelta(seconds=window - 60))
            .replace(microsecond=0).isoformat(),
        ):
            self.assertEqual(reoffer_item(self.base, queue_item_id=queued["queue_item_id"], reason="anchor_stale:AIR-a"),
                             REOFFERED)
        with self.later(window + 60):
            self.assertEqual([row["queue_item_id"] for row in read_pending(self.base)], [queued["queue_item_id"]])

    def test_an_aged_sibling_never_supersedes_a_reoffered_item(self) -> None:
        # Review of a1b060050 (zai): A consumed; B enqueued for the same
        # pressure an hour later and never drained; past the window, A's
        # request dies and the anchor-stale disposition re-offers A. Nothing
        # recorded B's expiry, and B (the newer enqueue) superseded A.
        window = item_max_age_seconds(self.base)
        start = queue_module._now()

        def at(seconds: int) -> Any:
            moment = start + timedelta(seconds=seconds)
            return mock.patch.multiple(queue_module, _now=mock.Mock(return_value=moment),
                                       utc_now=mock.Mock(return_value=moment.replace(microsecond=0).isoformat()))

        with at(0):
            a = append_pending(self.base, source_cycle_id="cyc-1", pressure_id="pressure:a")
            assert a is not None
            mark_consumed(self.base, queue_item_id=a["queue_item_id"], consumed_by="drain")
        with at(3600):
            b = append_pending(self.base, source_cycle_id="cyc-2", pressure_id="pressure:a")
            assert b is not None
        with at(3600 + window + 60):
            self.assertEqual(reoffer_item(self.base, queue_item_id=a["queue_item_id"], reason="anchor_stale:AIR-a"),
                             REOFFERED)
            self.assertEqual([row["queue_item_id"] for row in read_pending(self.base)], [a["queue_item_id"]])
            # The next enqueue records B aged, and A stays the pressure's item.
            standing = append_pending(self.base, source_cycle_id="cyc-3", pressure_id="pressure:a")
            assert standing is not None
            self.assertEqual(standing["queue_item_id"], a["queue_item_id"])
        states = {(row["queue_item_id"], row["state"]) for row in self.rows() if row["state"] in (EXPIRED, SUPERSEDED)}
        self.assertEqual(states, {(b["queue_item_id"], EXPIRED)})

    def test_a_consumed_item_answers_its_siblings_whatever_the_clock(self) -> None:
        # Review of b55765234 (zai): legacy siblings with no recorded verdict;
        # the drain reads X live, X ages before its consumed row, and the
        # fresher sibling Y would have become live and been projected again.
        window = item_max_age_seconds(self.base)
        start = queue_module._now()

        def stamp(seconds: int) -> str:
            return (start + timedelta(seconds=seconds)).replace(microsecond=0).isoformat()

        def at(seconds: int) -> Any:
            moment = start + timedelta(seconds=seconds)
            return mock.patch.multiple(queue_module, _now=mock.Mock(return_value=moment),
                                       utc_now=mock.Mock(return_value=stamp(seconds)))

        path = queue_path(self.base)
        path.parent.mkdir(parents=True, exist_ok=True)
        legacy = [
            {"queue_item_id": "qi-y", "state": "pending", "pressure_id": "pressure:a", "source_cycle_id": "c1",
             "recorded_at": stamp(0)},
            {"queue_item_id": "qi-x", "state": "pending", "pressure_id": "pressure:a", "source_cycle_id": "c2",
             "recorded_at": stamp(3600)},
            {"queue_item_id": "qi-y", "state": "consumed", "recorded_at": stamp(7200)},
            {"queue_item_id": "qi-y", "state": "pending", "reoffered_reason": "anchor_stale:AIR-y",
             "recorded_at": stamp(10800)},
        ]
        with state_transaction([path]) as txn:
            for row in legacy:
                txn.append_declared_jsonl(path, {"schema_version": 1, **row}, expected_surface="next_cycle_queue")
        with at(3600 + window - 5):
            self.assertEqual([row["queue_item_id"] for row in read_pending(self.base)], ["qi-x"])
        with at(3600 + window + 30):
            mark_consumed(self.base, queue_item_id="qi-x", consumed_by="drain")
            self.assertEqual(read_pending(self.base), [])
        answered = [row for row in self.rows() if row.get("state") == SUPERSEDED]
        self.assertEqual([(row["queue_item_id"], row["superseded_by"], row["reason"]) for row in answered],
                         [("qi-y", "qi-x", ANSWERED_REASON)])

    def test_an_undateable_offer_buys_no_slot(self) -> None:
        path = queue_path(self.base)
        path.parent.mkdir(parents=True, exist_ok=True)
        with state_transaction([path]) as txn:
            txn.append_declared_jsonl(path, {
                "schema_version": 1, "queue_item_id": "qi-undated", "source_cycle_id": "cyc-1",
                "pressure_id": "pressure:a", "state": "pending", "recorded_at": "not-a-stamp",
            }, expected_surface="next_cycle_queue")
        self.assertEqual(read_pending(self.base), [])


class TheAnchorStaleDispositionRecordsAReoffer(AnchorStaleStore):
    def test_an_expired_request_beside_a_live_sibling_is_no_operator_item(self) -> None:
        first = append_pending(self.tools, source_cycle_id="c1", pressure_id="p1", recommended_action="act")
        assert first is not None
        qid = str(first["queue_item_id"])
        mark_consumed(self.tools, queue_item_id=qid, consumed_by="daemon")
        sibling = append_pending(self.tools, source_cycle_id="c2", pressure_id="p1", recommended_action="act")
        assert sibling is not None
        prompt = f'{{"$schema": "aria/next-cycle-queue-request/v1", "queue_item_id": "{qid}"}}'
        self.seed_row("AIR-maint-sibling", role="maintenance_utility", target_agent="aria-autonomy-planner",
                      prompt=prompt)
        rows = len(load_jsonl(queue_path(self.tools), verify=True))
        self.sweep()
        record = self.record("AIR-maint-sibling")
        self.assertEqual(record["status"], "resolved")
        self.assertEqual(
            (record["kernel_disposition"]["disposition"], record["kernel_disposition"]["reason"]),
            (DISPOSITION_REOFFERED, f"queue_item_{REOFFER_ALREADY_PENDING}"),
        )
        self.assertEqual(len(load_jsonl(queue_path(self.tools), verify=True)), rows)
        self.assertEqual([row["queue_item_id"] for row in read_pending(self.tools)], [sibling["queue_item_id"]])


class AnAgedPressureIsQueuedAgainByTheNextReflection(unittest.TestCase):
    """No work is lost to aging: the real orchestrator, two fail-closed nights
    (``test_failed_cycle_reflection``'s production shape), the clock moved past
    the window between them."""

    _run = orchestrator_fixtures.AutonomyOrchestratorTests._run

    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="aria-428-night-"))
        self.base = self.tmp / "aria-tools"
        set_profile("standard", operator_approval_ref="aria-428", base_dir=self.base)

    def tearDown(self) -> None:
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_the_next_reflection_queues_the_pressure_with_its_own_snapshot(self) -> None:
        first_night = self._run(cycle_runner=_payload_failed_cycle_runner)["per_cycle"][0]["cycle_id"]
        [queued] = read_pending(self.base)
        self.assertEqual((queued["pressure_id"], queued["source_cycle_id"]), (_PRESSURE_ID, first_night))

        later = queue_module._now() + timedelta(seconds=item_max_age_seconds(self.base) + 3600)
        with mock.patch.object(queue_module, "_now", return_value=later), \
                mock.patch.object(queue_module, "utc_now", return_value=later.replace(microsecond=0).isoformat()):
            second_night = self._run(cycle_runner=_payload_failed_cycle_runner)["per_cycle"][0]["cycle_id"]
            live = read_pending(self.base)
        self.assertNotEqual(second_night, first_night)
        self.assertEqual([(row["pressure_id"], row["source_cycle_id"]) for row in live], [(_PRESSURE_ID, second_night)])
        self.assertNotEqual(live[0]["queue_item_id"], queued["queue_item_id"])
        expired = [row for row in load_jsonl(queue_path(self.base), verify=True) if row.get("state") == EXPIRED]
        self.assertEqual([row["queue_item_id"] for row in expired], [queued["queue_item_id"]])


if __name__ == "__main__":
    unittest.main()
