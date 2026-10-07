"""ARIA-HIGH-360 — the kernel decides what happens to a request that expired unclaimed.

Measured 2026-10-06 on a copy of the runner store (1,866 requests): every
ANCHOR_STALE request got a HUMAN_REQUIRED record (Y7) and every record opened
a three-judge panel, three new requests on the queue that had just failed to
reach the first one. 693 of the 1,866 requests were these panels; all 3,023
folds were ``still_escalated``; no record was ever resolved.

Pins, against the production writers (``tests/_helpers/anchor_stale_store``):

* the rule is one function of the request, its expiry cause and its owner;
* the outage expiry reason is a contract (``anchor_expiry_cause``), and the
  reasons production writes today spend budget;
* every role has exactly one owner (``expiry_ownership``); work no producer
  recovers, and an operator's own request, stay OPEN for the operator;
* a live fan-out judge subject is re-minted the way the fan-out mints today,
  and a rule with no contract is refused as the fan-out refuses it;
* a projected maintenance request's queue item is re-offered;
* no panel request is ever minted for an expiry.

Migration, mootness, ledger cost and crash pins: test_anchor_stale_migration.
"""
from __future__ import annotations

import re
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Mapping

from aria_kernel import anchor_stale
from aria_kernel import human_required_adjudication as hra
from aria_kernel.agent_surface import INVOCATION_ROLES
from aria_kernel.anchor_expiry_cause import ExpiryCause, anchor_expiry_reason_in_outage
from aria_kernel.anchor_stale import ExpiryDecision, Lineage, decide_expiry_disposition
from aria_kernel.anchor_stale_effects import (
    DISPOSITION_DROPPED,
    DISPOSITION_OPERATOR,
    DISPOSITION_REMINTED,
    DISPOSITION_REOFFERED,
)
from aria_kernel.expiry_ownership import OWNER_OPERATOR, OWNER_PRODUCER, ROLE_OWNERSHIP
from aria_kernel.feedback_store import _sampleable_raw_findings, record_operator_feedback
from aria_kernel.human_required import RESOLVED_BY_KERNEL
from aria_kernel.judge_fanout import judge_request_fields
from aria_kernel.next_cycle_queue import append_pending, mark_consumed, read_pending
from aria_kernel.rule_contract import resolve_rule_contract
from aria_kernel.tool_registry import GovernanceError

from tests._helpers.anchor_stale_store import EVIDENCE_JUDGE, AnchorStaleStore, item

OUTAGE = anchor_expiry_reason_in_outage(["anthropic"])


class _Subjects:
    def __init__(self, closed: str | None = None) -> None:
        self.closed = closed

    def closure_reason(self, request: Mapping[str, Any]) -> str | None:
        return self.closed


class TheRuleIsOneFunctionOfTheCause(unittest.TestCase):
    JUDGE = {"request_id": "AIR-j", "role": "evidence_judgment"}

    def _decide(self, cause: ExpiryCause, **kwargs: Any) -> ExpiryDecision:
        facts: dict[str, Any] = {
            "owner": ("kernel_remint", "anchor_stale"), "successor_request_id": None,
            "lineage": Lineage(0, 0), "subjects": _Subjects(), "backlog_full": lambda role: False,
        }
        facts.update(kwargs)
        return decide_expiry_disposition(self.JUDGE, cause, **facts)

    def test_the_outage_reason_is_the_contract_and_production_reasons_spend(self) -> None:
        # The exact strings the expiry clock (ARIA-HIGH-365) writes and reads.
        self.assertEqual(OUTAGE, "anchor_expired_during_provider_outage:anthropic")
        self.assertEqual(anchor_expiry_reason_in_outage(["zai", "anthropic", "zai"]),
                         "anchor_expired_during_provider_outage:anthropic+zai")
        with self.assertRaises(ValueError):
            anchor_expiry_reason_in_outage([])
        self.assertFalse(ExpiryCause.from_reason(OUTAGE).spends_remint_budget)
        for reason in ("anchor_expired", "anchor_undatable", "anchor_unreachable", ""):
            with self.subTest(reason=reason):
                self.assertTrue(ExpiryCause.from_reason(reason).spends_remint_budget)

    def test_each_outcome(self) -> None:
        expired, outage = ExpiryCause.from_reason("anchor_expired"), ExpiryCause.from_reason(OUTAGE)
        cases = [
            (expired, {"successor_request_id": "AIR-s"}, ("recovered", "successor_exists")),
            (expired, {"owner": (OWNER_OPERATOR, "no_recovering_producer:verification")},
             ("operator", "no_recovering_producer:verification")),
            (expired, {"owner": (OWNER_PRODUCER, "convergence_drainer")},
             ("producer_owned", "producer_owned:convergence_drainer")),
            (expired, {"owner": ("reoffer", "autonomy_orchestrator")}, ("reoffer", "reoffer:autonomy_orchestrator")),
            (expired, {"backlog_full": lambda role: True}, ("wait", "judge_backlog_full")),
            (expired, {"subjects": _Subjects("already_judged")}, ("drop", "subject_closed:already_judged")),
            (expired, {"lineage": Lineage(1, 1)}, ("operator", "remint_budget_spent")),
            (outage, {"lineage": Lineage(1, 1)}, ("remint", "subject_live")),
            (outage, {"lineage": Lineage(2, 0)}, ("operator", "lineage_remint_cap_reached")),
            (expired, {}, ("remint", "subject_live")),
        ]
        for cause, facts, expected in cases:
            with self.subTest(cause=cause.reason, facts=sorted(facts)):
                decision = self._decide(cause, **facts)
                self.assertEqual((decision.action, decision.reason), expected)


