"""ARIA-LOW-741 (package F3.1) — the plan ledger carries a delivered change's decision stamp, and refuses a malformed one.

WHAT BASE DOES TODAY. ``record_implementation_outcome`` writes the outcome of a delivered change
(``implementation_outcome_recorded``) with eight facts and no stamp; the reducer keeps those eight on
``state["implementation"]``; ``plan_convergence_bridge._dispatch_implementation`` reads the outcome record off the
submitted envelope and passes the same eight. A route and a size stamped by the executor on that record are dropped
at the bridge, so nothing downstream (the episode reader, the scorecards) can ever see them.

WHAT THIS PINS (real writers: ``drive_plan_to_implementation_requested`` + ``record_implementation_started``, as
``test_implementation_lifecycle_continuity._to_recorded`` builds a RECORDED plan):

* ``record_implementation_outcome(..., decision_stamp=S)`` puts ``S`` in the event payload and in
  ``fold_plan_state(...)["implementation"]["decision_stamp"]``; WITHOUT the argument the key is not in the payload
  at all (an old caller's event, its canonical payload and its idempotency key keep their exact bytes) and the
  folded value is ``None``; the stamp is part of the canonical payload, so a repeat of the same call is
  ``idempotent`` and a different stamp is not;
* a malformed stamp is refused at the writer AND at every fold (the validator runs on load), by
  ``decision_stamp_invalid``; the shape's own owner is ``aria_kernel.decision_stamp`` (``test_decision_stamp``);
* the bridge passes the stamp of ``details.implementation`` through, and a legacy envelope without one is not refused.

NEW API. The ``decision_stamp`` parameter is reached through ``_takes_a_stamp()``, which raises ``AssertionError`` at
base, so each test is red by assertion and not by ``TypeError``.
"""
from __future__ import annotations

import inspect
import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from aria_kernel import plan_convergence_bridge as bridge
from aria_kernel.digest import sha256_digest_text
from aria_kernel.ledger import load_jsonl
from aria_kernel.plan_convergence import (
    events_path,
    fold_plan_state,
    record_implementation_outcome,
    record_implementation_started,
)
from aria_kernel.tool_registry import GovernanceError
from tests._helpers.declared_fixtures import append_declared_fixture
from tests.test_implementation_lifecycle_continuity import drive_plan_to_implementation_requested, seed_reviewer_agent

STAMP = {
    "schema_version": 1,
    "route": {"provider": "zai", "model": "glm-5.3"},
    "numstat": [{"path": "x.ts", "added": 1, "deleted": 1}],
}
OTHER_STAMP = {
    "schema_version": 1,
    "route": {"provider": "anthropic", "model": "claude-opus-5"},
    "numstat": [{"path": "y.ts", "added": 2, "deleted": 0}],
}
OUTCOME = {
    "claim_id": "claim-1", "pr_url": "https://github.com/o/r/pull/4242", "diff_hash": "sha256:" + "c" * 64,
    "branch_tip_sha": "d" * 40, "base_branch_sha": "e" * 40, "validation_results": [], "signer_key_fp": "fp-1",
    "completed_at": "2026-08-12T10:30:00Z",
}


def _takes_a_stamp() -> None:
    if "decision_stamp" not in inspect.signature(record_implementation_outcome).parameters:
        raise AssertionError("F3.1: record_implementation_outcome takes no decision_stamp (the ledger cannot carry it)")


