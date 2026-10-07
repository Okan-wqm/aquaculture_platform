"""ARIA-HIGH-368 — the executor advances a plan the moment a step's answer lands.

Measured: a plan round took ~18 h, because every convergence step (challenger,
cross review, critique, convergence, implementation request) was minted by a
CYCLE and claimed by the NEXT executor run. These tests pin the in-run advance:

* one executor run, with a scripted agent answering each envelope it claims,
  takes a plan from its accepted challenger through the cross review to
  CONVERGED and mints the implementation request — and claims that too;
* a second advance on an unchanged state mints nothing (no double mint);
* nothing advances without the aria/state writer lease, past the job
  deadline, or beyond the per-run cap;
* the executor never starts a plan it has no seed for.
"""
from __future__ import annotations

import contextlib
import io
import json
import os
import subprocess
import sys
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest import mock

from aria_kernel import convergence_drainer as cd
from aria_kernel import executor_convergence as ec
from aria_kernel.ledger import load_segments
from aria_kernel.plan_convergence import (
    content_hash,
    plan_status,
    record_cross_review,
    request_cross_review,
    submit_challenger_plan,
)

_REPO_ROOT = Path(__file__).resolve().parents[2]
_POC_DIR = _REPO_ROOT / "tools" / "aria-poc"
if str(_POC_DIR) not in sys.path:
    sys.path.insert(0, str(_POC_DIR))

_REAL_RUN = subprocess.run
_LEASE = {ec.WRITER_LEASE_ENV: ec.WRITER_LEASE_HELD}


class _PlanCase(unittest.TestCase):
    """A store with one plan whose round-1 challenger the cycle minted."""

    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory(prefix="aria-event-planning-")
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name) / "workspace"
        agents = self.root / ".claude" / "agents"
        agents.mkdir(parents=True)
        for name, owns in (("farm-expert", "apps/farm-service/**"), ("access-boundary-auditor", "web/**")):
            (agents / f"{name}.md").write_text(
                f"---\nname: {name}\ndescription: r\n---\n\nOwns `{owns}`.\n", encoding="utf-8",
            )
        self.tools = Path(self.tmp.name) / "aria-tools"
        cd.run_convergence_drainer(
            cycle_id="cyc-1", base_dir=self.tools, workspace_root=self.root, plan_id="plan-1",
            plan_seed=self.plan(), max_rounds=cd.AUTONOMY_CYCLE_MAX_ROUNDS,
        )

    @staticmethod
    def plan() -> dict:
        return {
            "schema_version": 1,
            "title": "T",
            "summary": "S",
            # A surface the implementer may write (a kernel path is readonly,
            # and the implementation envelope refuses an empty scope).
            "affected_surfaces": [{"paths": ["apps/farm-service/src/farm/farm.service.ts"]}],
            "key_changes": ["x"],
            "validation_commands": [{"cmd": "nx affected --target=test"}],
            "evidence_refs": ["docs/aria/SPEC.md"],
            "architectural_tier": 2,
        }

    def requests(self, role: str | None = None) -> list[dict]:
        rows = load_segments(self.tools, "agent_invocation_requests")
        return [row for row in rows if role is None or row.get("role") == role]

    def state(self) -> str:
        return plan_status(plan_id="plan-1", base_dir=self.tools)["state"]

    # -- the scripted agent: each role's answer, folded through the kernel --

    def answer_challenger(self) -> None:
        state = plan_status(plan_id="plan-1", base_dir=self.tools)
        challenger = self.plan()
        challenger["title"] = "Challenger Plan"
        submit_challenger_plan(
            plan_id="plan-1",
            challenger={
                "challenger_agent": "access-boundary-auditor",
                "challenger_revision_id": "challenger-rev-0",
                "source_revision_id": state["latest_revision"]["revision_id"],
                "source_plan_content_hash": state["latest_revision"]["content_hash"],
                "plan_content": challenger,
            },
            base_dir=self.tools,
        )

    def answer_cross_review(self) -> None:
        latest = plan_status(plan_id="plan-1", base_dir=self.tools)["latest_revision"]
        reviewers = (("task-p2c-1", "farm-expert", "primary_to_challenger"),
                     ("task-c2p-1", "access-boundary-auditor", "challenger_to_primary"))
        deadline = (datetime.now(timezone.utc) + timedelta(minutes=30)).isoformat()
        request_cross_review(
            plan_id="plan-1",
            request={
                "round_number": 1,
                "target_revision_id": latest["revision_id"],
                "target_plan_content_hash": latest["content_hash"],
                "tasks": [{
                    "task_id": task_id, "reviewer_agent": reviewer, "review_direction": direction,
                    "target_revision_id": latest["revision_id"],
                    "target_plan_content_hash": latest["content_hash"],
                    "task_packet_hash": content_hash({"t": task_id}), "sla_deadline": deadline,
                } for task_id, reviewer, direction in reviewers],
            },
            base_dir=self.tools,
        )
        for task_id, reviewer, direction in reviewers:
            state = plan_status(plan_id="plan-1", base_dir=self.tools)
            task = next(t for t in state["cross_reviews"][state["current_round"]]["tasks"].values()
                        if t["task_id"] == task_id)
            record_cross_review(
                plan_id="plan-1",
                review={
                    "task_packet_hash": task["task_packet_hash"],
                    "target_revision_id": task["target_revision_id"],
                    "target_plan_content_hash": task["target_plan_content_hash"],
                    "reviewer_agent": reviewer, "review_direction": direction, "risks": [],
                    "review_content_hash": content_hash({"r": reviewer}),
                },
                workspace_root=self.root,
                base_dir=self.tools,
            )

    def advance(self, request: dict, *, budget: ec.AdvanceBudget | None = None, environ=None, now=None) -> dict:
        return ec.advance_after_accepted_step(
            request=request, tools_dir=self.tools, workspace_root=self.root, run_id="run-1",
            budget=budget or ec.AdvanceBudget(), drain_remaining=None,
            environ=_LEASE if environ is None else environ,
            **({"now": now} if now is not None else {}),
        )


