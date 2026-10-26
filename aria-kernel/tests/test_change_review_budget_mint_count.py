"""WP-D4 round 2 — a change's seats are counted where they are MINTED, and three pins the audit found missing.

The second independent audit of the D4 branch (build/D4/conformance.md, R5)
found that the per-change seat cap is checked when the door DECIDES, not when
the seat is MINTED: ``check_admission_binding`` binds an admission to its role
and its change, and nothing re-counts the change's seats at the mint. Two
sequences that use only the public API take a change past its registered seats
(the audit's probe_seats.py; the policy registers service 3 + lens 1 = 4):

  * ONE admission reused for 8 mints takes 8 seats.
  * 8 admissions decided before any mint (each one sees an empty change and is
    admitted) then 8 mints take 8 seats.

Both are red here at the audited HEAD, each on an assertion (``8 not less than
or equal to 4``); nothing fails at import or collection. The bound that holds
whatever the caller does is the one at the mint: a seat past the registered
seats is refused where it is written, however many decisions were made for it
and whenever. What a refusal is called, and where it is raised from, is not
pinned: only what a reader of the request ledger can count.

  * A green CONTROL: the honest path (one fresh admission per mint) still takes
    every seat the policy registers, and a change at its seats does not hold
    another change's.
  * A green PIN: a role outside ``CHANGE_SEAT_KEYS`` (``goldset_curation``: its
    producer decides with no subject, then names its proposal as the subject of
    the mint) is not counted at the mint, however many requests share a subject.

The audit's three surviving mutants, pinned (green at HEAD, each killed by the
mutation recorded in the commit body; the refusal-row one is also red on the
production code of the commit before the key changed):

  * M13 the refusal row is kept per CHANGE: two changes held at their seats in
    one cycle each keep their own admissions row, and a repeat of one adds none.
  * M24 ``admit_change_claims`` refuses a subject that names no change before
    anything is written (an empty subject would pool every caller's claims).
  * M04 of two claims of equal severity the higher confidence wins the slot.

This is a second new module on purpose: the earlier D4 modules are the
red-first record of the design and of the first audit and are not edited.
"""
from __future__ import annotations

import contextlib
import json
import tempfile
import unittest
from pathlib import Path
from typing import Any

from aria_kernel import genesis_policy, judgment_funnel, request_admission
from aria_kernel.agent_invocations import (
    create_agent_invocation_request,
    list_agent_invocation_requests,
)
from aria_kernel.goldset import GOLDSET_CURATION_ROLE, GOLDSET_CURATOR_AGENT
from aria_kernel.pr_tracking import CHANGE_INTELLIGENCE_AGENT, CHANGE_INTELLIGENCE_ROLE
from aria_kernel.request_admission import admit_request
from aria_kernel.tool_registry import GovernanceError, ensure_tools_dir

SUBJECT = f"change:{'a' * 40}..{'b' * 40}"
OTHER_SUBJECT = f"change:{'a' * 40}..{'c' * 40}"
HEAD = "b" * 40
OPERATOR_PRODUCER = "change_review.operator_subject"
MERGE_PRODUCER = "change_review.merge_feed"
SEAT_REASON = "change_review_seat_cap"
HELD_KIND = "change_review_budget_held"
CAP = 8
# More mints than any registered seat cap: the fixtures assert it, so a policy
# that registered more seats could not turn these tests vacuous unnoticed.
MINTS = 8


def _registered_seats(workspace: Path) -> int:
    """The most discovery seats one change may hold: the registered service seats plus the lens seats."""
    seats = genesis_policy.change_review_policy(workspace)["seats"]
    return seats["service_seats_per_change"] + seats["lens_seats_per_change"]


class _Store(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory(prefix="aria-change-mint-count-")
        self.addCleanup(self._tmp.cleanup)
        self.workspace = Path(self._tmp.name)
        self.tools = ensure_tools_dir(self.workspace / "aria-tools")

    def governance_rows(self) -> list[dict[str, Any]]:
        path = self.tools / "governance.jsonl"
        if not path.exists():
            return []
        return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]

    def governance(self, kind: str) -> list[dict[str, Any]]:
        return [row["details"] for row in self.governance_rows() if row.get("kind") == kind]


