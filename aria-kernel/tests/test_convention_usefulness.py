"""ARIA-MEDIUM-129 — whether a convention a prompt carried helped is measured.

The knowledge graph records that a learned convention entered a request's
envelope (``established_knowledge.conventions[].pattern_id``, stamped at mint
by ``agent_invocations``) and nothing ever joined that use to what the work
became, so "ARIA learns" could be neither shown nor refuted.
``convention_usefulness.measure_convention_lift`` joins every
convention-bearing request to its outcome — the change-outcome verdict of the
change it produced, else the work verdict of the request itself — and
compares each convention with the requests of the same role and path family
that carried none. The fixtures write the request, result and change-outcome
ledgers under their declared surfaces (``ledger.append_declared_jsonl``), the
rows shaped as their producers shape them, and the measurement reads them
through its owners' readers; only the two fault cases stand a reader in.
"""
from __future__ import annotations

import shutil
import tempfile
import unittest
from pathlib import Path
from typing import Any
from unittest import mock

from aria_kernel.convention_usefulness import (
    MIN_CONVENTION_SAMPLES,
    measure_convention_lift,
)
from aria_kernel.ledger import LedgerIntegrityError, append_declared_jsonl
from aria_kernel.tool_registry import ensure_tools_dir


class _Store:
    """A tools root whose request, result and change-outcome ledgers are
    written under their declared surfaces, in the shapes their producers
    write: the request row as ``agent_invocations`` mints it (with the
    ``established_knowledge`` it stamps, and ``implementation_ids`` for work
    that produced a change), the work verdict as a results row, and the
    change's verdict as a ``change_outcome`` event. The measurement reads
    them through its owners' readers, unmocked."""

    def __init__(self, root: Path) -> None:
        self.tools = ensure_tools_dir(root / "tools")

    def request(
        self,
        request_id: str,
        *,
        conventions: tuple[str, ...] = (),
        state: str = "ACCEPTED",
        role: str = "implementation",
        path: str = "apps/farm-service/src/pond.ts",
        change_verdict: str | None = None,
    ) -> None:
        row: dict[str, Any] = {
            "request_id": request_id, "role": role, "evidence_refs": [f"{path}:1"], "allowed_scope": [path],
            # The shape agent_invocations._established_knowledge_for_refs stamps.
            "established_knowledge": {
                "beliefs": [],
                "conventions": [
                    {"pattern_id": pattern_id, "pattern_type": "convention", "confidence": 0.9,
                     "outcome_status": "verified"}
                    for pattern_id in conventions
                ],
            },
        }
        if state == "CANCELLED":
            row["state"] = "cancelled"
        if change_verdict is not None:
            change_id = f"chg-{request_id}"
            row["implementation_ids"] = {"change_id": change_id, "proposal_id": "p", "branch": "b", "base_sha": "a" * 40}
            append_declared_jsonl(
                self.tools / "change-ledger" / "outcome.jsonl",
                {"$schema": "aria/change-record/v1", "event": "change_outcome", "schema_version": 1,
                 "change_id": change_id, "verdict": change_verdict},
                expected_surface="change_outcome",
            )
        append_declared_jsonl(
            self.tools / "agent-invocations" / "requests.jsonl", row, expected_surface="agent_invocation_requests",
        )
        if state in ("ACCEPTED", "REJECTED"):
            append_declared_jsonl(
                self.tools / "agent-invocations" / "results.jsonl",
                {"request_id": request_id, "role": role, "status": state.lower()},
                expected_surface="agent_invocation_results",
            )
        elif state not in ("PENDING", "CANCELLED"):
            raise AssertionError(f"fixture writes no ledger for state {state}")

    def measure(self) -> dict[str, Any]:
        return measure_convention_lift(base_dir=self.tools)


class ConventionLiftTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="aria-m129-"))
        self.store = _Store(self.tmp)

    def tearDown(self) -> None:
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _matched_baseline(self, *, good: int, bad: int, role: str = "implementation",
                          path: str = "apps/farm-service/src/pond.ts", prefix: str = "base") -> None:
        for index in range(good):
            self.store.request(f"{prefix}-good-{index}", role=role, path=path)
        for index in range(bad):
            self.store.request(f"{prefix}-bad-{index}", role=role, path=path, state="REJECTED")

    def test_a_helpful_and_a_harmful_convention_are_told_apart(self) -> None:
        self._matched_baseline(good=2, bad=2)
        for index in range(3):
            # A's work ends in changes whose benefit the ledgers confirm.
            self.store.request(f"a-{index}", conventions=("conv-A",), change_verdict="gain_confirmed")
        self.store.request("b-0", conventions=("conv-B",), state="REJECTED")
        self.store.request("b-1", conventions=("conv-B",), change_verdict="regression")
        self.store.request("b-2", conventions=("conv-B",), change_verdict="no_gain")

        result = self.store.measure()
        self.assertEqual(result["status"], "measured")
        by_id = {row["pattern_id"]: row for row in result["conventions"]}
        a, b = by_id["conv-A"], by_id["conv-B"]
        self.assertEqual((a["status"], a["n"], a["matched_n"]), ("measured", 3, 3))
        self.assertEqual((a["success_rate"], a["baseline_rate"], a["lift"]), (1.0, 0.5, 0.5))
        self.assertEqual((b["status"], b["n"], b["success_rate"], b["lift"]), ("measured", 3, 0.0, -0.5))
        self.assertEqual(result["baselines"], {"implementation|apps/farm-service": {"n": 4, "successes": 2}})
        self.assertEqual(result["convention_bearing_requests"], 6)

    def test_the_baseline_is_the_same_role_and_path_family(self) -> None:
        # The only convention-free requests are another role and another
        # family: there is nothing to compare A with, so no number is shown.
        self._matched_baseline(good=0, bad=4, role="evidence_judgment")
        self._matched_baseline(good=0, bad=4, path="web/shell/src/app.tsx", prefix="web")
        for index in range(3):
            self.store.request(f"a-{index}", conventions=("conv-A",))
        (a,) = self.store.measure()["conventions"]
        self.assertEqual((a["n"], a["matched_n"]), (3, 0))
        self.assertEqual(a["status"], "undecided:insufficient_samples")
        self.assertIsNone(a["lift"])

    def test_a_convention_below_the_sample_floor_gets_no_number(self) -> None:
        self._matched_baseline(good=2, bad=2)
        for index in range(MIN_CONVENTION_SAMPLES - 1):
            self.store.request(f"a-{index}", conventions=("conv-A",))
        (a,) = self.store.measure()["conventions"]
        self.assertEqual(a["status"], "undecided:insufficient_samples")
        self.assertIsNone(a["lift"])
        self.assertEqual(a["n"], MIN_CONVENTION_SAMPLES - 1)

    def test_work_that_has_no_verdict_yet_or_died_of_queue_mechanics_is_not_an_outcome(self) -> None:
        self._matched_baseline(good=2, bad=2)
        # Unclaimed work has no verdict yet, and cancelled work died of queue
        # mechanics: neither is an outcome.
        for index, state in enumerate(("PENDING", "CANCELLED")):
            self.store.request(f"a-{index}", conventions=("conv-A",), state=state)
        # An unknown change verdict falls through to the work verdict.
        self.store.request("a-unknown", conventions=("conv-A",), change_verdict="unknown", state="REJECTED")
        (a,) = self.store.measure()["conventions"]
        self.assertEqual((a["n"], a["success_rate"]), (1, 0.0))
        self.assertEqual(a["undecided_requests"], 2)

    def test_no_convention_bearing_request_is_not_a_lift_of_zero(self) -> None:
        self._matched_baseline(good=3, bad=1)
        result = self.store.measure()
        self.assertEqual(result["status"], "no_convention_bearing_requests")
        self.assertEqual(result["conventions"], [])

    def test_an_unreadable_ledger_is_named_undecided(self) -> None:
        with mock.patch(
            "aria_kernel.convention_usefulness._load_requests",
            side_effect=LedgerIntegrityError("agent-invocations requests chain broken"),
        ):
            result = measure_convention_lift(base_dir=self.store.tools)
        self.assertEqual(result["status"], "undecided:ledger_unreadable")
        self.assertIn("chain broken", result["reason"])
        self.assertEqual(result["conventions"], [])

    def test_a_programming_error_is_not_laundered_into_undecided(self) -> None:
        with mock.patch("aria_kernel.convention_usefulness._load_requests", side_effect=TypeError("bug")):
            with self.assertRaises(TypeError):
                measure_convention_lift(base_dir=self.store.tools)


class ConventionLiftReadsTheRealLedgersTests(unittest.TestCase):
    """The readers are the owners' readers, and the nightly report carries it."""

    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="aria-m129-"))
        self.tools = ensure_tools_dir(self.tmp / "tools")

    def tearDown(self) -> None:
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_an_empty_store_has_no_convention_bearing_requests(self) -> None:
        result = measure_convention_lift(base_dir=self.tools)
        self.assertEqual(result["status"], "no_convention_bearing_requests")

    def test_the_nightly_fitness_report_carries_the_measurement(self) -> None:
        from aria_kernel.fitness import generate_fitness_report

        store = _Store(self.tmp / "measured")
        for index in range(3):
            store.request(f"base-{index}", state="REJECTED")
            store.request(f"a-{index}", conventions=("conv-A",))
        report = generate_fitness_report(cycle_id="cycle-m129", base_dir=store.tools)
        lift = report["convention_lift"]
        self.assertEqual(lift["status"], "measured")
        self.assertEqual([(row["pattern_id"], row["lift"]) for row in lift["conventions"]], [("conv-A", 1.0)])