class AdvanceGates(_PlanCase):
    def setUp(self) -> None:
        super().setUp()
        self.answer_challenger()
        self.challenger = self.requests("challenger_plan")[0]
        self.assertEqual(self.state(), "CHALLENGER_DRAFTED")

    def test_an_accepted_challenger_mints_the_cross_review_in_the_same_run(self) -> None:
        outcome = self.advance(self.challenger)
        self.assertEqual(outcome["status"], "advanced")
        self.assertEqual(outcome["verdict"], "in_progress")
        self.assertEqual(len(self.requests("cross_review")), 1)
        self.assertEqual(outcome["minted_request_ids"], [self.requests("cross_review")[0]["request_id"]])

    def test_a_second_advance_on_the_same_state_mints_nothing(self) -> None:
        budget = ec.AdvanceBudget()
        first = self.advance(self.challenger, budget=budget)
        self.assertEqual(len(first["minted_request_ids"]), 1)
        before = self.requests()
        second = self.advance(self.challenger, budget=budget)
        self.assertEqual(second["status"], "advanced")
        self.assertEqual(self.requests(), before, "a live cross_review envelope was minted twice")
        self.assertEqual(second["minted_request_ids"], [])

    def test_without_the_writer_lease_nothing_advances(self) -> None:
        for environ in ({}, {ec.WRITER_LEASE_ENV: "yielded"}, {ec.WRITER_LEASE_ENV: ""}):
            outcome = self.advance(self.challenger, environ=environ)
            self.assertEqual((outcome["status"], outcome["reason"]), ("skipped", ec.SKIP_LEASE_NOT_HELD))
        self.assertEqual(self.requests("cross_review"), [])

    def test_past_the_job_deadline_nothing_advances(self) -> None:
        environ = {**_LEASE, ec.JOB_DEADLINE_ENV: "1000"}
        outcome = self.advance(self.challenger, environ=environ, now=lambda: 1000.0)
        self.assertEqual((outcome["status"], outcome["reason"]), ("skipped", ec.SKIP_JOB_DEADLINE))
        self.assertEqual(self.requests("cross_review"), [])

    def test_the_per_run_cap_stops_the_advance(self) -> None:
        budget = ec.AdvanceBudget(advances=ec.MAX_CONVERGENCE_ADVANCES_PER_RUN)
        outcome = self.advance(self.challenger, budget=budget)
        self.assertEqual((outcome["status"], outcome["reason"]), ("skipped", ec.SKIP_ADVANCE_CAP))
        self.assertEqual(self.requests("cross_review"), [])
        # The cap is a whole debate at the cycle's round cap, never less.
        self.assertEqual(ec.MAX_CONVERGENCE_ADVANCES_PER_RUN, cd.AUTONOMY_CYCLE_MAX_ROUNDS * ec.ADVANCES_PER_ROUND)

    def test_an_unknown_plan_is_never_started(self) -> None:
        stray = {**self.challenger, "convergence_id": "plan-unknown"}
        outcome = self.advance(stray)
        self.assertEqual((outcome["status"], outcome["reason"]), ("skipped", ec.SKIP_PLAN_NOT_CONVERGING))
        self.assertEqual(plan_status(plan_id="plan-unknown", base_dir=self.tools).get("state"), None)

    def test_judge_and_implementation_answers_do_not_advance(self) -> None:
        for role in ("evidence_judgment", "implementation"):
            outcome = self.advance({**self.challenger, "role": role})
            self.assertEqual((outcome["status"], outcome["reason"]), ("skipped", ec.SKIP_NOT_PLANNING_STEP))