class SeatsAreCountedAtTheMintTests(_Store):
    """R5 — however a seat's admission was decided, the change never holds more seats than the policy registers."""

    def _cap(self, mints: int = MINTS) -> int:
        cap = _registered_seats(self.workspace)
        self.assertGreater(cap, 0)
        self.assertLess(cap, mints, "the policy registers as many seats as these tests mint: they would prove nothing")
        return cap

    def _decide(self, label: str, subject: str = SUBJECT) -> request_admission.Admission:
        return admit_request(OPERATOR_PRODUCER, CHANGE_INTELLIGENCE_ROLE, base_dir=self.tools,
                             cycle_id=f"cyc-{label}", subject_ref=subject)

    def _mint(self, admission: request_admission.Admission, label: str, subject: str = SUBJECT) -> dict[str, Any]:
        return create_agent_invocation_request(
            target_agent=CHANGE_INTELLIGENCE_AGENT, role=CHANGE_INTELLIGENCE_ROLE,
            suggested_prompt=f"Review seat {label} of the change {subject}",
            must_satisfy=[{"id": "impact-map", "description": "details.impact_map"}],
            allowed_scope=["**"], subject_ref=subject, cycle_id=f"cyc-{label}", target_sha=HEAD,
            base_dir=self.tools, admission=admission,
        )

    def _seats(self, subject: str = SUBJECT) -> int:
        return sum(1 for row in list_agent_invocation_requests(base_dir=self.tools, role=CHANGE_INTELLIGENCE_ROLE)
                   if row.get("subject_ref") == subject)

    def _mint_all(self, admissions: list[request_admission.Admission], tag: str) -> None:
        """Mint one seat per admission, in order. A refused seat is a GovernanceError; nothing else is tolerated."""
        for index, admission in enumerate(admissions):
            if index == 0:
                # The change holds nothing yet: a refusal here is a broken fixture, not the cap, and
                # swallowing it would let every assertion below pass on an empty ledger.
                self._mint(admission, f"{tag}-{index}")
                continue
            with contextlib.suppress(GovernanceError):
                self._mint(admission, f"{tag}-{index}")

    def test_one_admission_reused_for_more_mints_than_the_cap_never_takes_more_seats_than_the_cap(self) -> None:
        # The audit's probe P-A: the door was asked once, for one seat; the mint ran eight times.
        cap = self._cap()
        admission = self._decide("reused-0")
        self.assertTrue(admission.admitted)

        self._mint_all([admission] * MINTS, "reused")

        seats = self._seats()
        self.assertGreaterEqual(seats, 1, "the first seat, decided for an empty change, was not minted")
        self.assertLessEqual(seats, cap, f"{seats} seats on one change when the policy registers {cap}: "
                                         f"one admission reused for {MINTS} mints")

    def test_admissions_decided_before_any_mint_never_take_more_seats_than_the_cap(self) -> None:
        # The audit's probe P-B: every decision saw an empty change, so the door admitted all of them.
        cap = self._cap()
        admissions = [self._decide(f"early-{index}") for index in range(MINTS)]
        self.assertTrue(admissions[0].admitted, "the first decision sees an empty change")

        self._mint_all(admissions, "early")

        seats = self._seats()
        self.assertGreaterEqual(seats, 1, "the first seat, decided for an empty change, was not minted")
        self.assertLessEqual(seats, cap, f"{seats} seats on one change when the policy registers {cap}: "
                                         f"{MINTS} admissions decided before the first mint")

    def test_the_cap_at_the_mint_is_the_registered_one_not_a_literal(self) -> None:
        # The same sequence under a policy that registers two seats: the bound moves with it.
        block = json.loads((Path(genesis_policy.__file__).resolve().parent / "data"
                            / genesis_policy.DEFAULT_FILENAME).read_text(encoding="utf-8"))["change_review"]
        block["seats"]["service_seats_per_change"] = 1
        block["seats"]["lens_seats_per_change"] = 1
        override = self.workspace / genesis_policy.OVERRIDE_RELPATH
        override.parent.mkdir(parents=True, exist_ok=True)
        override.write_text(json.dumps({"change_review": block}), encoding="utf-8")
        self.assertEqual(self._cap(mints=4), 2)
        admissions = [self._decide(f"narrow-{index}") for index in range(4)]

        self._mint_all(admissions, "narrow")

        seats = self._seats()
        self.assertGreaterEqual(seats, 1)
        self.assertLessEqual(seats, 2, f"{seats} seats on one change when the policy registers 2")

    def test_the_honest_path_still_takes_every_seat_the_policy_registers(self) -> None:
        # Control (green at HEAD and after the fix): one fresh admission per mint, decided just before it.
        cap = self._cap()

        for index in range(cap):
            admission = self._decide(f"honest-{index}")
            self.assertTrue(admission.admitted, f"seat {index + 1} of {cap} was refused at the door")
            self._mint(admission, f"honest-{index}")

        self.assertEqual(self._seats(), cap, "a change did not get the seats the policy registers")
        past = self._decide("honest-past")
        self.assertFalse(past.admitted, "the door must still hold the seat past the registered ones")
        self.assertEqual(past.reason, SEAT_REASON)

    def test_a_change_at_its_seats_does_not_hold_another_changes_seats(self) -> None:
        # Control: the count at the mint is per change. A recount that read every change's seats
        # would refuse the other change's first seat.
        cap = self._cap()
        for index in range(cap):
            self._mint(self._decide(f"full-{index}"), f"full-{index}")
        self.assertEqual(self._seats(), cap)

        for index in range(cap):
            admission = self._decide(f"other-{index}", OTHER_SUBJECT)
            self.assertTrue(admission.admitted)
            self._mint(admission, f"other-{index}", OTHER_SUBJECT)

        self.assertEqual(self._seats(OTHER_SUBJECT), cap, "the second change did not get its own seats")
        self.assertEqual(self._seats(SUBJECT), cap)

    def test_a_role_without_registered_seats_is_not_counted_at_the_mint(self) -> None:
        # Pin (green at HEAD): the goldset producer decides with no subject and names its proposal as
        # the subject of the mint. Its role is not in CHANGE_SEAT_KEYS: nothing counts or refuses it,
        # and a recount that treated every subject as a change would refuse the later ones (or raise
        # for a role with no registered seats).
        self.assertNotIn(GOLDSET_CURATION_ROLE, request_admission.CHANGE_SEAT_KEYS)
        subject = "goldset-proposal:aria-tool:2026-10-25T00:00:00+00:00"

        for index in range(MINTS):
            admission = admit_request("operator_cli.request", GOLDSET_CURATION_ROLE, base_dir=self.tools,
                                      cycle_id=f"cyc-gold-{index}")
            self.assertTrue(admission.admitted)
            create_agent_invocation_request(
                target_agent=GOLDSET_CURATOR_AGENT, role=GOLDSET_CURATION_ROLE,
                suggested_prompt=f"Draft the fixture candidates, round {index}",
                must_satisfy=[{"id": "corpus-draft", "description": "details.proposal lists a candidate per item"}],
                allowed_scope=["**"], subject_ref=subject, cycle_id=f"cyc-gold-{index}", target_sha=HEAD,
                base_dir=self.tools, admission=admission,
            )

        minted = [row for row in list_agent_invocation_requests(base_dir=self.tools, role=GOLDSET_CURATION_ROLE)
                  if row.get("subject_ref") == subject]
        self.assertEqual(len(minted), MINTS, "a role without registered seats was counted at the mint")


