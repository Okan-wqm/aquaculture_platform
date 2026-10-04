"""Plan progress before backlog — the drain's planning-turn stop.

WHY this file exists: the first live end-to-end run (2026-10-04, executor
run 37192561282) drained the one planning-lane request its cycle minted —
the F-007 challenger, accepted at 10:03Z — and then kept draining old
evidence_judgment rows from a ~1,600-row backlog at ~6 minutes each, up to
MAX_REQUESTS_PER_RUN=30 inside a 21,000 s window. The executor, the
auto-cycle and the burn-in share one self-hosted runner and one
concurrency group, so the plan's next turn (cycle → cross_review → cycle →
CONVERGED → implementation) waited hours behind work that advances no
plan. These tests pin the rule that ends that:

* a run that has SUCCEEDED on a planning-lane request, with no
  planning-lane request still pending, finishes its quota round and stops
  by name (`planning_turn_complete`) — `drained` stays > 0 so the rhythm
  job can chain the next cycle;
* the quota round still gives every waiting role its one slot
  (ORPHAN-705 Y4, ORPHAN-HIGH-786 — judges are not starved);
* a planning-lane request that becomes pending mid-run is still taken
  before the run stops;
* the surplus a planning turn may spend on the backlog is the validated
  policy field `executor.surplus_after_planning_turn` (default 0);
* a run that drains no planning-lane request is the backlog night it
  always was.
"""
from __future__ import annotations

import contextlib
import io
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

_REPO_ROOT = Path(__file__).resolve().parents[2]
_POC_DIR = _REPO_ROOT / "tools" / "aria-poc"
if str(_POC_DIR) not in sys.path:
    sys.path.insert(0, str(_POC_DIR))

import ci_executor_drain  # noqa: E402
from dispatch_failure import DispatchRoute  # noqa: E402

from aria_kernel.agent_surface import JUDGE_ROLES, PLANNER_BRIDGE_ROLES  # noqa: E402
from aria_kernel.cross_review_bridge import COMPLETENESS_CRITIC_ROLE  # noqa: E402
from aria_kernel.genesis_policy import EXECUTOR_DEFAULTS, executor_policy  # noqa: E402
from aria_kernel.tool_registry import GovernanceError  # noqa: E402

_TARGET_BY_ROLE = {
    "implementation": "aria-implementer",
    "cross_review": "aria-cross-reviewer",
    "challenger_plan": "aria-challenger-planner",
    "primary_plan": "aria-primary-planner",
    "completeness_critique": "aria-completeness-critic",
    "evidence_judgment": "aria-evidence-judge",
    "adversarial_judgment": "aria-adversarial-judge",
    "consensus_arbitration": "aria-consensus-arbiter",
    "human_required_adjudication": "aria-consensus-arbiter",
    "verification": "aria-adversarial-judge",
    "change_intelligence": "aria-change-intelligence",
    "goldset_curation": "aria-goldset-curator",
    "specialist_domain_review": "architectural-arbiter",
    "maintenance_utility": "aria-autonomy-planner",
}


class _FakeProc:
    def __init__(self, returncode: int = 0, stdout: str = "", stderr: str = ""):
        self.returncode = returncode
        self.stdout = stdout
        self.stderr = stderr


def _row(request_id: str, role: str) -> dict:
    return {"request_id": request_id, "role": role, "target_agent": _TARGET_BY_ROLE[role], "target_sha": "abc"}