class ConvergedSeam(_PlanCase):
    """What the executor does with a plan its advance converged."""

    def setUp(self) -> None:
        super().setUp()
        self.answer_challenger()
        self.advance(self.requests("challenger_plan")[0])
        self.answer_cross_review()
        seen: list[dict] = []
        with mock.patch("aria_kernel.round_independence.verify_independence", return_value=(True, [])):
            outcome = ec.advance_after_accepted_step(
                request=self.requests("cross_review")[0], tools_dir=self.tools, workspace_root=self.root,
                run_id="run-1", budget=ec.AdvanceBudget(), drain_remaining=None, environ=_LEASE,
                converged_seam=lambda **kwargs: seen.append(kwargs) or {"captured": True},
            )
        self.assertEqual((outcome["verdict"], self.state()), ("converged", "CONVERGED"))
        self.assertEqual(len(seen), 1)
        self.seam_kwargs = seen[0]

    def test_a_store_fault_inside_the_seam_ends_the_seam_not_the_drain(self) -> None:
        from aria_kernel.tool_registry import GovernanceError

        # A fresh store at the same CROSS_REVIEWED point, so the advance
        # converges again with a seam that faults.
        self.setUp_reviewed_again()

        def faulting_seam(**_kwargs):
            raise GovernanceError("converged_plan_body_unverifiable")

        with mock.patch("aria_kernel.round_independence.verify_independence", return_value=(True, [])):
            outcome = ec.advance_after_accepted_step(
                request=self.requests("cross_review")[0], tools_dir=self.tools, workspace_root=self.root,
                run_id="run-2-1", budget=ec.AdvanceBudget(), drain_remaining=None, environ=_LEASE,
                converged_seam=faulting_seam,
            )
        self.assertEqual(outcome["status"], "advanced")
        self.assertEqual(outcome["converged_seam"]["status"], ec.SEAM_FAILED)
        self.assertEqual(outcome["converged_seam"]["error_class"], "GovernanceError")
        self.assertEqual(outcome["reported"]["resolved"], "converged")

    def setUp_reviewed_again(self) -> None:
        self.tmp.cleanup()
        _PlanCase.setUp(self)
        self.answer_challenger()
        self.advance(self.requests("challenger_plan")[0])
        self.answer_cross_review()

    def seam(self, **overrides) -> dict:
        from aria_kernel.cycle_phases.memory import NoOpMemoryHook
        from aria_kernel.executor_converged_seam import run_executor_converged_seam

        kwargs = {**self.seam_kwargs, "memory_hook": NoOpMemoryHook(), **overrides}
        with mock.patch("aria_kernel.cycle_phases.knowledge_signer.knowledge_record_permitted", return_value=False):
            return run_executor_converged_seam(**kwargs)

    def governance_kinds(self) -> list[str]:
        path = self.tools / "governance.jsonl"
        return [json.loads(line).get("kind") for line in path.read_text(encoding="utf-8").splitlines()]

    def test_a_runner_without_authority_leaves_the_plan_to_the_cycle_sweep_uncounted(self) -> None:
        from aria_kernel.converged_delivery import UNCOUNTED_GOVERNANCE_KIND
        from aria_kernel.cycle_phases.implementer import NoOpV9ImplementationRunner
        from aria_kernel.executor_converged_seam import LEFT_NO_AUTHORITY

        report = self.seam(runner=NoOpV9ImplementationRunner())
        self.assertEqual(report["delivery"], {"left_for_cycle_sweep": LEFT_NO_AUTHORITY})
        self.assertEqual(self.state(), "CONVERGED")
        self.assertNotIn(UNCOUNTED_GOVERNANCE_KIND, self.governance_kinds())

    def test_staging_that_does_not_fit_the_window_is_not_started(self) -> None:
        from aria_kernel.executor_converged_seam import LEFT_WINDOW, staging_worst_case_seconds

        runner = mock.Mock(delivers_implementation=True)
        worst = staging_worst_case_seconds(plan_id="plan-1", tools_dir=self.tools)
        for remaining in ({"drain_remaining": lambda: worst - 1},
                          {"deadline_epoch": 5000.0 + worst - 1, "now": lambda: 5000.0}):
            report = self.seam(runner=runner, **remaining)
            self.assertEqual(report["delivery"]["left_for_cycle_sweep"], LEFT_WINDOW)
        runner.run.assert_not_called()
        self.assertEqual(self.state(), "CONVERGED")
        attempts = plan_status(plan_id="plan-1", base_dir=self.tools).get("implementation_delivery_attempts")
        self.assertFalse(attempts)

    def test_the_funnel_credits_the_source_the_plan_was_minted_from(self) -> None:
        from aria_kernel.autonomy_state import PLAN_MINTED_PHASE, PLAN_PRESSURE_SOURCE_DETAIL, AutonomyStateReducer
        from aria_kernel.cycle_phases.implementer import NoOpV9ImplementationRunner
        from aria_kernel.executor_converged_seam import FUNNEL_UNATTRIBUTED_KIND, plan_pressure_source

        self.assertIsNone(plan_pressure_source(tools_dir=self.tools, plan_id="plan-1"))
        unattributed = self.seam(runner=NoOpV9ImplementationRunner())
        self.assertEqual(unattributed["funnel"], "unattributed")
        self.assertIn(FUNNEL_UNATTRIBUTED_KIND, self.governance_kinds())
        for cycle_id, source in (("cyc-1", "finding"), ("cyc-2", "git_diff")):
            AutonomyStateReducer.transition(
                self.tools, cycle_id=cycle_id, phase=PLAN_MINTED_PHASE,
                details={"plan_id": "plan-1", PLAN_PRESSURE_SOURCE_DETAIL: source},
            )
        # The FIRST row is the mint; the second is an adoption.
        self.assertEqual(plan_pressure_source(tools_dir=self.tools, plan_id="plan-1"), "finding")
        with mock.patch("aria_kernel.knowledge_graph.record_pressure_source_outcome") as record:
            credited = self.seam(runner=NoOpV9ImplementationRunner())
        self.assertEqual(credited["funnel"], "recorded")
        record.assert_called_once_with(base_dir=self.tools, source_type="finding", converged=1)


