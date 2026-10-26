"""WP-D4 conformance gaps — the caps must bind a CHANGE, not one call or one honest caller.

The independent audit of the D4 branch (build/D4/conformance.md) found the
three caps present and the headline tests discriminating, and named where each
cap stops short of the change it is meant to bound. These tests pin those
gaps before they are fixed. They are a second module on purpose: the first one
(test_change_review_budget.py) is the red-first record of the design and is not
edited.

Red at the audited HEAD, every one on an assertion (each reaches existing API
only; nothing fails at import or collection):

  * R7  SEATS BOUND TO THE ADMISSION. A mint may take a change's seat only
        under an admission the door decided FOR THAT CHANGE. At HEAD
        ``check_admission_binding`` checks the role alone, so a caller that
        decided without a subject, or for another one, then mints naming the
        change takes seats the door never counted: probe P2 found 7 seats on
        one change and probe P2b 6 on a change whose admissions were all decided
        for another (cap 4). A refused change must also not stop the producer's
        walk for the changes after it (``pr_tracking`` breaks on any refusal).
  * R10 CLAIMS CAP PER CHANGE. ``admit_change_claims`` applies the cap to the
        claims of one call (probe P1: two calls with disjoint claims admit
        8 + 8 = 16). What a change already admitted is the store's to say, the
        way the door derives a change's seats from the request ledger: a later
        call takes only the slots earlier calls left, whatever process makes it.

Pins of behaviour that already holds at HEAD but that no test fails without
(green now; each was proven to fail under a mutation of the code it guards, see
the commit body). They are here because the audit's mutation table showed them
surviving, and each one protects a gap's fix from regressing the contract:

  * R6  the production producer names its change at the door (a spy on
        ``admit_request``; both feeds). The seat cap is unreachable through this
        producer today (one request per subject), so only a spy can see it.
  * R7  a mint naming a change for a role with no registered seats is refused
        by name, never silently uncounted.
  * R9  the guards that keep "one held row per held claim" true for odd input:
        a repeated claim_id, a confidence outside [0, 1], a malformed id or
        severity are refused by name, BEFORE anything is written, and a refused
        call leaves no trace that a later call could count.

What is deliberately not pinned: the shape of the new state (the name of a
ledger row, a field on ``Admission``, the wording of a refusal beyond the word
"subject"); only what a reader of the store or of a return value can observe.
"""
from __future__ import annotations

import contextlib
import inspect
import json
import math
import os
import subprocess
import sys
import tempfile
import textwrap
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any
from unittest import mock

from aria_kernel import genesis_policy, judgment_funnel, request_admission
from aria_kernel.agent_invocations import (
    create_agent_invocation_request,
    list_agent_invocation_requests,
)
from aria_kernel.merge_record import MERGED_BY_MERGE_LANE, record_merge
from aria_kernel.pr_tracking import (
    CHANGE_INTELLIGENCE_AGENT,
    CHANGE_INTELLIGENCE_ROLE,
    ChangeSubject,
    change_intelligence_subject_ref,
    dispatch_change_intelligence,
)
from aria_kernel.request_admission import admit_request
from aria_kernel.tool_registry import GovernanceError, ensure_tools_dir

_KERNEL = Path(__file__).resolve().parents[1]
SUBJECT = f"change:{'a' * 40}..{'b' * 40}"
OTHER_SUBJECT = f"change:{'a' * 40}..{'c' * 40}"
HEAD = "b" * 40
OPERATOR_PRODUCER = "change_review.operator_subject"
MERGE_PRODUCER = "change_review.merge_feed"
HELD_KIND = "change_review_budget_held"
CLAIMS_REASON = "claims_per_change_cap"
SEAT_REASON = "change_review_seat_cap"
CAP = 8


def _claim(claim_id: str, severity: str = "HIGH", confidence: float = 0.5) -> dict[str, Any]:
    return {"claim_id": claim_id, "severity": severity, "confidence": confidence}


def _claims(prefix: str, count: int, severity: str = "HIGH") -> list[dict[str, Any]]:
    """``count`` claims of one severity, confidences strictly falling, ids unique to ``prefix``."""
    return [_claim(f"{prefix}-{index:02d}", severity, round(0.9 - 0.01 * index, 2)) for index in range(count)]