class ConventionLiftInTheOperatorInboxTests(unittest.TestCase):
    """ARIA-MEDIUM-129 — the operator inbox surfaces the night's lift.

    The package's step 3 names two surfaces: the nightly fitness report and
    the operator inbox. The inbox reads the measurement from the report that
    measured it (the owner's reader — the inbox never re-measures, so there
    is one measurement per night, stamped with its cycle), and each measured
    convention carries the answer it waits on: whether a lift should couple
    to convention decay is the finding's recorded operator decision. A store
    the night never measured is named in ``undecided``, never shown as an
    empty measurement (the HIGH-108 doctrine)."""

    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="aria-m129-inbox-"))
        self.checkout = self.tmp / "checkout"
        self.checkout.mkdir()

    def tearDown(self) -> None:
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _inbox(self, store: _Store, **kwargs: Any) -> dict[str, Any]:
        from aria_kernel.operator_inbox import read_operator_inbox

        return read_operator_inbox(tools_dir=store.tools, workspace_root=self.checkout, **kwargs)

    def test_the_inbox_carries_the_nights_measurement_from_the_report(self) -> None:
        from aria_kernel.fitness import generate_fitness_report

        store = _Store(self.tmp / "measured")
        for index in range(2):
            store.request(f"base-good-{index}")
            store.request(f"base-bad-{index}", state="REJECTED")
        for index in range(3):
            store.request(f"a-{index}", conventions=("conv-A",))
        for index in range(3):
            store.request(f"b-{index}", conventions=("conv-B",), state="REJECTED")
        generate_fitness_report(cycle_id="cycle-night", base_dir=store.tools)

        inbox = self._inbox(store)
        section = inbox["sections"]["convention_lift"]
        self.assertEqual(section["status"], "measured")
        self.assertEqual((section["measured"], section["harmful"]), (2, 1))
        self.assertEqual(section["report"]["cycle_id"], "cycle-night")
        # The harmful convention first: ARIA keeps serving it, and whether a
        # negative lift should change that is the operator's decision.
        self.assertEqual([item["pattern_id"] for item in section["items"]], ["conv-B", "conv-A"])
        harmful = section["items"][0]
        self.assertEqual((harmful["lift"], harmful["n"], harmful["matched_n"]), (-0.5, 3, 3))
        self.assertIn("ARIA-MEDIUM-129", harmful["answer"])
        self.assertEqual(inbox["undecided"], [])
        # The limit bounds items, never counts.
        limited = self._inbox(store, limit=1)
        bounded = limited["sections"]["convention_lift"]
        self.assertEqual((bounded["measured"], len(bounded["items"])), (2, 1))

    def test_a_store_the_night_never_measured_is_named_not_shown_empty(self) -> None:
        store = _Store(self.tmp / "unmeasured")
        inbox = self._inbox(store)
        self.assertIn("convention_lift:no_fitness_report", inbox["undecided"])
        self.assertNotIn("convention_lift", inbox["sections"])
        self.assertIn("human_required", inbox["sections"], "the other owners are still read")

    def test_a_report_from_before_the_measurement_existed_is_named(self) -> None:
        store = _Store(self.tmp / "pre-measurement")
        append_declared_jsonl(
            store.tools / "fitness" / "fitness-reports.jsonl",
            {"schema_version": 1, "recorded_at": "2026-09-01T00:00:00Z", "cycle_id": "cycle-old",
             "overall_score": 0.0, "dimensions": {}},
            expected_surface="fitness_reports",
        )
        inbox = self._inbox(store)
        self.assertEqual(inbox["undecided"], ["convention_lift:convention_lift_absent"])

    def test_a_night_with_no_convention_bearing_request_is_a_status_not_a_zero(self) -> None:
        from aria_kernel.fitness import generate_fitness_report

        store = _Store(self.tmp / "empty-night")
        generate_fitness_report(cycle_id="cycle-empty", base_dir=store.tools)
        section = self._inbox(store)["sections"]["convention_lift"]
        self.assertEqual(section["status"], "no_convention_bearing_requests")
        self.assertEqual(section["items"], [])
        self.assertEqual(section["report"]["cycle_id"], "cycle-empty")


if __name__ == "__main__":
    unittest.main()