class _Drain:
    """One scripted drain: a kernel queue answered by exclusion (the real
    next-pending contract — attempted ids come back as ``--exclude``), and
    children that publish a ``succeeded`` v1 summary carrying their row's
    role. ``inject`` maps a request id to rows that become pending while
    that request's child runs."""

    def __init__(self, tmp: str, queue: list[dict], *, surplus: int = 0,
                 inject: dict[str, list[dict]] | None = None, env: dict[str, str] | None = None) -> None:
        self.tmp = Path(tmp)
        self.queue = list(queue)
        self.surplus = surplus
        self.inject = dict(inject or {})
        self.env = {"MAX_REQUESTS_PER_RUN": "30", **(env or {})}
        self.dispatched: list[str] = []
        self.governance: list[tuple[str, dict]] = []
        self.stderr = ""
        self.stdout = ""
        self.output = ""
        self.rc: int | None = None

    def _fake_run(self, argv, **kwargs):
        if "next-pending" in argv:
            excluded = {argv[i + 1] for i, tok in enumerate(argv) if tok == "--exclude"}
            role = next((argv[i + 1] for i, tok in enumerate(argv) if tok == "--role"), None)
            agent = next((argv[i + 1] for i, tok in enumerate(argv) if tok == "--target-agent"), None)
            row = next(
                (c for c in self.queue
                 if c["request_id"] not in excluded
                 and (role is None or c["role"] == role)
                 and (agent is None or c["target_agent"] == agent)),
                None,
            )
            return _FakeProc(stdout=json.dumps(row) if row else "null")
        request_id = argv[2]
        self.dispatched.append(request_id)
        row = next(c for c in self.queue if c["request_id"] == request_id)
        self.queue.remove(row)
        self.queue.extend(self.inject.pop(request_id, []))
        summary_path = Path(kwargs["env"]["RUNNER_TEMP"]) / f"dispatch-result-{request_id}.json"
        summary_path.write_text(json.dumps({
            "$schema": "aria/dispatch-result/v1", "schema_version": 1, "request_id": request_id,
            "role": row["role"], "target_agent": row["target_agent"], "provider": "anthropic", "model": "opus",
            "outcome": "succeeded", "failure_class": None, "retryable": False,
            "failure_detail_code": None, "exit_code": 0,
        }), encoding="utf-8")
        Path(kwargs["env"]["GITHUB_OUTPUT"]).write_text(f"dispatch_summary_path={summary_path}\n", encoding="utf-8")
        return _FakeProc(returncode=0)

    def run(self) -> "_Drain":
        parent_output = self.tmp / "github-output.txt"
        parent_output.write_text("", encoding="utf-8")
        env_vars = {"GITHUB_OUTPUT": str(parent_output), "RUNNER_TEMP": str(self.tmp), **self.env}
        stderr, stdout = io.StringIO(), io.StringIO()
        policy = {"max_concurrent": 1, "worktree_per_request": False, "surplus_after_planning_turn": self.surplus}
        with patch.dict(os.environ, env_vars), patch.object(
            ci_executor_drain.subprocess, "run", side_effect=self._fake_run,
        ), patch.object(
            ci_executor_drain, "_executor_policy", return_value=policy,
        ), patch.object(
            ci_executor_drain, "_judge_batch_policy", return_value=(1, ()),
        ), patch.object(
            ci_executor_drain._dispatch_failure, "resolve_dispatch_route",
            side_effect=lambda *, request, repo_root: DispatchRoute(
                provider="anthropic", model="opus", role=str(request.get("role") or ""),
                target_agent=str(request.get("target_agent") or "")),
        ), patch.object(
            ci_executor_drain._engine, "_append_tools_governance",
            side_effect=lambda _root, kind, payload: self.governance.append((kind, payload)),
        ), contextlib.redirect_stderr(stderr), contextlib.redirect_stdout(stdout):
            self.rc = ci_executor_drain.drain_pending(tools_dir=self.tmp / "aria-tools", repo_root=_REPO_ROOT)
        self.stderr, self.stdout = stderr.getvalue(), stdout.getvalue()
        self.output = parent_output.read_text(encoding="utf-8")
        return self

    @property
    def completed(self) -> dict:
        return next(payload for kind, payload in self.governance if kind == "executor_drain_completed")


def _judge_backlog(count: int) -> list[dict]:
    return [_row(f"EJ-{i:04d}", "evidence_judgment") for i in range(count)]