def _ids(rows: list[dict[str, Any]]) -> list[str]:
    return [row["claim_id"] for row in rows]


class _Store(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory(prefix="aria-change-gaps-")
        self.addCleanup(self._tmp.cleanup)
        self.workspace = Path(self._tmp.name)
        self.tools = ensure_tools_dir(self.workspace / "aria-tools")

    def governance(self, kind: str) -> list[dict[str, Any]]:
        path = self.tools / "governance.jsonl"
        if not path.exists():
            return []
        rows = [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]
        return [row["details"] for row in rows if row.get("kind") == kind]


class ClaimsCapIsPerChangeTests(_Store):
    """R10 — the cap bounds the claims a CHANGE puts into proof, however many calls bring them."""

    def _admit(self, claims: list[dict[str, Any]], *, subject: str = SUBJECT) -> dict[str, list[dict[str, Any]]]:
        return judgment_funnel.admit_change_claims(subject, claims, base_dir=self.tools)

    def test_two_calls_for_one_change_admit_no_more_than_the_cap_between_them(self) -> None:
        # The audit's probe P1: two discovery seats each return 20 claims.
        first = self._admit(_claims("seat-a", 20))
        second = self._admit(_claims("seat-b", 20))

        admitted = len(first["admitted"]) + len(second["admitted"])
        self.assertEqual(admitted, CAP, f"two calls admitted {admitted} claims into proof for ONE change; the cap is per change")
        self.assertEqual(len(second["held"]), 20, "the change was at its cap: every claim of the later call is held")
        rows = self.governance(HELD_KIND)
        self.assertEqual(len(rows), 12 + 20, "exactly one change_review_budget_held row per held claim, across both calls")
        self.assertEqual(len({row["claim_id"] for row in rows}), 32, "no claim is held twice")
        self.assertEqual({row["reason"] for row in rows}, {CLAIMS_REASON})
        self.assertEqual({row["cap"] for row in rows}, {CAP}, "the row names the cap, not the slots that were left")

    def test_a_later_call_takes_only_the_slots_the_earlier_call_left(self) -> None:
        early = self._admit(_claims("early", 5))
        late = self._admit([
            _claim("late-info", "INFORMATIONAL", 0.99), _claim("late-low", "LOW", 0.99),
            _claim("late-medium", "MEDIUM", 0.10), _claim("late-critical", "CRITICAL", 0.10),
            _claim("late-high", "HIGH", 0.10),
        ])

        self.assertEqual((len(early["admitted"]), len(early["held"])), (5, 0))
        self.assertEqual(sorted(_ids(late["admitted"])), ["late-critical", "late-high", "late-medium"],
                         "3 slots were left: the three highest ranked claims of the later call take them")
        self.assertEqual(sorted(_ids(late["held"])), ["late-info", "late-low"])
        rows = self.governance(HELD_KIND)
        self.assertEqual(sorted(row["claim_id"] for row in rows), ["late-info", "late-low"], "one row per held claim")
        self.assertEqual({row["cap"] for row in rows}, {CAP})

    def test_each_change_has_its_own_claims_cap(self) -> None:
        full = self._admit(_claims("a-seat1", CAP))
        none_left = self._admit(_claims("a-seat2", 3))
        other = self._admit(_claims("b-seat1", CAP), subject=OTHER_SUBJECT)

        self.assertEqual(len(full["admitted"]), CAP)
        self.assertEqual((len(none_left["admitted"]), len(none_left["held"])), (0, 3),
                         "the first change is at its cap: a later claim of it is held")
        self.assertEqual((len(other["admitted"]), len(other["held"])), (CAP, 0),
                         "a second change must not inherit the first one's admitted claims")
        self.assertEqual({row["subject_ref"] for row in self.governance(HELD_KIND)}, {SUBJECT})

    def test_a_repeat_of_the_claims_of_an_earlier_call_changes_nothing(self) -> None:
        early, late = _claims("early", CAP), _claims("late", 4)
        self._admit(early)

        held = self._admit(late)
        self.assertEqual((len(held["admitted"]), len(held["held"])), (0, 4), "the change is at its cap")
        repeat_early = self._admit(early)
        repeat_late = self._admit(late)

        self.assertEqual(sorted(_ids(repeat_early["admitted"])), sorted(_ids(early)),
                         "claims already in proof stay admitted, and do not spend a second slot")
        self.assertEqual(repeat_early["held"], [])
        self.assertEqual((repeat_late["admitted"], sorted(_ids(repeat_late["held"]))), ([], sorted(_ids(late))))
        self.assertEqual(len(self.governance(HELD_KIND)), 4, "a repeat holds nothing a second time")

    def test_the_count_of_admitted_claims_is_read_from_the_store_not_held_by_the_process(self) -> None:
        self._admit(_claims("early", CAP))
        code = textwrap.dedent("""
            import json, sys
            from aria_kernel import judgment_funnel
            result = judgment_funnel.admit_change_claims(sys.argv[1], json.loads(sys.argv[3]), base_dir=sys.argv[2])
            print(json.dumps({key: [claim["claim_id"] for claim in result[key]] for key in ("admitted", "held")}))
        """)

        child = subprocess.run(
            [sys.executable, "-c", code, SUBJECT, str(self.tools), json.dumps(_claims("late", 4))],
            cwd=self.workspace, capture_output=True, text=True, check=False, timeout=120,
            env={**os.environ, "PYTHONPATH": str(_KERNEL), "PYTHONDONTWRITEBYTECODE": "1"},
        )

        self.assertEqual(child.returncode, 0, child.stderr)
        later = json.loads(child.stdout)
        self.assertEqual(later["admitted"], [], "a second process admitted claims for a change the first one filled")
        self.assertEqual(sorted(later["held"]), sorted(_ids(_claims("late", 4))))


class ClaimGuardTests(_Store):
    """R9 — odd input is refused by name before anything is written (pins; green at HEAD)."""

    def _admit(self, claims: list[dict[str, Any]]) -> dict[str, list[dict[str, Any]]]:
        return judgment_funnel.admit_change_claims(SUBJECT, claims, base_dir=self.tools)

    def _refused(self, bad: list[dict[str, Any]], *, tail: list[dict[str, Any]] | None = None) -> None:
        # Twelve valid claims would put four on hold: a guard that ran after the
        # holds were written would leave rows, or slots spent, behind.
        claims = _claims("ok", 12) + bad + (tail or [])
        with self.assertRaisesRegex(GovernanceError, "change_claim_malformed"):
            self._admit(claims)
        self.assertEqual(self.governance(HELD_KIND), [], "a refused call wrote a hold row")
        again = self._admit(_claims("later", CAP))
        self.assertEqual((len(again["admitted"]), len(again["held"])), (CAP, 0),
                         "a refused call left something behind that a later call counts against the change")

    def test_a_claim_id_repeated_within_one_call_is_refused(self) -> None:
        cases = {
            "identical twin of a held claim": [_claim("ok-11", "HIGH", 0.79)],
            "same id, other severity": [_claim("ok-00", "LOW", 0.1)],
            "same id twice, both new": [_claim("dup", "HIGH", 0.5), _claim("dup", "HIGH", 0.5)],
        }
        for name, bad in cases.items():
            with self.subTest(case=name):
                self.setUp()
                self._refused(bad)

    def test_a_confidence_outside_zero_to_one_is_refused(self) -> None:
        for name, value in (("below", -0.01), ("above", 1.01), ("nan", math.nan), ("infinite", math.inf),
                            ("string", "0.9"), ("bool", True), ("none", None)):
            with self.subTest(confidence=name):
                self.setUp()
                self._refused([{"claim_id": "odd", "severity": "HIGH", "confidence": value}])
        with self.subTest(confidence="missing"):
            self.setUp()
            self._refused([{"claim_id": "odd", "severity": "HIGH"}])

    def test_a_malformed_claim_id_is_refused(self) -> None:
        for name, value in (("empty", ""), ("integer", 7), ("none", None)):
            with self.subTest(claim_id=name):
                self.setUp()
                self._refused([{"claim_id": value, "severity": "HIGH", "confidence": 0.5}])
        with self.subTest(claim_id="missing"):
            self.setUp()
            self._refused([{"severity": "HIGH", "confidence": 0.5}])

    def test_a_severity_outside_the_vocabulary_is_refused(self) -> None:
        for name, value in (("unknown", "SEVERE"), ("empty", ""), ("integer", 3), ("none", None)):
            with self.subTest(severity=name):
                self.setUp()
                self._refused([{"claim_id": "odd", "severity": value, "confidence": 0.5}])
        with self.subTest(severity="missing"):
            self.setUp()
            self._refused([{"claim_id": "odd", "confidence": 0.5}])

    def test_the_closed_ends_of_the_ranges_are_accepted(self) -> None:
        claims = [_claim("c-critical", "CRITICAL", 1.0), _claim("c-high", "HIGH", 0.0),
                  _claim("c-medium", "MEDIUM", 0.5), _claim("c-low", "LOW", 0.5),
                  _claim("c-info", "INFORMATIONAL", 0.5)]

        result = self._admit(claims)

        self.assertEqual(_ids(result["admitted"]), ["c-critical", "c-high", "c-medium", "c-low", "c-info"],
                         "every severity of the vocabulary and both ends of [0, 1] are valid, ranked severity first")
        self.assertEqual(result["held"], [])


class SeatsAreBoundToTheirAdmissionTests(_Store):
    """R7 — a seat is minted only under the admission the door decided for that change."""

    def _decide(self, label: str, subject: str | None, *, base_dir: Path | None = None) -> request_admission.Admission:
        extra = {} if subject is None else {"subject_ref": subject}
        return admit_request(OPERATOR_PRODUCER, CHANGE_INTELLIGENCE_ROLE, base_dir=base_dir or self.tools,
                             cycle_id=f"cyc-{label}", **extra)

    def _mint(self, admission: request_admission.Admission, label: str, subject: str, *,
              base_dir: Path | None = None) -> dict[str, Any]:
        return create_agent_invocation_request(
            target_agent=CHANGE_INTELLIGENCE_AGENT, role=CHANGE_INTELLIGENCE_ROLE,
            suggested_prompt=f"Review seat {label} of the change {subject}",
            must_satisfy=[{"id": "impact-map", "description": "details.impact_map"}],
            allowed_scope=["**"], subject_ref=subject, cycle_id=f"cyc-{label}", target_sha=HEAD,
            base_dir=base_dir or self.tools, admission=admission,
        )

    def _seats(self, subject: str) -> int:
        return sum(1 for row in list_agent_invocation_requests(base_dir=self.tools, role=CHANGE_INTELLIGENCE_ROLE)
                   if row.get("subject_ref") == subject)

    def _cap(self) -> int:
        seats = genesis_policy.change_review_policy(self.workspace)["seats"]
        return seats["service_seats_per_change"] + seats["lens_seats_per_change"]

    def test_a_mint_naming_a_change_is_refused_under_an_admission_decided_without_one(self) -> None:
        honest = self._decide("honest", SUBJECT)
        self.assertTrue(honest.admitted)
        self._mint(honest, "honest", SUBJECT)
        unbound = self._decide("unbound", None)
        self.assertTrue(unbound.admitted, "critical path stays admitted for a call that names no change")

        with self.assertRaises(GovernanceError) as refused:
            self._mint(unbound, "unbound", SUBJECT)

        self.assertRegex(str(refused.exception), "(?i)subject", "the refusal names what the admission was not decided for")
        self.assertEqual(self._seats(SUBJECT), 1, "a refused mint wrote a seat")

    def test_a_mint_for_one_change_is_refused_under_an_admission_decided_for_another(self) -> None:
        honest = self._decide("honest", SUBJECT)
        self.assertTrue(honest.admitted)
        self._mint(honest, "honest", SUBJECT)
        for_another = self._decide("another", OTHER_SUBJECT)
        self.assertTrue(for_another.admitted)

        with self.assertRaises(GovernanceError) as refused:
            self._mint(for_another, "another", SUBJECT)

        self.assertRegex(str(refused.exception), "(?i)subject")
        self.assertEqual(self._seats(SUBJECT), 1, "a refused mint wrote a seat")
        self.assertEqual(self._seats(OTHER_SUBJECT), 0)

    def test_the_seats_of_a_change_never_pass_the_cap_under_admissions_decided_without_it(self) -> None:
        # The audit's probe P2: seven mints name the change, none was decided for it.
        cap = self._cap()
        for index in range(cap + 3):
            admission = self._decide(f"anonymous-{index}", None)
            with contextlib.suppress(GovernanceError):
                self._mint(admission, f"anonymous-{index}", SUBJECT)

        self.assertLessEqual(self._seats(SUBJECT), cap,
                             f"{self._seats(SUBJECT)} seats on one change when the policy registers {cap}")

    def test_the_seats_of_a_change_never_pass_the_cap_under_admissions_decided_for_another_change(self) -> None:
        # The audit's probe P2b: six mints name the change, every admission was decided for another.
        cap = self._cap()
        for index in range(cap + 2):
            admission = self._decide(f"another-{index}", OTHER_SUBJECT)
            self.assertTrue(admission.admitted, "the other change holds no seat, so the door admits it")
            with contextlib.suppress(GovernanceError):
                self._mint(admission, f"another-{index}", SUBJECT)

        self.assertLessEqual(self._seats(SUBJECT), cap,
                             f"{self._seats(SUBJECT)} seats on one change when the policy registers {cap}")

    def test_a_change_named_for_a_role_without_registered_seats_is_refused_by_name(self) -> None:
        # Pin (green at HEAD): a role joins CHANGE_SEAT_KEYS when its producer names its change.
        for role in ("verification", "evidence_judgment"):
            with self.subTest(role=role):
                self.assertNotIn(role, request_admission.CHANGE_SEAT_KEYS)
                with self.assertRaisesRegex(GovernanceError, "request_admission_change_seat_role_unclassified"):
                    admit_request("operator_cli.request", role, base_dir=self.tools, cycle_id=f"cyc-{role}",
                                  subject_ref=SUBJECT)
                self.assertFalse(request_admission.admissions_path(self.tools).exists(),
                                 "a refused ask must not be recorded as a decision")


def _caught_up_ledgers() -> tuple[list[dict[str, Any]], list[dict[str, Any]], list[dict[str, Any]]]:
    """A drained queue (``request_drain_capacity._request_ledgers``): the door admits discretionary work."""
    now = datetime.now(timezone.utc)

    def iso(moment: datetime) -> str:
        return moment.replace(microsecond=0).isoformat()

    requests = [{"request_id": f"p-{index}", "role": "evidence_judgment", "state": "pending",
                 "created_at": iso(now - timedelta(hours=1))} for index in range(5)]
    results = []
    for index in range(40):
        requests.append({"request_id": f"d-{index}", "role": "evidence_judgment", "state": "pending",
                         "created_at": iso(now - timedelta(hours=3))})
        results.append({"request_id": f"d-{index}", "status": "rejected", "submitted_at": iso(now - timedelta(hours=2))})
    return requests, results, []


def _record_merge(tools: Path, number: int, head_sha: str) -> str:
    record_merge(
        pr={"number": number, "head_sha": head_sha, "base_branch": "main", "changed_files": ["aria-kernel/aria_kernel/cycle.py"]},
        merged_by=MERGED_BY_MERGE_LANE, base_dir=tools, head_lineage="delivered",
    )
    return change_intelligence_subject_ref(pr_number=number, head_sha=head_sha)


class ProducerNamesItsChangeAtTheDoorTests(_Store):
    """R6 — the production producer of change seats says which change it asks for (pins; green at HEAD)."""

    @staticmethod
    def _bound(door: mock.MagicMock) -> dict[str, Any]:
        call = door.call_args
        return dict(inspect.signature(request_admission.admit_request).bind(*call.args, **call.kwargs).arguments)

    def test_the_operator_named_change_is_named_at_the_door(self) -> None:
        subject = ChangeSubject(base="a" * 40, head="b" * 40, changed_files=("apps/orders/src/order.ts",))

        with mock.patch("aria_kernel.request_admission.admit_request", wraps=request_admission.admit_request) as door:
            result = dispatch_change_intelligence(cycle_id="cyc-operator", base_dir=self.tools, subject=subject)

        self.assertEqual([row["subject_ref"] for row in result["minted"]], [subject.ref])
        door.assert_called_once()
        asked = self._bound(door)
        self.assertEqual((asked["producer"], asked["role"]), (OPERATOR_PRODUCER, CHANGE_INTELLIGENCE_ROLE))
        self.assertEqual(asked.get("subject_ref"), subject.ref,
                         "the producer asked the door for a seat without naming the change it is for")

    def test_a_merge_is_named_at_the_door(self) -> None:
        head_sha = "b" * 40
        merge_ref = _record_merge(self.tools, 1822, head_sha)

        with mock.patch("aria_kernel.request_drain_capacity._request_ledgers", return_value=_caught_up_ledgers()), \
                mock.patch("aria_kernel.request_admission.admit_request", wraps=request_admission.admit_request) as door:
            result = dispatch_change_intelligence(cycle_id="cyc-merge", base_dir=self.tools)

        self.assertEqual([row["subject_ref"] for row in result["minted"]], [merge_ref])
        door.assert_called_once()
        asked = self._bound(door)
        self.assertEqual((asked["producer"], asked["role"]), (MERGE_PRODUCER, CHANGE_INTELLIGENCE_ROLE))
        self.assertEqual(asked.get("subject_ref"), merge_ref,
                         "the producer asked the door for a seat without naming the change it is for")


class ARefusedChangeDoesNotStopTheWalkTests(_Store):
    """R7(d) — the door's cap throttles no other work: a change held at its seats does not end the merge walk."""

    def _refusal_for(self, subject: str) -> request_admission.Admission:
        """The door's own refusal of ``subject`` at its seat cap, taken from a store where it holds its seats."""
        scratch = ensure_tools_dir(self.workspace / "scratch-tools")
        for index in range(CAP):
            admission = admit_request(OPERATOR_PRODUCER, CHANGE_INTELLIGENCE_ROLE, base_dir=scratch,
                                      cycle_id=f"cyc-seed-{index}", subject_ref=subject)
            if not admission.admitted:
                break
            create_agent_invocation_request(
                target_agent=CHANGE_INTELLIGENCE_AGENT, role=CHANGE_INTELLIGENCE_ROLE,
                suggested_prompt=f"Review seat {index} of {subject}",
                must_satisfy=[{"id": "impact-map", "description": "details.impact_map"}],
                allowed_scope=["**"], subject_ref=subject, cycle_id=f"cyc-seed-{index}", target_sha=HEAD,
                base_dir=scratch, admission=admission,
            )
        refusal = admit_request(MERGE_PRODUCER, CHANGE_INTELLIGENCE_ROLE, base_dir=scratch,
                                cycle_id="cyc-refused", subject_ref=subject)
        self.assertFalse(refusal.admitted)
        self.assertEqual(refusal.reason, SEAT_REASON, "the fixture must be the door's own seat-cap refusal")
        return refusal

    def test_the_changes_after_a_change_held_at_its_seats_are_still_asked_about(self) -> None:
        refs = {_record_merge(self.tools, 101, "a" * 40), _record_merge(self.tools, 102, "b" * 40)}
        real_door = request_admission.admit_request
        asked: list[str | None] = []

        def door(producer: str, role: str, **kwargs: Any) -> request_admission.Admission:
            asked.append(kwargs.get("subject_ref"))
            if len(asked) == 1:
                self.assertIn(asked[0], refs, "the producer must name the change it asks for")
                return self._refusal_for(asked[0])
            return real_door(producer, role, **kwargs)

        with mock.patch("aria_kernel.request_drain_capacity._request_ledgers", return_value=_caught_up_ledgers()), \
                mock.patch("aria_kernel.request_admission.admit_request", side_effect=door):
            result = dispatch_change_intelligence(cycle_id="cyc-walk", base_dir=self.tools)

        self.assertEqual(len(asked), 2, "the walk stopped at the first change the door held at its seats")
        refused = asked[0]
        self.assertEqual({row["subject_ref"] for row in result["minted"]}, refs - {refused},
                         "the other change was never asked about because of a refusal that was not its own")
        self.assertEqual([(row["subject_ref"], row["reason"]) for row in result["skipped"]],
                         [(refused, f"request_admission_throttled:{SEAT_REASON}")],
                         "the held change is skipped by name and stays unasked for the next cycle")


if __name__ == "__main__":
    unittest.main()