class _PlanLedger(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory(prefix="aria-f31-ledger-")
        self.addCleanup(self._tmp.cleanup)
        self.tools = Path(self._tmp.name) / "aria-tools"
        self.root = Path(self._tmp.name) / "workspace"
        seed_reviewer_agent(self.root)

    def requested(self, plan_id: str) -> None:
        drive_plan_to_implementation_requested(plan_id=plan_id, tools=self.tools, workspace_root=self.root)

    def in_flight(self, plan_id: str) -> None:
        self.requested(plan_id)
        record_implementation_started(plan_id=plan_id, claim_id="claim-1", implementer_agent="aria-implementer",
                                      started_at="2026-08-12T10:00:00Z", base_dir=self.tools)

    def outcome(self, plan_id: str, **extra: object) -> dict:
        return record_implementation_outcome(plan_id=plan_id, base_dir=self.tools, **OUTCOME, **extra)

    def outcome_events(self, plan_id: str) -> list[dict]:
        return [row for row in load_jsonl(events_path(self.tools))
                if row["plan_id"] == plan_id and row["event_type"] == "implementation_outcome_recorded"]

    def state(self, plan_id: str) -> dict:
        return fold_plan_state(plan_id=plan_id, base_dir=self.tools)


class TheOutcomeRecordCarriesTheStampTests(_PlanLedger):
    def test_a_stamp_given_is_in_the_event_payload_and_in_the_fold(self) -> None:
        _takes_a_stamp()
        self.in_flight("plan-s")
        result = self.outcome("plan-s", decision_stamp=STAMP)
        self.assertEqual(result["event"]["payload"]["decision_stamp"], STAMP)
        [recorded] = self.outcome_events("plan-s")
        self.assertEqual(recorded["payload"]["decision_stamp"], STAMP)
        state = self.state("plan-s")
        self.assertEqual(state["state"], "IMPLEMENTATION_RECORDED")
        self.assertEqual(state["implementation"]["decision_stamp"], STAMP)
        # The other seven facts are where they were.
        self.assertEqual(state["implementation"]["branch_tip_sha"], "d" * 40)

    def test_without_the_argument_the_event_keeps_its_exact_bytes_and_the_fold_holds_none(self) -> None:
        _takes_a_stamp()
        # A plan recorded WITH a stamp, so this test is about the contrast and is red where the carrier is absent.
        self.in_flight("plan-with")
        self.outcome("plan-with", decision_stamp=STAMP)
        self.assertIn("decision_stamp", self.outcome_events("plan-with")[0]["payload"])
        # An old caller's call: no argument, no key, no new bytes.
        self.in_flight("plan-old")
        result = self.outcome("plan-old")
        self.assertEqual(result["event"]["payload"], OUTCOME)
        self.assertNotIn("decision_stamp", self.outcome_events("plan-old")[0]["payload"])
        legacy_key = sha256_digest_text("plan-old|record-implementation-outcome|" + json.dumps(
            OUTCOME, sort_keys=True, separators=(",", ":"), ensure_ascii=True))
        self.assertEqual(result["event"]["idempotency_key"], legacy_key, "an old call's canonical payload changed")
        state = self.state("plan-old")
        self.assertEqual(state["state"], "IMPLEMENTATION_RECORDED")
        self.assertIn("decision_stamp", state["implementation"])
        self.assertIsNone(state["implementation"]["decision_stamp"])

    def test_a_request_not_yet_recorded_holds_a_none_stamp(self) -> None:
        _takes_a_stamp()
        self.requested("plan-r")
        self.assertIn("decision_stamp", self.state("plan-r")["implementation"])
        self.assertIsNone(self.state("plan-r")["implementation"]["decision_stamp"])

    def test_the_stamp_is_part_of_the_canonical_payload(self) -> None:
        _takes_a_stamp()
        self.in_flight("plan-i")
        first = self.outcome("plan-i", decision_stamp=STAMP)
        again = self.outcome("plan-i", decision_stamp=STAMP)
        self.assertEqual((first["idempotent"], again["idempotent"], again["event_appended"]), (False, True, False))
        self.assertEqual(len(self.outcome_events("plan-i")), 1)
        # A DIFFERENT stamp for the same outcome is not the same call: it must not be answered as an idempotent repeat
        # (which would silently drop the new stamp); the plan is RECORDED, so the writer refuses it as a transition.
        with self.assertRaises(GovernanceError):
            self.outcome("plan-i", decision_stamp=OTHER_STAMP)
        self.assertEqual(self.state("plan-i")["implementation"]["decision_stamp"], STAMP)


class AMalformedStampIsRefusedEverywhereTests(_PlanLedger):
    MALFORMED = {
        "an extra top-level key": {**STAMP, "totals": {"files": 1}},
        "a schema version that is not 1": {**STAMP, "schema_version": 2},
        "an empty numstat": {**STAMP, "numstat": []},
    }

    def test_the_writer_refuses_it_and_records_nothing(self) -> None:
        _takes_a_stamp()
        self.in_flight("plan-w")
        for name, bad in self.MALFORMED.items():
            with self.subTest(malformed=name), self.assertRaisesRegex(GovernanceError, "decision_stamp_invalid"):
                self.outcome("plan-w", decision_stamp=bad)
        self.assertEqual(self.outcome_events("plan-w"), [])
        self.assertEqual(self.state("plan-w")["state"], "IMPLEMENTATION_IN_FLIGHT")
        # The control: the same call with a valid stamp goes through.
        self.outcome("plan-w", decision_stamp=STAMP)
        self.assertEqual(self.state("plan-w")["state"], "IMPLEMENTATION_RECORDED")

    def _raw_outcome(self, plan_id: str, stamp: object) -> None:
        append_declared_fixture(events_path(self.tools), {
            "schema_version": 1, "event_id": f"{plan_id}:raw-outcome", "event_type": "implementation_outcome_recorded",
            "plan_id": plan_id, "recorded_at": "2026-08-12T10:30:00+00:00", "idempotency_key": "sha256:" + "9" * 64,
            "payload": {**OUTCOME, "decision_stamp": stamp},
        }, expected_surface="plan_convergence_events")

    def test_the_same_payload_appended_past_the_writer_makes_every_fold_refuse_it(self) -> None:
        _takes_a_stamp()
        # The control first: a raw event carrying a VALID stamp folds, so the refusal below is the stamp's.
        self.in_flight("plan-ok")
        self._raw_outcome("plan-ok", STAMP)
        self.assertEqual(self.state("plan-ok")["implementation"]["decision_stamp"], STAMP)
        for index, (name, bad) in enumerate(self.MALFORMED.items()):
            plan_id = f"plan-raw-{index}"
            with self.subTest(malformed=name):
                self.in_flight(plan_id)
                self._raw_outcome(plan_id, bad)
                with self.assertRaisesRegex(GovernanceError, "decision_stamp_invalid"):
                    self.state(plan_id)


class TheBridgePassesTheStampThroughTests(_PlanLedger):
    """``_dispatch_implementation`` reads the outcome record off the submitted envelope and records it."""

    def _dispatch(self, plan_id: str, record: dict) -> dict:
        request = {"request_id": "AIR-1", "cycle_id": "cyc-1", "target_agent": "aria-implementer"}
        # The commit-identity check has its own pins (test_implementation_delivery, the V3.1-B2 followup); here the
        # subject is what the bridge carries from the record to the ledger.
        with mock.patch.object(bridge, "verify_implementation_commit"):
            return bridge._dispatch_implementation(
                request=request, response={"claim_id": "claim-1"}, details={"implementation": record}, plan_id=plan_id,
                base_dir=self.tools, record_implementation_outcome=record_implementation_outcome, workspace_root=self.root,
            )

    def test_a_stamped_record_is_recorded_with_its_stamp(self) -> None:
        _takes_a_stamp()
        self.requested("plan-b")
        self._dispatch("plan-b", {**OUTCOME, "decision_stamp": STAMP})
        self.assertEqual(self.state("plan-b")["state"], "IMPLEMENTATION_RECORDED")
        self.assertEqual(self.outcome_events("plan-b")[0]["payload"]["decision_stamp"], STAMP)
        self.assertEqual(self.state("plan-b")["implementation"]["decision_stamp"], STAMP)

    def test_a_legacy_record_without_a_stamp_is_recorded_without_the_key_and_not_refused(self) -> None:
        _takes_a_stamp()
        # Contrast in the same test, so base is red for the carrier and not green for the legacy half alone.
        self.requested("plan-stamped")
        self._dispatch("plan-stamped", {**OUTCOME, "decision_stamp": STAMP})
        self.assertIn("decision_stamp", self.outcome_events("plan-stamped")[0]["payload"])
        self.requested("plan-legacy")
        self._dispatch("plan-legacy", dict(OUTCOME))
        self.assertEqual(self.state("plan-legacy")["state"], "IMPLEMENTATION_RECORDED")
        self.assertNotIn("decision_stamp", self.outcome_events("plan-legacy")[0]["payload"])
        self.assertIsNone(self.state("plan-legacy")["implementation"]["decision_stamp"])


if __name__ == "__main__":
    unittest.main()