class EveryRoleHasOneOwner(unittest.TestCase):
    def test_the_table_is_closed_over_the_roles(self) -> None:
        self.assertEqual(set(ROLE_OWNERSHIP), set(INVOCATION_ROLES))

    def test_every_claim_cites_a_line_that_exists(self) -> None:
        package = Path(anchor_stale.__file__).parent
        for role, ownership in ROLE_OWNERSHIP.items():
            with self.subTest(role=role):
                self.assertEqual(bool(ownership.producer), ownership.owner != OWNER_OPERATOR)
                cited = re.findall(r"([a-z_]+\.py):(\d+)", ownership.proof)
                self.assertTrue(cited, ownership.proof)
                for name, line in cited:
                    lines = (package / name).read_text(encoding="utf-8").splitlines()
                    self.assertLessEqual(int(line), len(lines), f"{name}:{line}")


class LiveJudgeSubjectIsReMinted(AnchorStaleStore):
    def _fanout_envelope(self, i: int) -> dict[str, Any]:
        """What the fan-out would mint for finding ``i`` today: the sampler's item, the current contract."""
        sampled = next(s for s in _sampleable_raw_findings(tool_id="tool-x", cycle_id=None, base_dir=self.tools)
                       if s["finding_id"] == f"F{i}")
        contract = resolve_rule_contract(tool_id="tool-x", rule=sampled["rule"], base_dir=self.tools)
        return judge_request_fields(sampled, contract)

    def test_reminted_at_head_as_the_fanout_mints_it(self) -> None:
        dead = self.mint_judges(1)[EVIDENCE_JUDGE]
        head = self.commit()
        self.expire(dead)

        summary = self.sweep()

        successor = self.successors(dead)[0]
        self.assertEqual(len(self.successors(dead)), 1)
        self.assertEqual(successor["target_sha"], head)
        original = self.row(dead)
        for field in ("role", "target_agent", "finding_id", "finding_fingerprint", "tool_id", "run_id",
                      "judgment_group_id", "forbidden_scope"):
            self.assertEqual(successor.get(field), original.get(field), field)
        expected = self._fanout_envelope(1)
        self.assertEqual(successor["suggested_prompt"], expected["suggested_prompt"])
        self.assertEqual(successor["must_satisfy"], expected["must_satisfy"])
        record = self.record(dead)
        self.assertEqual((record["status"], record["resolved_by"]), ("resolved", RESOLVED_BY_KERNEL))
        disposition = record["kernel_disposition"]
        self.assertEqual(disposition["disposition"], DISPOSITION_REMINTED)
        self.assertEqual(disposition["successor_request_id"], successor["request_id"])
        self.assertEqual((disposition["expiry_reason"], disposition["expiry_fault_class"]),
                         ("anchor_expired", "unclassified"))
        self.assertEqual([d["request_id"] for d in summary["disposed"]], [dead])
        self.assertEqual(self.adjudication_requests(), [])
        self.assertEqual(self.sweep()["disposed"], [])  # idempotent
        self.assertEqual(len(self.successors(dead)), 1)

    def test_a_pre_contract_envelope_is_rebuilt_from_the_contract(self) -> None:
        self.report(3)
        self.seed_row("AIR-pre-324", role="evidence_judgment", target_agent=EVIDENCE_JUDGE,
                      prompt="Did rule-a fire?", tool_id="tool-x", finding_id="F3", run_id="r1",
                      finding_fingerprint=item(3)["finding_fingerprint"],
                      judgment_group_id=f"judge:tool-x:{item(3)['finding_fingerprint']}")
        self.sweep()
        successor = self.successors("AIR-pre-324")[0]
        expected = self._fanout_envelope(3)
        self.assertNotEqual(successor["suggested_prompt"], "Did rule-a fire?")
        self.assertEqual(successor["suggested_prompt"], expected["suggested_prompt"])
        self.assertEqual(successor["must_satisfy"], expected["must_satisfy"])

    def test_a_rule_with_no_contract_is_refused_as_the_fanout_refuses_it(self) -> None:
        self.report(4, rule="rule-undeclared")
        self.seed_row("AIR-no-contract", role="evidence_judgment", target_agent=EVIDENCE_JUDGE,
                      tool_id="tool-x", finding_id="F4", run_id="r1", judgment_group_id="judge:tool-x:F4")
        self.sweep()
        disposition = self.disposition("AIR-no-contract")
        self.assertEqual((disposition["disposition"], disposition["reason"]),
                         (DISPOSITION_DROPPED, "subject_closed:rule_contract_undeclared"))
        self.assertEqual(self.successors("AIR-no-contract"), [])

    def test_a_successor_that_expires_too_goes_to_the_operator(self) -> None:
        dead = self.mint_judges(1)[EVIDENCE_JUDGE]
        self.expire(dead)
        self.sweep()
        successor = self.successors(dead)[0]["request_id"]
        self.expire(successor)
        self.sweep()
        record = self.record(successor)
        self.assertEqual(record["status"], "open")
        self.assertEqual((record["kernel_disposition"]["disposition"], record["kernel_disposition"]["reason"]),
                         (DISPOSITION_OPERATOR, "remint_budget_spent"))
        self.assertEqual(self.successors(successor), [])
        self.assertEqual(self.adjudication_requests(), [])

    def test_outage_expiries_spend_no_budget_and_the_lineage_is_capped(self) -> None:
        dead = self.mint_judges(1)[EVIDENCE_JUDGE]
        chain = [dead]
        for _ in range(2):
            self.expire(chain[-1], OUTAGE)
            self.sweep()
            chain.append(self.successors(chain[-1])[0]["request_id"])
        self.expire(chain[-1], OUTAGE)
        self.sweep()
        self.assertEqual(self.disposition(dead)["expiry_fault_class"], "harness")
        self.assertEqual(self.disposition(chain[-1])["reason"], "lineage_remint_cap_reached")
        self.assertEqual(self.record(chain[-1])["status"], "open")
        self.assertEqual(self.successors(chain[-1]), [])


