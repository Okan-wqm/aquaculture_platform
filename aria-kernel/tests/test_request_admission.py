"""ARIA-HIGH-364 — request admission: drain budget, liveness, provider outage, classes.

Measured 2026-10-06 on the runner's store: ~66 requests minted a day against
~28 drained, 606 never claimed, 836 ANCHOR_STALE, 325 minted while the
executor was disabled. These pin the door that ties minting to the measured
drain and to evidence that something is draining:

* the budget is max(floor, days-of-drain x drained/day) over a trailing
  window, from the ledgers (never a constant guess);
* no result or claim for the liveness window while work waits stops
  discretionary minting; an idle executor with nothing waiting does not;
* a role whose every provider is cooled is not minted discretionary work;
* critical-path mints are admitted and recorded through all of it;
* a refusal is one governance row per (cycle, role) and one admissions row
  per (cycle, producer, role, reason);
* a throttled producer is admitted on the next cycle once the drain caught up.
"""
from __future__ import annotations

import json
import shutil
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any
from unittest.mock import patch

from aria_kernel import agent_invocations as invocations
from aria_kernel.agent_invocations import create_agent_invocation_request
from aria_kernel.ledger import load_declared_jsonl, load_jsonl
from aria_kernel.auto_merge import record_pr_lifecycle
from aria_kernel.pr_tracking import dispatch_change_intelligence, ingest_merged_pr_lifecycle
from aria_kernel.request_admission import (
    GOVERNANCE_KIND,
    RequestAdmissionThrottled,
    admissions_path,
    admit_request,
)
from aria_kernel.request_admission_report import admission_cycle_summary, render_request_admission_section
from aria_kernel.request_drain_capacity import measure_drain_capacity, request_admission_policy
from aria_kernel.tool_registry import GovernanceError, ensure_tools_dir

NOW = datetime.now(timezone.utc).replace(microsecond=0)


def _iso(moment: datetime) -> str:
    return moment.replace(microsecond=0).isoformat()


def _ledgers(pending: int, *, pending_age: timedelta, drained: int, drained_age: timedelta,
             claimed_age: timedelta | None = None) -> tuple[list[dict[str, Any]], ...]:
    """Synthetic (requests, results, claims): ``pending`` claimable, ``drained`` with results."""
    requests: list[dict[str, Any]] = []
    results: list[dict[str, Any]] = []
    claims: list[dict[str, Any]] = []
    for i in range(pending):
        requests.append({"request_id": f"p-{i}", "role": "evidence_judgment", "state": "pending",
                         "created_at": _iso(NOW - pending_age)})
    for i in range(drained):
        requests.append({"request_id": f"d-{i}", "role": "evidence_judgment", "state": "pending",
                         "created_at": _iso(NOW - drained_age - timedelta(hours=1))})
        results.append({"request_id": f"d-{i}", "status": "rejected", "submitted_at": _iso(NOW - drained_age)})
    if claimed_age is not None:
        claims.append({"request_id": "p-0", "claim_id": "c-0", "event": "claimed",
                       "claimed_at": _iso(NOW - claimed_age),
                       "lease_expires_at": _iso(NOW - claimed_age + timedelta(minutes=1))})
        claims.append({"request_id": "p-0", "claim_id": "c-0", "event": "released",
                       "released_at": _iso(NOW - claimed_age + timedelta(minutes=1)), "reason": "harness"})
    return requests, results, claims


