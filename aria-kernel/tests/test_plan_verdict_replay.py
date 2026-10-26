"""PV R9 — the 18 plans that CONVERGED on aria/state @ 8e39b2eeb, replayed through the plan-verdict law.

Finding ARIA-HIGH-779's closing test. The plan author used to close the
reviewer's objections itself: ``revision_recorded`` unioned the author's
``addresses_review_risk_ids`` into one plan-wide set, the material gate dropped
every current-round risk whose id was in it, and reviewers restart at ``CR-001``
every round, so a claim on round 1's ``CR-001`` also hid round 2's NEW
``CR-001``. The measurement (SEPT-HARVEST section 0, ``origin/aria/state``
``tools/plans/events.jsonl``): in 18 of 18 CONVERGED verdicts a material risk
was hidden this way, and in 18 of 18 it was a new objection.

This module replays those recorded histories, not hand-built ones:

* the fixture ``fixtures/plan-verdict-replay-aria-state-8e39b2eeb.json`` is the
  18 plans' events, cut to the fields the replay reads; its header names the
  state sha, the derivation and the script that regenerates it, and the test
  below pins the two together (``tests/_helpers/plan_verdict_replay_fixture.py``);
* the OLD law is reproduced by :func:`old_law_judgment`, a small reference
  written from the code PV replaced, and it is checked against what the old
  kernel itself recorded in each evaluation's ``risks_rollup_summary``, so the
  reference is the law that ran, not a reading of it;
* the NEW law is the kernel's own: ``plan_convergence``'s fold
  (``_apply_event``) and its cross-review gate (``_evaluate_cross_review_state``)
  over the same events.

The replay judges the cross-review risk law only. ``evaluate_plan`` adds the
spine, the plan-contract and the independence gates, which can refuse a
convergence this gate allows and never allow one it refuses, so a round this
gate does not converge does not converge there.

What turns it red: restoring the old union (the author's claim feeding
``resolved_review_risk_ids``), or reviewer risk ids that are not round-scoped
(no earlier-round risk is then visible as an open prior risk, and a later
round's id collides with a claimed one).
"""
from __future__ import annotations

import copy
import hashlib
import json
import unittest
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from aria_kernel import plan_convergence as pc
from tests._helpers.plan_verdict_replay_fixture import (
    FIXTURE_NAME, FIXTURES_DIR, GENERATOR, HEADER_NAME, STATE_SHA, scan_for_sensitive_data,
)

_REPO_ROOT = Path(__file__).resolve().parents[2]

# The old law's severities: a risk of one of these blocks convergence.
OLD_LAW_MATERIAL_SEVERITIES = frozenset({"blocking", "material", "critical", "high"})

# Per plan (ledger order), the number of round-2 material risks the old law
# hid. Measured independently of this module (impl/replay-aria-state-8e39b2eeb.txt,
# "masked_material_old_law"); the reference below must reproduce it.
MASKED_UNDER_THE_OLD_LAW = (2, 3, 2, 5, 4, 3, 4, 3, 1, 3, 4, 5, 3, 2, 1, 3, 7, 3)


@dataclass(frozen=True)
class OldLawJudgment:
    """What the pre-PV kernel computed for a round: the claimed ids, the risks it counted, the ones it hid."""

    claimed: tuple[str, ...]
    risks: tuple[dict[str, Any], ...]
    active: tuple[dict[str, Any], ...]
    material: tuple[dict[str, Any], ...]
    masked_material: tuple[dict[str, Any], ...]