class PlanningLaneRolesArePinned(unittest.TestCase):
    def test_the_planning_lane_is_derived_from_the_kernel_constants(self) -> None:
        # The roles that move a plan: the four bridge roles a submit routes
        # through plan state (agent_surface.PLANNER_BRIDGE_ROLES) and the
        # coverage-waiver critic the convergence drainer waits on
        # (cross_review_bridge.COMPLETENESS_CRITIC_ROLE) — never a typed list.
        self.assertEqual(
            ci_executor_drain._PLANNING_LANE_ROLES,
            frozenset(PLANNER_BRIDGE_ROLES) | {COMPLETENESS_CRITIC_ROLE[1]},
        )
        self.assertEqual(
            ci_executor_drain._PLANNING_LANE_ROLES,
            frozenset({"implementation", "cross_review", "challenger_plan", "primary_plan",
                       "completeness_critique"}),
        )
        # Every planning-lane role has its quota slot in the arc, and no
        # judge role is mistaken for plan progress.
        self.assertLessEqual(ci_executor_drain._PLANNING_LANE_ROLES, set(ci_executor_drain._ROLE_QUOTA_ORDER))
        self.assertFalse(ci_executor_drain._PLANNING_LANE_ROLES & set(JUDGE_ROLES))
        self.assertEqual(ci_executor_drain.PLANNING_TURN_COMPLETE_STOP_REASON, "planning_turn_complete")