class ClosedSubjectsAreDroppedByName(AnchorStaleStore):
    def test_a_finding_this_judge_already_answered(self) -> None:
        dead = self.mint_judges(1)[EVIDENCE_JUDGE]
        record_operator_feedback(
            tool_id="tool-x", run_id="r0", finding_id="F1", verdict="true_positive", severity="medium",
            note="answered through another request", source_type="ai_judge", judge_id=EVIDENCE_JUDGE,
            finding_fingerprint=item(1)["finding_fingerprint"], base_dir=self.tools,
        )
        self.expire(dead)
        self.sweep()
        self.assertEqual(self.disposition(dead)["reason"], "subject_closed:already_judged")
        self.assertEqual(self.successors(dead), [])

    def test_a_finding_no_run_reported_inside_the_sampling_window(self) -> None:
        dead = self.mint_judges(1)[EVIDENCE_JUDGE]
        self.expire(dead)
        self.sweep(now=datetime.now(timezone.utc) + timedelta(days=8))
        self.assertEqual(self.disposition(dead)["reason"], "subject_closed:finding_not_reported_recently")

    def test_a_finding_no_run_ever_reported(self) -> None:
        dead = self.mint_judges(2, reported=False)[EVIDENCE_JUDGE]
        self.expire(dead)
        self.sweep()
        self.assertEqual(self.disposition(dead)["reason"], "subject_closed:finding_not_reported_recently")