class _Store(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = Path(tempfile.mkdtemp(prefix="aria-364-"))
        self.tools = ensure_tools_dir(self._tmp / "aria-tools")

    def tearDown(self) -> None:
        shutil.rmtree(self._tmp, ignore_errors=True)

    def queue(self, ledgers: tuple[list[dict[str, Any]], ...]) -> Any:
        return patch("aria_kernel.request_drain_capacity._request_ledgers", return_value=ledgers)

    def admit(self, producer: str = "judge_fanout.sample", role: str = "evidence_judgment",
              cycle: str = "cyc-1", **kwargs: Any) -> Any:
        return admit_request(producer, role, base_dir=self.tools, cycle_id=cycle, now=NOW, **kwargs)

    def decisions(self) -> list[dict[str, Any]]:
        return [row for row in load_declared_jsonl(admissions_path(self.tools),
                                                   expected_surface="agent_invocation_admissions")
                if row.get("row_type") == "decision"]

    def governance(self) -> list[dict[str, Any]]:
        return [row for row in load_jsonl(self.tools / "governance.jsonl") if row.get("kind") == GOVERNANCE_KIND]


class BudgetMath(_Store):
    def test_the_budget_is_days_of_drain_times_the_measured_rate(self) -> None:
        # 70 results in the 7-day window = 10/day; 2 days of drain = 20, so
        # the floor (32) is the budget; at 140 results (20/day) it is 40.
        policy = request_admission_policy(self.tools)
        with self.queue(_ledgers(5, pending_age=timedelta(hours=1), drained=70, drained_age=timedelta(days=1))):
            low = measure_drain_capacity(self.tools, now=NOW, policy=policy)
        with self.queue(_ledgers(5, pending_age=timedelta(hours=1), drained=140, drained_age=timedelta(days=1))):
            high = measure_drain_capacity(self.tools, now=NOW, policy=policy)
        self.assertEqual((low.drain_per_day, low.budget, low.backlog), (10.0, 32.0, 5))
        self.assertEqual((high.drain_per_day, high.budget), (20.0, 40.0))

    def test_results_outside_the_window_are_not_drain(self) -> None:
        with self.queue(_ledgers(0, pending_age=timedelta(hours=1), drained=50, drained_age=timedelta(days=8))):
            capacity = measure_drain_capacity(self.tools, now=NOW, policy=request_admission_policy(self.tools))
        self.assertEqual(capacity.drained_in_window, 0)

    def test_requests_past_the_anchor_window_are_not_backlog(self) -> None:
        # The default anchor is 3 days; a 4-day-old PENDING row is dead.
        with self.queue(_ledgers(9, pending_age=timedelta(days=4), drained=7, drained_age=timedelta(hours=2))):
            capacity = measure_drain_capacity(self.tools, now=NOW, policy=request_admission_policy(self.tools))
        self.assertEqual(capacity.backlog, 0)

    def test_a_policy_value_out_of_bounds_is_refused_by_name(self) -> None:
        config = self._tmp / "aria-config"
        config.mkdir()
        (config / "genesis_policy.json").write_text(json.dumps({"request_admission": {"backlog_floor": -1}}))
        with self.assertRaisesRegex(GovernanceError, "request_admission.backlog_floor"):
            request_admission_policy(self.tools)

    def test_discretionary_stops_at_the_budget(self) -> None:
        with self.queue(_ledgers(31, pending_age=timedelta(hours=1), drained=7, drained_age=timedelta(hours=2))):
            first = self.admit()
            second = self.admit()
        self.assertTrue(first.admitted)
        self.assertFalse(second.admitted)
        self.assertEqual(second.refusal, "request_admission_throttled:backlog_at_drain_budget")

    def test_a_panel_is_admitted_whole_or_not_at_all(self) -> None:
        with self.queue(_ledgers(30, pending_age=timedelta(hours=1), drained=7, drained_age=timedelta(hours=2))):
            panel = self.admit("human_required_panel.open", "human_required_adjudication", count=3)
        self.assertFalse(panel.admitted)


class ExecutorLiveness(_Store):
    def test_no_drain_for_the_window_while_work_waits_stops_discretionary_minting(self) -> None:
        # The 09-27..10-04 shape: work waiting two days, nothing drained.
        with self.queue(_ledgers(3, pending_age=timedelta(hours=48), drained=0, drained_age=timedelta(0))):
            refused = self.admit()
        self.assertEqual(refused.refusal, "request_admission_throttled:executor_not_draining")

    def test_a_recent_claim_is_liveness(self) -> None:
        with self.queue(_ledgers(3, pending_age=timedelta(hours=48), drained=0, drained_age=timedelta(0),
                                 claimed_age=timedelta(hours=2))):
            self.assertTrue(self.admit().admitted)

    def test_an_idle_executor_with_nothing_waiting_is_not_dead(self) -> None:
        # Nothing drained for a week and nothing waiting: reading this as a
        # dead executor would stop minting until something drained — never.
        with self.queue(_ledgers(2, pending_age=timedelta(hours=1), drained=0, drained_age=timedelta(0))):
            self.assertTrue(self.admit().admitted)


class ProviderOutage(_Store):
    def _cooled(self, *providers: str) -> Any:
        until = _iso(NOW + timedelta(hours=1))
        return patch("aria_kernel.provider_outage.cooled_providers",
                     return_value={p: {"until": until, "reason": "quota_unavailable"} for p in providers})

    def test_every_provider_of_the_role_cooled_throttles_discretionary(self) -> None:
        with self.queue(_ledgers(1, pending_age=timedelta(hours=1), drained=7, drained_age=timedelta(hours=2))), \
                self._cooled("anthropic", "zai", "openai"):
            refused = self.admit()
            critical = self.admit("convergence_drainer.plan_step", "challenger_plan")
        self.assertEqual(refused.refusal, "request_admission_throttled:provider_unavailable")
        self.assertTrue(critical.admitted)

    def test_a_provider_left_on_the_ladder_is_not_an_outage(self) -> None:
        with self.queue(_ledgers(1, pending_age=timedelta(hours=1), drained=7, drained_age=timedelta(hours=2))), \
                self._cooled("anthropic"):
            self.assertTrue(self.admit().admitted)


class PriorityClasses(_Store):
    def test_critical_path_is_admitted_while_discretionary_is_throttled(self) -> None:
        with self.queue(_ledgers(50, pending_age=timedelta(hours=1), drained=7, drained_age=timedelta(hours=2))):
            discretionary = self.admit()
            steps = [self.admit("convergence_drainer.plan_step", role)
                     for role in ("challenger_plan", "cross_review", "primary_plan", "completeness_critique")]
            implementation = self.admit("implementer.converged_plan", "implementation")
            operator = self.admit("operator_cli.request", "verification")
        self.assertFalse(discretionary.admitted)
        self.assertTrue(all(step.admitted for step in [*steps, implementation, operator]))
        self.assertEqual({row["purpose_class"] for row in self.decisions() if row["admitted"]}, {"critical_path"})

    def test_a_dead_plan_step_reminted_by_a_panel_is_critical_and_a_judge_is_not(self) -> None:
        with self.queue(_ledgers(50, pending_age=timedelta(hours=1), drained=7, drained_age=timedelta(hours=2))):
            self.assertTrue(self.admit("human_required_panel.remint", "primary_plan").admitted)
            self.assertFalse(self.admit("human_required_panel.remint", "evidence_judgment").admitted)

    def test_an_unclassified_producer_or_role_is_refused_with_no_default(self) -> None:
        with self.assertRaisesRegex(GovernanceError, "request_admission_producer_unclassified:nobody"):
            self.admit("nobody")
        with self.assertRaisesRegex(GovernanceError, "request_admission_role_unclassified:judge_fanout.sample"):
            self.admit("judge_fanout.sample", "implementation")


class TheMintRequiresAnAdmittedTicket(_Store):
    def _mint(self, admission: Any, prompt: str = "judge it") -> dict[str, Any]:
        return create_agent_invocation_request(
            target_agent="aria-evidence-judge", role="evidence_judgment", suggested_prompt=prompt,
            must_satisfy=[{"id": "verdict", "description": "verdict"}], allowed_scope=["**"],
            base_dir=self.tools, admission=admission,
        )

    def test_a_throttled_ticket_writes_nothing_and_a_wrong_role_is_refused(self) -> None:
        with self.queue(_ledgers(50, pending_age=timedelta(hours=1), drained=7, drained_age=timedelta(hours=2))):
            refused = self.admit()
        with self.assertRaisesRegex(RequestAdmissionThrottled, "backlog_at_drain_budget"):
            self._mint(refused)
        self.assertEqual(invocations.list_agent_invocation_requests(base_dir=self.tools), [])
        wrong = admit_request("operator_cli.request", "verification", base_dir=self.tools)
        with self.assertRaisesRegex(GovernanceError, "request_admission_role_mismatch"):
            self._mint(wrong)

    def test_a_sealed_identity_is_returned_under_any_ticket(self) -> None:
        sealed = self._mint(admit_request("operator_cli.request", "evidence_judgment", base_dir=self.tools))
        with self.queue(_ledgers(50, pending_age=timedelta(hours=1), drained=7, drained_age=timedelta(hours=2))):
            refused = self.admit()
        self.assertEqual(self._mint(refused)["request_id"], sealed["request_id"])


class RefusalsAreRecordedOnce(_Store):
    def test_one_governance_row_per_cycle_and_role_and_one_admissions_row_per_reason(self) -> None:
        ledgers = _ledgers(50, pending_age=timedelta(hours=1), drained=7, drained_age=timedelta(hours=2))
        with self.queue(ledgers):
            for _ in range(3):
                self.admit()
            self.admit("judge_replay.goldset")
            self.admit(role="adversarial_judgment")
            self.admit(cycle="cyc-2")
        self.assertEqual(sorted((row["details"]["cycle_key"], row["details"]["role"]) for row in self.governance()),
                         [("cyc-1", "adversarial_judgment"), ("cyc-1", "evidence_judgment"),
                          ("cyc-2", "evidence_judgment")])
        throttled = [(r["cycle_key"], r["producer"], r["role"]) for r in self.decisions() if not r["admitted"]]
        self.assertEqual(len(throttled), len(set(throttled)))
        self.assertEqual(len(throttled), 4)

    def test_the_cycle_summary_reaches_the_daily_report(self) -> None:
        with self.queue(_ledgers(50, pending_age=timedelta(hours=1), drained=7, drained_age=timedelta(hours=2))):
            self.admit()
            self.admit("convergence_drainer.plan_step", "cross_review")
        summary = admission_cycle_summary(self.tools, "cyc-1")
        assert summary is not None
        self.assertEqual(summary["snapshot"]["backlog"], 50)
        self.assertEqual(summary["by_role"]["cross_review"]["admitted_critical_path"], 1)
        self.assertEqual(summary["by_role"]["evidence_judgment"]["throttled"][0]["reason"], "backlog_at_drain_budget")
        rendered = "\n".join(render_request_admission_section({"request_admission": summary}))
        self.assertIn("## Request Admission", rendered)
        self.assertIn("| evidence_judgment | 0 | 0 | judge_fanout.sample: backlog_at_drain_budget |", rendered)


class AThrottledProducerIsAdmittedOnceTheDrainCatchesUp(_Store):
    """Integration: the change-intelligence producer, one merge, two cycles."""

    def test_refused_this_cycle_minted_the_next(self) -> None:
        record_pr_lifecycle(
            {"number": 1822, "head_sha": "b" * 40, "base_branch": "main",
             "changed_files": ["aria-kernel/aria_kernel/cycle.py"]},
            event="merged", base_dir=self.tools,
        )
        ingest_merged_pr_lifecycle(base_dir=self.tools)
        behind = _ledgers(40, pending_age=timedelta(hours=1), drained=7, drained_age=timedelta(hours=2))
        with self.queue(behind):
            first = dispatch_change_intelligence(cycle_id="cyc-1", base_dir=self.tools)
        self.assertEqual(first["minted"], [])
        self.assertEqual(first["skipped"][0]["reason"], "request_admission_throttled:backlog_at_drain_budget")
        caught_up = _ledgers(5, pending_age=timedelta(hours=1), drained=40, drained_age=timedelta(hours=2))
        with self.queue(caught_up):
            second = dispatch_change_intelligence(cycle_id="cyc-2", base_dir=self.tools)
        self.assertEqual([row["pr_number"] for row in second["minted"]], [1822])


class ThePlannerDaemonBacksOffACooledProvider(_Store):
    """No claim while every provider of the selected seat is cooled."""

    def test_the_hook_returns_the_backoff_status_without_claiming(self) -> None:
        from aria_kernel.planner_dispatch_hook import (
            ADMISSION_BACKOFF_STATUSES,
            PROVIDER_COOLDOWN_STATUS,
            dispatch_one_pending_planner_request,
        )

        request = {"request_id": "req-1", "role": "primary_plan", "target_agent": "aria-primary-planner"}
        until = _iso(datetime.now(timezone.utc) + timedelta(hours=1))
        cooled = {p: {"until": until, "reason": "quota_unavailable"} for p in ("anthropic", "zai", "openai")}
        with patch.object(invocations, "next_pending_request", return_value=request), \
                patch("aria_kernel.provider_outage.cooled_providers", return_value=cooled), \
                patch.object(invocations, "claim_request", side_effect=AssertionError("claimed")):
            tick = dispatch_one_pending_planner_request(base_dir=self.tools, agent_id="daemon")
        self.assertEqual(tick["status"], PROVIDER_COOLDOWN_STATUS)
        self.assertIn(PROVIDER_COOLDOWN_STATUS, ADMISSION_BACKOFF_STATUSES)
        self.assertEqual(tick["provider_cooldown"]["providers"], ["anthropic", "zai", "openai"])


class PlanSeedingIsDiscretionaryAndPlanStepsAreNot(_Store):
    """The drainer decides a NEW plan before starting it; a started plan's rounds always mint."""

    def setUp(self) -> None:
        super().setUp()
        self.workspace = self._tmp / "workspace"
        (self.workspace / ".claude" / "agents").mkdir(parents=True)

    @staticmethod
    def seed(**extra: Any) -> dict[str, Any]:
        return {
            "schema_version": 1, "title": "T", "summary": "S",
            "affected_surfaces": [{"paths": ["aria-kernel/aria_kernel/plan_convergence.py"]}],
            "key_changes": ["x"], "validation_commands": [{"cmd": "nx affected --target=test"}],
            "evidence_refs": ["docs/aria/SPEC.md"], "architectural_tier": 2, **extra,
        }

    def drain(self, plan_id: str, seed: dict[str, Any]) -> dict[str, Any]:
        from aria_kernel.convergence_drainer import run_convergence_drainer

        return dict(run_convergence_drainer(cycle_id="cyc-1", base_dir=self.tools, workspace_root=self.workspace,
                                            plan_id=plan_id, plan_seed=seed))

    def test_a_new_plan_is_not_started_over_budget_and_an_operator_plan_is(self) -> None:
        from aria_kernel.operator_feedback_ingestion import PROVENANCE_REF_PREFIX
        from aria_kernel.plan_convergence import fold_plan_state

        with self.queue(_ledgers(50, pending_age=timedelta(hours=1), drained=7, drained_age=timedelta(hours=2))):
            refused = self.drain("plan-aria", self.seed())
            operator = self.drain("plan-op", self.seed(provenance_refs=[f"{PROVENANCE_REF_PREFIX}req-1"]))
            # The refused seed started nothing; the operator's plan is in flight.
            self.assertEqual(refused["arbiter_verdict"], "request_admission_throttled")
            self.assertIsNone(fold_plan_state(plan_id="plan-aria", base_dir=self.tools).get("state"))
            self.assertEqual(operator["arbiter_verdict"], "in_progress")
            self.assertEqual(fold_plan_state(plan_id="plan-op", base_dir=self.tools).get("state"), "DRAFT")
        roles = sorted((row["producer"], row["admitted"]) for row in self.decisions())
        self.assertEqual(roles, [("convergence_drainer.operator_plan_seed", True),
                                 ("convergence_drainer.plan_seed", False)])


if __name__ == "__main__":
    unittest.main()