def old_law_judgment(events: list[dict[str, Any]], round_number: int) -> OldLawJudgment:
    """The material gate ``plan_convergence`` ran before PV, for one round, over the plan's recorded events.

    Written from the code PV replaced (origin/main 0cfc11838 and the merge
    base 59d0c6444 hold the same lines):

    * ``revision_recorded`` unioned every ``addresses_review_risk_ids`` entry
      into one plan-wide ``resolved_review_risk_ids`` set and advanced the
      current round;
    * ``cross_review_recorded`` surfaced a reviewer's risks under the current
      round with the ids the reviewer wrote, a repeated id within the round
      counted once (first row wins);
    * ``coverage_computed`` surfaced its synthetic risks under its round;
    * ``_evaluate_cross_review_state`` dropped every risk of the round whose id
      was in the resolved set, then counted the material ones.
    """
    current_round = None
    claimed: set[str] = set()
    by_round: dict[int, list[dict[str, Any]]] = {}
    for event in events:
        kind, payload = event["event_type"], event["payload"]
        if kind in ("cross_review_tasks_requested", "critic_tasks_requested"):
            current_round = payload["round_number"]
        elif kind == "revision_recorded":
            current_round = payload["round"] + 1
            claimed.update(str(item) for item in payload.get("addresses_review_risk_ids", []) if isinstance(item, str) and item)
        elif kind == "cross_review_recorded":
            surfaced = by_round.setdefault(current_round, [])
            seen = {risk.get("risk_id") for risk in surfaced if risk.get("risk_id")}
            for risk in payload.get("risks", []):
                if risk.get("risk_id") in seen:
                    continue
                if risk.get("risk_id"):
                    seen.add(risk["risk_id"])
                surfaced.append(risk)
        elif kind == "coverage_computed":
            by_round.setdefault(payload["round_number"], []).extend(
                [*payload.get("synthetic_risks", []), *(payload.get("import_resolution") or {}).get("synthetic_risks", [])]
            )
    risks = by_round.get(round_number, [])
    is_material = lambda risk: str(risk.get("severity")).lower() in OLD_LAW_MATERIAL_SEVERITIES  # noqa: E731
    return OldLawJudgment(
        claimed=tuple(sorted(claimed)),
        risks=tuple(risks),
        active=tuple(risk for risk in risks if str(risk.get("risk_id")) not in claimed),
        material=tuple(risk for risk in risks if str(risk.get("risk_id")) not in claimed and is_material(risk)),
        masked_material=tuple(risk for risk in risks if str(risk.get("risk_id")) in claimed and is_material(risk)),
    )


def _summaries_before(events: list[dict[str, Any]], round_number: int) -> set[str]:
    """Every reviewer risk summary recorded in a round before ``round_number``."""
    current_round, found = None, set()
    for event in events:
        if event["event_type"] in ("cross_review_tasks_requested", "critic_tasks_requested"):
            current_round = event["payload"]["round_number"]
        elif event["event_type"] == "revision_recorded":
            current_round = event["payload"]["round"] + 1
        elif event["event_type"] == "cross_review_recorded" and current_round < round_number:
            found.update(risk["summary"] for risk in event["payload"]["risks"])
    return found


def _first_round_material_ids(events: list[dict[str, Any]]) -> list[str]:
    """The reviewer ids of the first round's material risks, from the raw events (not from the kernel's fold)."""
    ids: list[str] = []
    for event in events:
        if event["event_type"] == "revision_recorded":
            break
        if event["event_type"] == "cross_review_recorded":
            ids.extend(
                risk["risk_id"] for risk in event["payload"]["risks"]
                if str(risk["severity"]).lower() in OLD_LAW_MATERIAL_SEVERITIES and risk["risk_id"] not in ids
            )
    return sorted(ids)


def _pv_fold(plan: dict[str, Any], events: list[dict[str, Any]] | None = None) -> dict[str, Any]:
    """The plan's state as the kernel folds it: by default from the events before the evaluation."""
    state = pc._initial_state(plan["plan_id"])
    for event in copy.deepcopy(plan["events"][:-1] if events is None else events):
        pc._apply_event(state, event)
    pc._derive_state(state)
    return state


def _recorded_cap(evaluated: dict[str, Any]) -> int:
    return next(row["max_rounds"] for row in evaluated["gate_decisions"] if row["gate"] == "max_rounds")