class NoWorkIsLost(AnchorStaleStore):
    def test_a_role_no_producer_recovers_stays_open_and_notifies(self) -> None:
        self.seed_row("AIR-verify-1", role="verification", target_agent="aria-adversarial-judge")
        self.sweep()
        record = self.record("AIR-verify-1")
        self.assertEqual(record["status"], "open")
        self.assertNotIn("resolved_at", record)
        self.assertEqual(record["kernel_disposition"]["reason"], "no_recovering_producer:verification")
        outbox = (self.tools / "notifications" / "outbox.jsonl").read_text(encoding="utf-8")
        self.assertIn("human_required_opened", outbox)
        self.assertIn("1 expired request(s) need an operator", outbox)
        # Never a panel question, and never decided twice.
        self.assertFalse(hra.escalation_adjudicability(record).adjudicable)
        self.assertEqual(self.sweep()["disposed"], [])

    def test_an_operator_minted_request_is_never_dropped(self) -> None:
        # The CLI shape: no judgment group, no anchor sha (cli.py agent-invocations request).
        self.seed_row("AIR-cli-judge", role="evidence_judgment", target_agent=EVIDENCE_JUDGE)
        self.seed_row("AIR-cli-plan", role="challenger_plan", target_agent="aria-challenger-planner",
                      convergence_id="plan-1", round_number=1)
        self.sweep()
        for request_id, producer in (("AIR-cli-judge", "anchor_stale"), ("AIR-cli-plan", "convergence_drainer")):
            with self.subTest(request_id=request_id):
                self.assertEqual(self.record(request_id)["status"], "open")
                self.assertEqual(self.disposition(request_id)["reason"], f"producer_unverified:{producer}")

    def test_a_verified_planning_step_is_left_to_the_drainer(self) -> None:
        self.seed_row("AIR-plan-1", role="challenger_plan", target_agent="aria-challenger-planner",
                      convergence_id="plan-1", round_number=1, target_sha=self.first_sha)
        self.assertEqual(self.sweep()["disposed"], [])
        self.assertFalse(self.record_path("AIR-plan-1").exists())

    def test_a_projected_maintenance_item_is_offered_again(self) -> None:
        queued = append_pending(self.tools, source_cycle_id="c1", pressure_id="p1", recommended_action="act")
        qid = str(queued["queue_item_id"])
        mark_consumed(self.tools, queue_item_id=qid, consumed_by="daemon")
        prompt = f'{{"$schema": "aria/next-cycle-queue-request/v1", "queue_item_id": "{qid}"}}'
        self.seed_row("AIR-maint-q", role="maintenance_utility", target_agent="aria-autonomy-planner", prompt=prompt)
        self.assertNotIn(qid, [row["queue_item_id"] for row in read_pending(self.tools)])
        self.sweep()
        disposition = self.disposition("AIR-maint-q")
        self.assertEqual((disposition["disposition"], disposition["queue_item_id"]), (DISPOSITION_REOFFERED, qid))
        pending = read_pending(self.tools)
        self.assertEqual([row["queue_item_id"] for row in pending], [qid])
        self.assertEqual(pending[0]["recommended_action"], "act")


class NoPanelForAnExpiry(AnchorStaleStore):
    def test_the_kind_is_refused_and_no_panel_is_minted(self) -> None:
        verdict = hra.escalation_adjudicability({"context": {"kind": anchor_stale.ANCHOR_STALE_KIND}})
        self.assertEqual((verdict.adjudicable, verdict.reason), (False, "context_kind_not_admitted:anchor_stale"))
        with self.assertRaises(GovernanceError):
            hra.open_adjudication(escalation_request_id="AIR-x",
                                  record={"context": {"kind": anchor_stale.ANCHOR_STALE_KIND}}, base_dir=self.tools)
        for request_id in self.mint_judges(1).values():
            self.expire(request_id)
        self.seed_row("AIR-verify-2", role="verification", target_agent="aria-adversarial-judge")
        for _ in range(3):
            self.sweep()
            hra.sweep_human_required_adjudications(base_dir=self.tools)
        self.assertEqual(self.adjudication_requests(), [])


if __name__ == "__main__":
    unittest.main()
