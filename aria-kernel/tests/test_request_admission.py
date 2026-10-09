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
from aria_kernel.merge_record import MERGED_BY_MERGE_LANE, record_merge
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


def _mint_judge(tools: Path, admission: Any, *, role: str = "evidence_judgment",
                agent: str | None = None) -> dict[str, Any]:
    agents = {"evidence_judgment": "aria-evidence-judge", "adversarial_judgment": "aria-adversarial-judge"}
    return create_agent_invocation_request(
        target_agent=agent or agents[role], role=role, suggested_prompt="judge it",
        must_satisfy=[{"id": "verdict", "description": "verdict"}], allowed_scope=["**"],
        cycle_id="cyc-1", base_dir=tools, admission=admission,
    )


def _admission_rows(tools: Path) -> list[dict[str, Any]]:
    return load_declared_jsonl(admissions_path(tools), expected_surface="agent_invocation_admissions")


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

    def test_a_policy_value_out_of_bounds_falls_back_and_is_disclosed_once(self) -> None:
        config = self._tmp / "aria-config"
        config.mkdir()
        (config / "genesis_policy.json").write_text(json.dumps({"request_admission": {"backlog_floor": 0}}))
        for _ in range(2):
            self.assertEqual(request_admission_policy(self.tools).backlog_floor, 32)
        rows = [row for row in load_jsonl(self.tools / "governance.jsonl")
                if row.get("kind") == "request_admission_policy_invalid"]
        self.assertEqual([row["details"]["key"] for row in rows], ["request_admission.backlog_floor"])

    def test_discretionary_stops_at_the_budget(self) -> None:
        with self.queue(_ledgers(31, pending_age=timedelta(hours=1), drained=7, drained_age=timedelta(hours=2))):
            self.assertTrue(self.admit().admitted)
        with self.queue(_ledgers(32, pending_age=timedelta(hours=1), drained=7, drained_age=timedelta(hours=2))):
            refused = self.admit(cycle="cyc-2")
        self.assertEqual(refused.refusal, "request_admission_throttled:backlog_at_drain_budget")

    def test_only_a_new_identity_consumes_the_budget(self) -> None:
        # 31 waiting against a budget of 32: one new request fills it. The
        # same request asked again writes nothing and consumes nothing.
        with self.queue(_ledgers(31, pending_age=timedelta(hours=1), drained=7, drained_age=timedelta(hours=2))):
            ticket = self.admit()
            first = _mint_judge(self.tools, ticket)
            self.assertEqual(_mint_judge(self.tools, self.admit())["request_id"], first["request_id"])
            refused = self.admit()
        self.assertFalse(refused.admitted)
        minted = [row for row in _admission_rows(self.tools) if row["row_type"] == "minted"]
        self.assertEqual([row["request_id"] for row in minted], [first["request_id"]])

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
            gate_b = self.admit("review_runner.post_implementation", "adversarial_judgment")
            operator = self.admit("operator_cli.request", "verification")
        self.assertFalse(discretionary.admitted)
        self.assertTrue(all(step.admitted for step in [*steps, implementation, gate_b, operator]))
        self.assertEqual({row["producer"] for row in self.decisions()}, {"judge_fanout.sample"})

    def test_a_re_mint_keeps_the_class_its_dead_request_was_admitted_under(self) -> None:
        from aria_kernel.human_required_adjudication import _remint_producer

        self.assertEqual(_remint_producer({"request_admission": {"purpose_class": "critical_path"}}),
                         "human_required_panel.remint_critical")
        self.assertEqual(_remint_producer({"request_admission": {"purpose_class": "discretionary"}}),
                         "human_required_panel.remint")
        # A row minted before the door recorded a class: bounded, re-offered.
        self.assertEqual(_remint_producer({"role": "adversarial_judgment"}), "human_required_panel.remint")
        sealed = _mint_judge(self.tools, admit_request("review_runner.post_implementation", "adversarial_judgment",
                                                       base_dir=self.tools), role="adversarial_judgment")
        self.assertEqual(sealed["request_admission"],
                         {"producer": "review_runner.post_implementation", "purpose_class": "critical_path"})

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
            _mint_judge(self.tools, self.admit("convergence_drainer.plan_step", "cross_review"),
                        role="cross_review", agent="aria-cross-reviewer")
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
        # ARIA-HIGH-390 — the merged row has one writer.
        record_merge(
            pr={"number": 1822, "head_sha": "b" * 40, "base_branch": "main",
                "changed_files": ["aria-kernel/aria_kernel/cycle.py"]},
            merged_by=MERGED_BY_MERGE_LANE, base_dir=self.tools,
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
    """The drainer decides a NEW plan before starting it; one seed per cycle is reserved."""

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

    def test_one_new_plan_starts_per_cycle_while_panels_and_judges_are_over_budget(self) -> None:
        # Review of #1833 (HIGH-1): panels and judges run earlier in the cycle
        # and their demand alone exceeds the drain. The first seed of the
        # cycle is still admitted; the second waits for the budget; an
        # operator's plan is never throttled.
        from aria_kernel.operator_feedback_ingestion import PROVENANCE_REF_PREFIX
        from aria_kernel.plan_convergence import fold_plan_state

        with self.queue(_ledgers(80, pending_age=timedelta(hours=1), drained=28, drained_age=timedelta(hours=2))):
            self.assertFalse(self.admit("human_required_panel.open", "human_required_adjudication", count=3).admitted)
            self.assertFalse(self.admit("judge_fanout.sample").admitted)
            first = self.drain("plan-a", self.seed())
            second = self.drain("plan-b", self.seed())
            operator = self.drain("plan-op", self.seed(provenance_refs=[f"{PROVENANCE_REF_PREFIX}req-1"]))
            self.assertEqual(first["arbiter_verdict"], "in_progress")
            self.assertEqual(fold_plan_state(plan_id="plan-a", base_dir=self.tools).get("state"), "DRAFT")
            self.assertEqual(second["arbiter_verdict"], "request_admission_throttled")
            self.assertIsNone(fold_plan_state(plan_id="plan-b", base_dir=self.tools).get("state"))
            self.assertEqual(operator["arbiter_verdict"], "in_progress")
        minted = [(row["producer"], row["reason"]) for row in _admission_rows(self.tools) if row["row_type"] == "minted"]
        self.assertIn(("convergence_drainer.plan_seed", "plan_seed_quota"), minted)

    def test_the_seed_quota_does_not_override_a_dead_executor(self) -> None:
        with self.queue(_ledgers(3, pending_age=timedelta(hours=48), drained=0, drained_age=timedelta(0))):
            refused = self.admit("convergence_drainer.plan_seed", "challenger_plan")
        self.assertEqual(refused.refusal, "request_admission_throttled:executor_not_draining")


class AThrottledPanelReMintIsDeferredNotResolved(_Store):
    """Review of #1833 (MEDIUM-3): a cleared panel whose successor the door refuses."""

    def test_deferred_this_sweep_reminted_the_next(self) -> None:
        from aria_kernel import human_required_adjudication as hra
        from tests.test_y7_self_adjudication import ReMintDisposition

        case = ReMintDisposition("test_resolve_quorum_with_re_mint_mints_one_successor")
        case.setUp()
        self.addCleanup(case.tearDown)
        for rid, agent in zip(case._open(), ("judge-a", "judge-b", "judge-c")):
            case._seed_opinion(rid, agent_id=agent, verdict=hra.RESOLVE_VERDICT, disposition=hra.DISPOSITION_RE_MINT)
        with self.queue(_ledgers(50, pending_age=timedelta(hours=1), drained=7, drained_age=timedelta(hours=2))):
            held = hra.sweep_human_required_adjudications(base_dir=case.tools, cycle_id="cyc-1")
        self.assertEqual([row["request_id"] for row in held["throttled_retry"]], [case.escalation_id])
        self.assertEqual(held["resolved"], [])
        self.assertEqual(case._record()["status"], "open")
        self.assertNotIn("panel_disposition", case._record())
        self.assertEqual(case._successors(), [])
        with self.queue(_ledgers(5, pending_age=timedelta(hours=1), drained=40, drained_age=timedelta(hours=2))):
            hra.sweep_human_required_adjudications(base_dir=case.tools, cycle_id="cyc-2")
        self.assertEqual(len(case._successors()), 1)
        self.assertEqual(case._record()["status"], "resolved")


class AThrottledJudgeReMintRetriesWithNoRecord(_Store):
    """Review of #1833 (MEDIUM-5): ARIA-HIGH-360's anchor-stale re-mint, refused by the door.

    A refusal must not become an operator escalation (that would feed the
    panels the anchor-stale disposition removed): no record is written, and
    the next sweep decides the expired judge again.
    """

    def test_refused_this_sweep_reminted_the_next(self) -> None:
        from tests._helpers.anchor_stale_store import EVIDENCE_JUDGE, AnchorStaleStore

        case = AnchorStaleStore("setUp")
        case.setUp()
        self.addCleanup(case.tearDown)
        judges = [case.mint_judges(i)[EVIDENCE_JUDGE] for i in (1, 2)]
        case.commit()
        for dead in judges:
            case.expire(dead)
        # One slot of headroom: both re-mints pass the per-class question,
        # the first mint fills the budget, the second is refused AT the mint.
        with self.queue(_ledgers(31, pending_age=timedelta(hours=1), drained=7, drained_age=timedelta(hours=2))):
            held = case.sweep(cycle_id="cyc-1")
        refused = [row["request_id"] for row in held["throttled_retry"]]
        self.assertEqual(len(refused), 1)
        self.assertEqual(len(held["disposed"]), 1)
        self.assertFalse(case.record_path(refused[0]).exists())
        self.assertEqual(case.successors(refused[0]), [])
        self.assertEqual(case.adjudication_requests(), [])
        with self.queue(_ledgers(5, pending_age=timedelta(hours=1), drained=40, drained_age=timedelta(hours=2))):
            case.sweep(cycle_id="cyc-2")
        self.assertEqual(len(case.successors(refused[0])), 1)
        self.assertEqual(case.record(refused[0])["status"], "resolved")


class RefusedReMintsDoNotHoldTheSweepsSlots(_Store):
    """Re-review of #1833 (HIGH-A): refused judge re-mints wait without taking a slot."""

    def test_older_expiries_are_decided_while_refused_judges_wait(self) -> None:
        from aria_kernel import anchor_stale
        from tests._helpers.anchor_stale_store import EVIDENCE_JUDGE, AnchorStaleStore

        case = AnchorStaleStore("setUp")
        case.setUp()
        self.addCleanup(case.tearDown)
        case.seed_row("AIR-verify-1", role="verification", target_agent="aria-adversarial-judge")
        judges = [case.mint_judges(i)[EVIDENCE_JUDGE] for i in (1, 2, 3)]
        case.commit()
        for dead in judges:
            case.expire(dead)
        over_budget = _ledgers(50, pending_age=timedelta(hours=1), drained=7, drained_age=timedelta(hours=2))
        with patch.object(anchor_stale, "ANCHOR_STALE_DISPOSITIONS_PER_SWEEP", 2), self.queue(over_budget):
            held = case.sweep(cycle_id="cyc-1")
        # The three newest items are refused judges; the older expiry is
        # still decided inside a two-slot sweep, and handed to the operator.
        self.assertEqual([row["request_id"] for row in held["disposed"]], ["AIR-verify-1"])
        self.assertEqual(held["waiting_request_admission"], 3)
        self.assertEqual([case.successors(dead) for dead in judges], [[], [], []])
        self.assertFalse(any(case.record_path(dead).exists() for dead in judges))
        caught_up = _ledgers(5, pending_age=timedelta(hours=1), drained=40, drained_age=timedelta(hours=2))
        with self.queue(caught_up):
            case.sweep(cycle_id="cyc-2")
        self.assertEqual(sum(len(case.successors(dead)) for dead in judges), 3)

class APanelOverACriticalDeathOpensCritical(_Store):
    """Re-review of #1833 (MEDIUM-C): the panel inherits the dead request's class."""

    def test_a_gate_b_death_opens_its_panel_over_budget_and_a_fanout_death_waits(self) -> None:
        from aria_kernel import human_required_adjudication as hra

        gate_b = _mint_judge(self.tools, admit_request("review_runner.post_implementation", "adversarial_judgment",
                                                       base_dir=self.tools), role="adversarial_judgment")
        fanout = _mint_judge(self.tools, admit_request("operator_cli.request", "evidence_judgment",
                                                       base_dir=self.tools))
        record = {"context": {"kind": "lease_lifecycle"}}
        with self.queue(_ledgers(50, pending_age=timedelta(hours=1), drained=7, drained_age=timedelta(hours=2))):
            panel = hra.open_adjudication(escalation_request_id=gate_b["request_id"], record=record,
                                          base_dir=self.tools, cycle_id="cyc-1")
            # The operator's CLI mint is critical too; a pre-door row is not.
            self.assertEqual(hra._panel_producer(self.tools, fanout["request_id"]), "human_required_panel.open_critical")
            self.assertEqual(hra._panel_producer(self.tools, "AIR-pre-door"), "human_required_panel.open")
            with self.assertRaisesRegex(RequestAdmissionThrottled, "backlog_at_drain_budget"):
                hra.open_adjudication(escalation_request_id="AIR-pre-door", record=record,
                                      base_dir=self.tools, cycle_id="cyc-1")
        self.assertEqual(len(panel["request_ids"]), 3)

class TheDoorsCacheStaysSmall(_Store):
    """Re-review of #1833 (minor): critical calls read nothing; uncycled keys are not cached."""

    def test_a_critical_call_reads_no_ledger_and_an_uncycled_call_is_not_kept(self) -> None:
        from aria_kernel import request_admission

        with patch("aria_kernel.ledger.load_declared_jsonl", side_effect=AssertionError("read")):
            self.assertTrue(self.admit("convergence_drainer.plan_step", "cross_review").admitted)
        before = set(request_admission._VIEWS)
        with self.queue(_ledgers(1, pending_age=timedelta(hours=1), drained=7, drained_age=timedelta(hours=2))):
            for _ in range(3):
                admit_request("judge_fanout.sample", "evidence_judgment", base_dir=self.tools)
        self.assertEqual(set(request_admission._VIEWS) - before, set())

if __name__ == "__main__":
    unittest.main()