class _ReplayCase(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.fixture_bytes = (FIXTURES_DIR / FIXTURE_NAME).read_bytes()
        cls.plans = json.loads(cls.fixture_bytes)["plans"]
        cls.header = json.loads((FIXTURES_DIR / HEADER_NAME).read_text(encoding="utf-8"))

    def cases(self) -> list[tuple[dict[str, Any], dict[str, Any]]]:
        """(plan, its recorded CONVERGED evaluation) for each replayed plan."""
        return [(plan, plan["events"][-1]["payload"]) for plan in self.plans]


class ReplayFixtureProvenance(_ReplayCase):
    """The fixture is the one its header names, and it holds no personal, secret or tenant data."""

    def test_the_header_pins_the_fixture_bytes_and_names_the_state_it_was_derived_from(self) -> None:
        header = self.header
        self.assertEqual(header["fixture"], FIXTURE_NAME)
        self.assertEqual(header["fixture_sha256"], hashlib.sha256(self.fixture_bytes).hexdigest())
        self.assertEqual(header["fixture_bytes"], len(self.fixture_bytes))
        self.assertEqual((header["source"]["branch"], header["source"]["sha"]), ("aria/state", STATE_SHA))
        self.assertTrue(header["source"]["sha"].startswith("8e39b2eeb"))
        self.assertEqual(header["source"]["path"], "tools/plans/events.jsonl")
        self.assertEqual(header["generator"], GENERATOR)
        self.assertTrue((_REPO_ROOT / GENERATOR).is_file(), "the script the header names must exist")
        self.assertEqual(header["plans"], len(self.plans))
        self.assertEqual(header["events"], sum(len(plan["events"]) for plan in self.plans))
        self.assertEqual(header["plans"], header["source"]["ledger_converged_evaluations"])

    def test_the_committed_bytes_hold_no_personal_secret_or_tenant_data(self) -> None:
        self.assertEqual(scan_for_sensitive_data(self.fixture_bytes.decode("utf-8")), [])
        self.assertEqual(scan_for_sensitive_data((FIXTURES_DIR / HEADER_NAME).read_text(encoding="utf-8")), [])

    def test_every_plan_ends_at_its_converged_two_round_evaluation(self) -> None:
        self.assertEqual(len(self.plans), 18)
        for plan, evaluated in self.cases():
            with self.subTest(plan=plan["plan_id"]):
                events = plan["events"]
                self.assertEqual(events[0]["event_type"], "plan_started")
                self.assertEqual((events[-1]["event_type"], evaluated["terminal_state"], evaluated["round_number"]),
                                 ("plan_evaluated", "CONVERGED", 2))
                lines = [event["ledger_line"] for event in events]
                self.assertEqual(lines, sorted(set(lines)), "ledger lines are the source order, once each")
                state = _pv_fold(plan)
                self.assertEqual(state["state"], "CROSS_REVIEWED", "the old kernel judged it with the cross-review gate")
                self.assertEqual(state["current_round"], evaluated["round_number"])


class OldLawHidMaterialRisks(_ReplayCase):
    """Under the law PV replaced, every one of the 18 CONVERGED plans hid a new material risk."""

    def test_the_reference_reproduces_what_the_old_kernel_recorded(self) -> None:
        for plan, evaluated in self.cases():
            with self.subTest(plan=plan["plan_id"]):
                judged = old_law_judgment(plan["events"][:-1], evaluated["round_number"])
                recorded = evaluated["risks_rollup_summary"]
                self.assertEqual(recorded["active_cross_review_risks"], len(judged.active))
                self.assertEqual(recorded["material_cross_review_risks"], len(judged.material))
                self.assertEqual(recorded["resolved_review_risks"], len(judged.claimed))
                self.assertEqual(judged.material, ())
                self.assertIn({"gate": "material_cross_review_zero", "passed": True}, evaluated["gate_decisions"])

    def test_18_of_18_converged_with_a_material_risk_the_authors_claim_hid(self) -> None:
        masked_plans = 0
        for (plan, evaluated), expected in zip(self.cases(), MASKED_UNDER_THE_OLD_LAW, strict=True):
            with self.subTest(plan=plan["plan_id"]):
                judged = old_law_judgment(plan["events"][:-1], evaluated["round_number"])
                self.assertEqual(len(judged.masked_material), expected)
                masked_plans += bool(judged.masked_material)
        self.assertEqual(masked_plans, 18)

    def test_the_hidden_risk_was_a_new_objection_not_the_one_the_author_addressed(self) -> None:
        for plan, evaluated in self.cases():
            with self.subTest(plan=plan["plan_id"]):
                earlier = _summaries_before(plan["events"][:-1], evaluated["round_number"])
                judged = old_law_judgment(plan["events"][:-1], evaluated["round_number"])
                for risk in judged.masked_material:
                    self.assertNotIn(risk["summary"], earlier, f"{risk['risk_id']} repeats an earlier objection")


class PlanVerdictLawOnTheSameHistories(_ReplayCase):
    """Under PV's law none of the 18 converges, and it is the risk law that stops each one."""

    def test_0_of_18_converge_at_the_cap_the_old_run_recorded_and_at_the_kernel_default(self) -> None:
        converged = 0
        for plan, evaluated in self.cases():
            with self.subTest(plan=plan["plan_id"]):
                state = _pv_fold(plan)
                for cap, expected in (
                    (_recorded_cap(evaluated), "HUMAN_REQUIRED"), (pc.MAX_CROSS_REVIEW_ROUNDS, "NEXT_ROUND_REQUIRED"),
                ):
                    decision = pc._evaluate_cross_review_state(state, evaluated["round_number"], max_rounds=cap)
                    self.assertEqual(decision["terminal_state"], expected, f"max_rounds={cap}")
                    self.assertIn("material_cross_review_risks_present", decision["reason_codes"])
                    self.assertIn(pc.PRIOR_REVIEW_RISKS_OPEN_REASON, decision["reason_codes"])
                    converged += decision["terminal_state"] == "CONVERGED"
        self.assertEqual(converged, 0)

    def test_the_exit_metric_masked_material_risks_at_converged_falls_from_18_to_0(self) -> None:
        masked_old = masked_new = 0
        for plan, evaluated in self.cases():
            with self.subTest(plan=plan["plan_id"]):
                round_number = evaluated["round_number"]
                masked_old += bool(old_law_judgment(plan["events"][:-1], round_number).masked_material)
                decision = pc._evaluate_cross_review_state(
                    _pv_fold(plan), round_number, max_rounds=pc.MAX_CROSS_REVIEW_ROUNDS)
                open_material = decision["risks_rollup_summary"]["material_cross_review_risks"]
                masked_new += decision["terminal_state"] == "CONVERGED" and open_material > 0
        self.assertEqual((masked_old, masked_new), (18, 0))

    def test_the_first_rounds_material_risks_stay_open_because_no_reviewer_answered_them(self) -> None:
        for plan, evaluated in self.cases():
            with self.subTest(plan=plan["plan_id"]):
                state = _pv_fold(plan)
                decision = pc._evaluate_cross_review_state(
                    state, evaluated["round_number"], max_rounds=pc.MAX_CROSS_REVIEW_ROUNDS)
                gate = next(row for row in decision["gate_decisions"] if row["gate"] == pc.PRIOR_REVIEW_RISKS_GATE)
                expected = [pc.review_risk_id(1, risk_id) for risk_id in _first_round_material_ids(plan["events"][:-1])]
                self.assertTrue(expected)
                self.assertFalse(gate["passed"])
                self.assertEqual(sorted(gate["open_risk_ids"]), sorted(expected))
                self.assertEqual(state["review_risk_dispositions"], {}, "the old ledgers carry no reviewer answer")

    def test_the_authors_claim_is_stored_and_resolves_nothing(self) -> None:
        for plan, evaluated in self.cases():
            with self.subTest(plan=plan["plan_id"]):
                at = next(i for i, event in enumerate(plan["events"]) if event["event_type"] == "revision_recorded")
                revision = plan["events"][at]["payload"]
                self.assertTrue(revision["addresses_review_risk_ids"])
                claims = {risk_id: [revision["revision_id"]] for risk_id in revision["addresses_review_risk_ids"]}
                # The fold the moment the author's revision lands, and at the evaluation: stored, never resolved.
                for state in (_pv_fold(plan, plan["events"][: at + 1]), _pv_fold(plan)):
                    self.assertEqual(state["review_risk_claims"], claims)
                    self.assertEqual(state["resolved_review_risk_ids"], [])
                decision = pc._evaluate_cross_review_state(
                    _pv_fold(plan), evaluated["round_number"], max_rounds=pc.MAX_CROSS_REVIEW_ROUNDS)
                self.assertEqual(decision["risks_rollup_summary"]["resolved_review_risks"], 0)

    def test_the_same_claims_addressed_in_the_new_round_scoped_ids_clear_nothing_either(self) -> None:
        """The old authors named ``CR-001``; an author under the new law names ``CR-R1-CR-001``. It clears nothing."""
        for plan, evaluated in self.cases():
            with self.subTest(plan=plan["plan_id"]):
                readdressed = copy.deepcopy(plan)
                for event in readdressed["events"]:
                    if event["event_type"] == "revision_recorded":
                        payload = event["payload"]
                        payload["addresses_review_risk_ids"] = [
                            pc.review_risk_id(payload["round"], risk_id) for risk_id in payload["addresses_review_risk_ids"]]
                state = _pv_fold(readdressed)
                round_number = evaluated["round_number"]
                decision = pc._evaluate_cross_review_state(state, round_number, max_rounds=pc.MAX_CROSS_REVIEW_ROUNDS)
                self.assertEqual(decision["terminal_state"], "NEXT_ROUND_REQUIRED")
                expected = sorted(pc.review_risk_id(1, risk_id) for risk_id in _first_round_material_ids(plan["events"][:-1]))
                gate = next(row for row in decision["gate_decisions"] if row["gate"] == pc.PRIOR_REVIEW_RISKS_GATE)
                self.assertEqual(sorted(gate["open_risk_ids"]), expected)
                claimed = [row for row in pc.prior_review_risks(state, round_number) if row["author_claimed_in_revisions"]]
                self.assertTrue(claimed, "the claim is visible to the next reviewer, beside the risk it names")
                self.assertTrue(all(row["latest_disposition"] is None for row in claimed))

    def test_a_later_rounds_risk_ids_cannot_collide_with_a_claimed_earlier_id(self) -> None:
        for plan, evaluated in self.cases():
            with self.subTest(plan=plan["plan_id"]):
                state = _pv_fold(plan)
                by_round = state["cross_review_risks_by_round"]
                reviewer_ids = [
                    (round_number, risk["risk_id"]) for round_number, risks in sorted(by_round.items())
                    for risk in risks if not risk["risk_id"].startswith(("COV-R", "IMP-R"))
                ]
                for round_number, risk_id in reviewer_ids:
                    self.assertTrue(risk_id.startswith(f"{pc.REVIEW_RISK_ID_PREFIX}{round_number}-"), risk_id)
                self.assertEqual(
                    len({risk_id for _, risk_id in reviewer_ids}), len(reviewer_ids), "one id names one risk")
                round_number = evaluated["round_number"]
                for risk in old_law_judgment(plan["events"][:-1], round_number).masked_material:
                    scoped = pc.review_risk_id(round_number, risk["risk_id"])
                    self.assertIn(scoped, {row["risk_id"] for row in by_round[round_number]})
                    self.assertNotIn(scoped, state["review_risk_claims"])
                    self.assertNotIn(scoped, state["resolved_review_risk_ids"])


if __name__ == "__main__":
    unittest.main()