class PlanningTurnStop(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory(prefix="aria-drain-plan-first-")
        self.addCleanup(self._tmp.cleanup)

    def test_a_planning_success_before_a_judge_backlog_stops_after_one_quota_round(self) -> None:
        # The measured night: the plan's one challenger, then a backlog of
        # judges far larger than the run cap.
        queue = [
            *_judge_backlog(60),
            *[_row(f"AJ-{i}", "adversarial_judgment") for i in range(5)],
            _row("CH-1", "challenger_plan"),
            _row("MU-1", "maintenance_utility"),
            _row("MU-2", "maintenance_utility"),
        ]
        drain = _Drain(self._tmp.name, queue).run()
        self.assertEqual(drain.rc, 0)
        self.assertEqual(drain.dispatched, ["CH-1", "EJ-0000", "AJ-0", "MU-1"])
        judges_taken = [rid for rid in drain.dispatched if rid.startswith(("EJ-", "AJ-"))]
        self.assertEqual(len(judges_taken), 2, "one quota slot per waiting judge role, no surplus")
        self.assertEqual(drain.completed["stop_reason"], "planning_turn_complete")
        self.assertIn("stop=planning_turn_complete", drain.stderr)
        self.assertIn("::notice title=ARIA drain stopped::stop=planning_turn_complete", drain.stdout)
        # `drained` stays > 0: the rhythm job's `drain_empty` brake is not
        # what holds the next cycle back.
        self.assertIn("drained=4\n", drain.output)

    def test_a_backlog_only_run_drains_to_the_run_cap_as_before(self) -> None:
        drain = _Drain(self._tmp.name, _judge_backlog(60)).run()
        self.assertEqual(drain.rc, 0)
        self.assertEqual(len(drain.dispatched), 30)
        self.assertEqual(drain.completed["stop_reason"], "max_requests_reached")
        self.assertIn("drained=30\n", drain.output)

    def test_a_backlog_only_run_that_empties_the_queue_stops_as_queue_empty(self) -> None:
        drain = _Drain(self._tmp.name, _judge_backlog(3)).run()
        self.assertEqual(len(drain.dispatched), 3)
        self.assertEqual(drain.completed["stop_reason"], "queue_empty")

    def test_a_planning_request_that_appears_mid_run_is_taken_before_the_stop(self) -> None:
        # The cross_review becomes pending while the last quota child runs:
        # the turn is not complete while a planning-lane request waits.
        queue = [*_judge_backlog(20), _row("CH-1", "challenger_plan"), _row("MU-1", "maintenance_utility")]
        drain = _Drain(self._tmp.name, queue, inject={"MU-1": [_row("CR-1", "cross_review")]}).run()
        self.assertEqual(drain.dispatched, ["CH-1", "EJ-0000", "MU-1", "CR-1"])
        self.assertEqual(drain.completed["stop_reason"], "planning_turn_complete")

    def test_a_backlog_night_that_meets_a_mid_run_planning_request_takes_it_then_stops(self) -> None:
        # No planning work at the start: the night drains the backlog; the
        # moment a planning request appears it is served, and the run stops
        # there instead of resuming the backlog in front of the plan.
        queue = _judge_backlog(40)
        drain = _Drain(self._tmp.name, queue, inject={"EJ-0004": [_row("CR-1", "cross_review")]}).run()
        self.assertEqual(drain.dispatched, ["EJ-0000", "EJ-0001", "EJ-0002", "EJ-0003", "EJ-0004", "CR-1"])
        self.assertEqual(drain.completed["stop_reason"], "planning_turn_complete")

    def test_the_quota_round_still_gives_every_waiting_role_one_slot(self) -> None:
        # ORPHAN-705 Y4 / ORPHAN-HIGH-786 — the stop comes AFTER the round:
        # every waiting role, judges included, gets exactly one slot, and no
        # role gets a second.
        non_planning = [r for r in ci_executor_drain._ROLE_QUOTA_ORDER
                        if r not in ci_executor_drain._PLANNING_LANE_ROLES]
        queue = [_row("CH-1", "challenger_plan")]
        for index, role in enumerate(non_planning):
            queue += [_row(f"R{index:02d}a-{role}", role), _row(f"R{index:02d}b-{role}", role)]
        drain = _Drain(self._tmp.name, queue).run()
        roles_served = [rid.split("-", 1)[1] for rid in drain.dispatched[1:]]
        self.assertEqual(drain.dispatched[0], "CH-1")
        self.assertEqual(roles_served, non_planning)
        self.assertTrue(all("a-" in rid for rid in drain.dispatched[1:]), drain.dispatched)
        self.assertEqual(drain.completed["stop_reason"], "planning_turn_complete")

    def test_every_pending_planning_request_is_served_before_the_stop(self) -> None:
        queue = [*_judge_backlog(10), _row("CH-1", "challenger_plan"), _row("CH-2", "challenger_plan"),
                 _row("CC-1", "completeness_critique")]
        drain = _Drain(self._tmp.name, queue).run()
        self.assertEqual(drain.dispatched, ["CH-1", "EJ-0000", "CC-1", "CH-2"])
        self.assertEqual(drain.completed["stop_reason"], "planning_turn_complete")

    def test_the_policy_surplus_is_spent_in_arc_order_then_the_run_stops(self) -> None:
        queue = [*_judge_backlog(20), _row("CH-1", "challenger_plan"), _row("MU-1", "maintenance_utility"),
                 _row("MU-2", "maintenance_utility")]
        drain = _Drain(self._tmp.name, queue, surplus=3).run()
        self.assertEqual(drain.dispatched, ["CH-1", "EJ-0000", "MU-1", "EJ-0001", "EJ-0002", "EJ-0003"])
        self.assertEqual(drain.completed["stop_reason"], "planning_turn_complete")

    def test_a_surplus_larger_than_the_backlog_ends_as_queue_empty(self) -> None:
        queue = [*_judge_backlog(2), _row("CH-1", "challenger_plan")]
        drain = _Drain(self._tmp.name, queue, surplus=10).run()
        self.assertEqual(drain.dispatched, ["CH-1", "EJ-0000", "EJ-0001"])
        self.assertEqual(drain.completed["stop_reason"], "queue_empty")


class SurplusPolicyFieldIsValidated(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory(prefix="aria-executor-policy-")
        self.addCleanup(self._tmp.cleanup)
        self.root = Path(self._tmp.name)
        (self.root / "aria-config").mkdir()

    def _policy(self, value: object) -> dict:
        (self.root / "aria-config" / "genesis_policy.json").write_text(
            json.dumps({"executor": {"surplus_after_planning_turn": value}}), encoding="utf-8",
        )
        return executor_policy(self.root)

    def test_the_default_is_no_surplus_beyond_the_quota_round(self) -> None:
        self.assertEqual(EXECUTOR_DEFAULTS["surplus_after_planning_turn"], 0)
        self.assertEqual(executor_policy()["surplus_after_planning_turn"], 0)
        self.assertEqual(executor_policy(_REPO_ROOT)["surplus_after_planning_turn"], 0)

    def test_a_non_negative_integer_is_accepted(self) -> None:
        self.assertEqual(self._policy(0)["surplus_after_planning_turn"], 0)
        self.assertEqual(self._policy(5)["surplus_after_planning_turn"], 5)

    def test_a_bad_value_is_refused_by_name(self) -> None:
        for value in (-1, True, "3", 1.5, None, [2]):
            with self.subTest(value=value), self.assertRaises(GovernanceError) as raised:
                self._policy(value)
            self.assertIn("surplus_after_planning_turn", str(raised.exception))


if __name__ == "__main__":
    unittest.main()