class AHeldChangeKeepsItsOwnRefusalRowTests(_Store):
    """M13 — a refusal row is kept per change: two changes held in one cycle give two rows."""

    def _fill(self, subject: str) -> None:
        for index in range(_registered_seats(self.workspace)):
            admission = admit_request(OPERATOR_PRODUCER, CHANGE_INTELLIGENCE_ROLE, base_dir=self.tools,
                                      cycle_id=f"cyc-fill-{subject[-4:]}-{index}", subject_ref=subject)
            self.assertTrue(admission.admitted)
            create_agent_invocation_request(
                target_agent=CHANGE_INTELLIGENCE_AGENT, role=CHANGE_INTELLIGENCE_ROLE,
                suggested_prompt=f"Review seat {index} of the change {subject}",
                must_satisfy=[{"id": "impact-map", "description": "details.impact_map"}],
                allowed_scope=["**"], subject_ref=subject, cycle_id=f"cyc-fill-{subject[-4:]}-{index}",
                target_sha=HEAD, base_dir=self.tools, admission=admission,
            )

    def _refusal_rows(self) -> list[dict[str, Any]]:
        path = request_admission.admissions_path(self.tools)
        rows = [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]
        return [row for row in rows if row.get("row_type") == "decision" and row.get("admitted") is False
                and row.get("reason") == SEAT_REASON]

    def _ask(self, subject: str, cycle_id: str) -> request_admission.Admission:
        return admit_request(MERGE_PRODUCER, CHANGE_INTELLIGENCE_ROLE, base_dir=self.tools,
                             cycle_id=cycle_id, subject_ref=subject)

    def test_two_changes_held_in_one_cycle_each_keep_their_refusal_row(self) -> None:
        self._fill(SUBJECT)
        self._fill(OTHER_SUBJECT)
        self.assertEqual(self._refusal_rows(), [], "the fixture must not hold a change before the cycle under test")

        first = self._ask(SUBJECT, "cyc-held")
        second = self._ask(OTHER_SUBJECT, "cyc-held")

        self.assertEqual((first.admitted, second.admitted), (False, False))
        self.assertEqual((first.reason, second.reason), (SEAT_REASON, SEAT_REASON))
        rows = self._refusal_rows()
        self.assertEqual(sorted(row.get("subject_ref") for row in rows), sorted([SUBJECT, OTHER_SUBJECT]),
                         "the second held change of the cycle kept no refusal row of its own")
        self.assertEqual(len({row["cycle_key"] for row in rows}), 1, "both refusals belong to the one cycle")

    def test_a_repeat_of_a_held_change_in_the_same_cycle_adds_no_second_row(self) -> None:
        self._fill(SUBJECT)
        self._fill(OTHER_SUBJECT)
        self._ask(SUBJECT, "cyc-held")
        self._ask(OTHER_SUBJECT, "cyc-held")

        self._ask(SUBJECT, "cyc-held")
        self._ask(OTHER_SUBJECT, "cyc-held")

        self.assertEqual(sorted(row.get("subject_ref") for row in self._refusal_rows()),
                         sorted([SUBJECT, OTHER_SUBJECT]), "a repeat in the same cycle wrote a second row")

    def test_the_same_change_held_in_a_later_cycle_keeps_a_row_for_that_cycle(self) -> None:
        self._fill(SUBJECT)

        self._ask(SUBJECT, "cyc-held-1")
        self._ask(SUBJECT, "cyc-held-2")

        rows = self._refusal_rows()
        self.assertEqual(len(rows), 2, "a change held again by a later cycle must show it")
        self.assertEqual(len({row["cycle_key"] for row in rows}), 2)