class OneRunTakesThePlanToItsImplementationRequest(_PlanCase):
    """drain_pending, with the kernel queue answered for real and a scripted
    agent folding each claimed request into plan state."""

    def _fake_run(self, argv, **kwargs):
        argv = list(argv)
        if "next-pending" in argv:
            from aria_kernel.agent_invocations import next_pending_request

            def flag(name):
                return next((argv[i + 1] for i, tok in enumerate(argv) if tok == name), None)

            row = next_pending_request(
                role=flag("--role"), target_agent=flag("--target-agent"), base_dir=self.tools,
                exclude_request_ids={argv[i + 1] for i, tok in enumerate(argv) if tok == "--exclude"} or None,
            )
            return subprocess.CompletedProcess(argv, 0, stdout=json.dumps(row), stderr="")
        if len(argv) > 1 and str(argv[1]).endswith("ci_executor.py"):
            request_id = argv[2]
            row = next(r for r in self.requests() if r["request_id"] == request_id)
            self.dispatched.append(row["role"])
            {"challenger_plan": self.answer_challenger, "cross_review": self.answer_cross_review}.get(
                row["role"], lambda: None,
            )()
            summary = Path(kwargs["env"]["RUNNER_TEMP"]) / f"dispatch-result-{request_id}.json"
            summary.write_text(json.dumps({
                "$schema": "aria/dispatch-result/v1", "schema_version": 1, "request_id": request_id,
                "role": row["role"], "target_agent": row["target_agent"], "provider": "anthropic",
                "model": "opus", "outcome": "succeeded", "failure_class": None, "retryable": False,
                "failure_detail_code": None, "exit_code": 0,
            }), encoding="utf-8")
            Path(kwargs["env"]["GITHUB_OUTPUT"]).write_text(f"dispatch_summary_path={summary}\n", encoding="utf-8")
            return subprocess.CompletedProcess(argv, 0, stdout="", stderr="")
        return _REAL_RUN(argv, **kwargs)

    def drain(self, *, lease: bool) -> int:
        import ci_executor_drain
        from dispatch_failure import DispatchRoute
        from aria_kernel.cycle_phases.memory import NoOpMemoryHook
        from tests._helpers.operator_acts import operator_set_profile

        # The authority the cycle runs under (the persisted profile): strict
        # holds `pr_create`, so the converged plan is offered here.
        operator_set_profile("strict", base_dir=self.tools, scheduler_ceiling="strict")
        self.dispatched: list[str] = []
        staged = {"proposal_id": "prop-1", "change_id": "chg-1", "branch": "aria/plan-1-x",
                  "baseline_ref": "base-1", "base_sha": "0" * 40}
        output = Path(self.tmp.name) / "github-output.txt"
        output.write_text("", encoding="utf-8")
        env = {"GITHUB_OUTPUT": str(output), "RUNNER_TEMP": self.tmp.name, "MAX_REQUESTS_PER_RUN": "30",
               "ARIA_DRAIN_BUDGET_SECONDS": "1000000",
               # The job's run and attempt, pinned: CI sets its own.
               "GITHUB_RUN_ID": "4242", "GITHUB_RUN_ATTEMPT": "2", **(_LEASE if lease else {})}
        policy = {"max_concurrent": 1, "worktree_per_request": False, "surplus_after_planning_turn": 0}
        with contextlib.ExitStack() as stack:
            stack.enter_context(mock.patch.dict(os.environ, env))
            if not lease:
                os.environ.pop(ec.WRITER_LEASE_ENV, None)
            stack.enter_context(mock.patch.object(ci_executor_drain.subprocess, "run", side_effect=self._fake_run))
            stack.enter_context(mock.patch.object(ci_executor_drain, "_executor_policy", return_value=policy))
            stack.enter_context(mock.patch.object(ci_executor_drain, "_judge_batch_policy", return_value=(1, ())))
            stack.enter_context(mock.patch.object(
                ci_executor_drain._dispatch_failure, "resolve_dispatch_route",
                side_effect=lambda *, request, repo_root: DispatchRoute(
                    provider="anthropic", model="opus", role=str(request.get("role") or ""),
                    target_agent=str(request.get("target_agent") or "")),
            ))
            # The kernel-native folds above carry no claim trail, so the
            # independence gate (tested on its own) is answered here.
            stack.enter_context(mock.patch("aria_kernel.round_independence.verify_independence", return_value=(True, [])))
            # Staging runs the plan's baseline suite; its ids are what the
            # implementation envelope carries.
            stack.enter_context(mock.patch("aria_kernel.apply_engine.stage_converged_plan_for_pr",
                                           return_value=staged))
            stack.enter_context(mock.patch("aria_kernel.cycle_phases.select_memory_hook",
                                           return_value=NoOpMemoryHook()))
            stack.enter_context(mock.patch("aria_kernel.cycle_phases.knowledge_signer.knowledge_record_permitted",
                                           return_value=False))
            stack.enter_context(contextlib.redirect_stdout(io.StringIO()))
            stack.enter_context(contextlib.redirect_stderr(io.StringIO()))
            return ci_executor_drain.drain_pending(tools_dir=self.tools, repo_root=self.root)

    def test_one_run_converges_the_plan_and_claims_its_implementation_request(self) -> None:
        self.drain(lease=True)
        self.assertEqual(self.dispatched, ["challenger_plan", "cross_review", "implementation"])
        self.assertEqual(self.state(), "IMPLEMENTATION_REQUESTED")
        self.assertEqual(len(self.requests("cross_review")), 1)
        self.assertEqual(len(self.requests("implementation")), 1)
        governance = (self.tools / "governance.jsonl").read_text(encoding="utf-8")
        self.assertIn(ec.ADVANCE_GOVERNANCE_KIND, governance)
        self.assertIn("converged_in_executor_run", governance)
        # The cycle never sees this plan again: the executor wrote its outcome
        # row, under the job attempt's id.
        from aria_kernel.autonomy_state import autonomy_state_path
        from aria_kernel.ledger import load_jsonl

        resolved = [row for row in load_jsonl(autonomy_state_path(self.tools))
                    if row.get("phase") == "convergence_resolved"]
        self.assertEqual([(row["status"], row["cycle_id"], row["details"]["origin"]) for row in resolved],
                         [("converged", "executor-4242-2", "executor")])

    def test_without_the_lease_the_run_leaves_the_next_step_to_the_cycle(self) -> None:
        self.drain(lease=False)
        self.assertEqual(self.dispatched, ["challenger_plan"])
        self.assertEqual(self.state(), "CHALLENGER_DRAFTED")
        self.assertEqual(self.requests("cross_review"), [])


if __name__ == "__main__":
    unittest.main()