class ClaimRankIsByConfidenceTests(_Store):
    """M04 — of two claims of equal severity, the higher confidence wins the slot."""

    def test_a_higher_confidence_claim_of_equal_severity_wins_the_slot(self) -> None:
        # One claim over the cap, all HIGH. Confidence RISES with claim_id and the claims arrive in
        # neither order, so ranking by claim_id (the tie-break), by arrival or by ascending
        # confidence would hold a better claim than the one that is held here.
        claims = {index: {"claim_id": f"c-{index:02d}", "severity": "HIGH", "confidence": round(0.30 + 0.05 * index, 2)}
                  for index in range(CAP + 1)}
        arrival = [claims[index] for index in (4, 0, 8, 2, 6, 1, 7, 3, 5)]

        result = judgment_funnel.admit_change_claims(SUBJECT, arrival, base_dir=self.tools)

        self.assertEqual([claim["claim_id"] for claim in result["held"]], ["c-00"],
                         "the lowest confidence claim is the one held")
        self.assertEqual([claim["claim_id"] for claim in result["admitted"]],
                         [f"c-{index:02d}" for index in range(CAP, 0, -1)],
                         "claims enter proof in falling confidence within one severity")
        self.assertEqual([row["claim_id"] for row in self.governance(HELD_KIND)], ["c-00"])


class ClaimsSubjectGuardTests(_Store):
    """M24 — a subject that names no change is refused by name before anything is written."""

    def _claims(self, count: int) -> list[dict[str, Any]]:
        return [{"claim_id": f"claim-{index:02d}", "severity": "HIGH", "confidence": round(0.9 - 0.01 * index, 2)}
                for index in range(count)]

    def test_a_subject_that_names_no_change_is_refused_and_writes_nothing(self) -> None:
        # Twelve claims: past the cap, so a call that went on would write admitted AND held rows.
        # One store for every case: each refusal must leave the ledger exactly as it found it.
        for name, value in (("empty", ""), ("blank", "   "), ("none", None), ("integer", 7)):
            with self.subTest(subject=name):
                before = len(self.governance_rows())

                with self.assertRaisesRegex(GovernanceError, "change_claims_subject_missing"):
                    judgment_funnel.admit_change_claims(value, self._claims(12), base_dir=self.tools)

                self.assertEqual(len(self.governance_rows()), before, "a refused call wrote rows")


if __name__ == "__main__":
    unittest.main()
