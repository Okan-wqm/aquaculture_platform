"""A closed decision must be re-openable, and re-opening must be provable.

Every convergence gate in this kernel judges a plan on its way in. Once it
reaches CONVERGED nothing asks again, so two planners with a shared blind spot
produce a decision that is fast, agreed, wrong, and permanent. This suite pins
the phase that asks afterwards.

Three properties carry the weight, and each of them is a failure mode this
programme has actually shipped:

* the sample is DETERMINISTIC — a self-audit whose scope changes between runs
  cannot itself be audited;
* the phase is IDEMPOTENT against the invocation ledger rather than against a
  private "already asked" file — a second source of truth for a fact the first
  one holds is a divergence waiting to happen;
* the minted role is DISPATCHABLE — a `verification` envelope no executor can
  claim would be a writer with no reader, which is the exact defect class the
  E9 change set exists to close.
"""

from __future__ import annotations

import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

from aria_kernel.agent_invocations import list_agent_invocation_requests
from aria_kernel.agent_surface import (
    DISPATCHABLE_ROLES,
    REQUEST_ROLES,
    allowed_targets_for_role,
)
from aria_kernel.tool_registry import ensure_tools_dir
from aria_kernel.decision_questioning import (
    CLOSED_DECISION_STATES,
    QUESTIONING_ROLE,
    already_questioned,
    closed_decisions,
    open_decision_questioning,
    sample_decisions,
)
from aria_kernel.plan_convergence import (
    content_hash,
    evaluate_plan,
    plan_status,
    record_critique,
    request_critics,
    start_plan,
)

REVIEWER = "farm-expert"


class DecisionQuestioningTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name) / "workspace"
        self.root.mkdir()
        self.tools_dir = Path(self.tmp.name) / "aria-tools"
        agents = self.root / ".claude" / "agents"
        agents.mkdir(parents=True)
        (agents / f"{REVIEWER}.md").write_text(
            f"---\nname: {REVIEWER}\ndescription: Farm reviewer.\n---\n\nOwns `apps/farm-service/**`.\n",
            encoding="utf-8",
        )

    def tearDown(self) -> None:
        self.tmp.cleanup()

    # ---------------------------------------------------------------- helpers

    def _plan(self, title: str) -> dict:
        return {
            "schema_version": 1,
            "title": title,
            "summary": "Decision questioning fixture.",
            "key_changes": ["add ledger"],
            "evidence_refs": ["docs/aria/SPEC.md"],
            "validation_commands": [{"cmd": "python3 -m pytest aria-kernel/tests -q"}],
            "affected_surfaces": [{"paths": ["aria-kernel/aria_kernel/decision_questioning.py"]}],
        }

    def _converge(self, plan_id: str) -> None:
        """Drive one plan through the real gate to CONVERGED.

        Deliberately not a hand-written ledger row: a fixture that fabricates
        the terminal state would keep passing after the reducer stopped
        producing it, and the phase would be pinned against a decision shape
        the pipeline no longer makes.
        """
        start_plan(
            plan_id=plan_id,
            initial_revision_id="rev-0",
            plan_content=self._plan(f"Plan {plan_id}"),
            base_dir=self.tools_dir,
        )
        state = plan_status(plan_id=plan_id, base_dir=self.tools_dir)
        latest = state["latest_revision"]
        request_critics(
            plan_id=plan_id,
            request={
                "round_number": 1,
                "target_revision_id": latest["revision_id"],
                "target_plan_content_hash": latest["content_hash"],
                "tasks": [
                    {
                        "task_id": f"task-{plan_id}",
                        "task_packet_hash": content_hash(
                            {"task_id": f"task-{plan_id}", "reviewer": REVIEWER}
                        ),
                        "target_agent": REVIEWER,
                        "target_revision_id": latest["revision_id"],
                        "target_plan_content_hash": latest["content_hash"],
                        "sla_deadline": (
                            datetime.now(timezone.utc) + timedelta(minutes=60)
                        ).isoformat().replace("+00:00", "Z"),
                    }
                ],
            },
            base_dir=self.tools_dir,
        )
        current = plan_status(plan_id=plan_id, base_dir=self.tools_dir)
        task = next(iter(current["rounds"][1]["tasks"].values()))
        record_critique(
            plan_id=plan_id,
            critique={
                "task_packet_hash": task["task_packet_hash"],
                "target_revision_id": task["target_revision_id"],
                "target_plan_content_hash": task["target_plan_content_hash"],
                "reviewer": REVIEWER,
                "risks": [],
                "critique_content_hash": content_hash({"reviewer": REVIEWER, "risks": []}),
            },
            workspace_root=self.root,
            base_dir=self.tools_dir,
        )
        evaluate_plan(plan_id=plan_id, round_number=1, base_dir=self.tools_dir)
        self.assertIn(
            plan_status(plan_id=plan_id, base_dir=self.tools_dir)["state"],
            CLOSED_DECISION_STATES,
        )

    # ------------------------------------------------------------------ tests

    def test_the_role_this_phase_mints_can_actually_be_claimed(self) -> None:
        # THE POINT OF THE WHOLE CHANGE. `verification` sat in REQUEST_ROLES
        # for a long time with no minter; adding a minter without adding the
        # dispatch pairing would replace a dead role with an unclaimable
        # envelope — the same defect wearing the opposite mask.
        self.assertIn(QUESTIONING_ROLE, REQUEST_ROLES)
        self.assertIn(QUESTIONING_ROLE, DISPATCHABLE_ROLES)
        self.assertEqual(allowed_targets_for_role(QUESTIONING_ROLE), ("aria-adversarial-judge",))

    def test_an_empty_ledger_questions_nothing_and_does_not_raise(self) -> None:
        # A phase that raises on an early cycle is a phase every caller
        # special-cases, and special cases are where phases get skipped.
        result = open_decision_questioning(base_dir=self.tools_dir)
        self.assertEqual(result["questioned"], [])
        self.assertEqual(result["request_ids"], [])

    def test_only_decisions_the_pipeline_acted_on_are_questioned(self) -> None:
        # An in-flight plan is still being judged by the gates that own it.
        start_plan(
            plan_id="plan-open",
            initial_revision_id="rev-0",
            plan_content=self._plan("Plan open"),
            base_dir=self.tools_dir,
        )
        self._converge("plan-closed")
        self.assertEqual(
            [row["plan_id"] for row in closed_decisions(base_dir=self.tools_dir)],
            ["plan-closed"],
        )

    def test_a_questioned_decision_gets_a_verification_envelope(self) -> None:
        self._converge("plan-closed")
        result = open_decision_questioning(base_dir=self.tools_dir)
        self.assertEqual(result["questioned"], ["plan-closed"])
        requests = list_agent_invocation_requests(
            base_dir=self.tools_dir, convergence_id="plan-closed", role=QUESTIONING_ROLE
        )
        self.assertEqual(len(requests), 1)
        self.assertEqual(requests[0]["target_agent"], "aria-adversarial-judge")
        prompt = requests[0]["suggested_prompt"]
        # The prompt must refuse the cheap answer. An adversary told only to
        # "review" re-runs the convergence gate that already passed.
        self.assertIn("shared blind spot", prompt)
        self.assertIn("insufficient_evidence", prompt)

    def test_the_same_decision_is_never_questioned_twice(self) -> None:
        self._converge("plan-closed")
        first = open_decision_questioning(base_dir=self.tools_dir)
        second = open_decision_questioning(base_dir=self.tools_dir)
        self.assertEqual(first["questioned"], ["plan-closed"])
        self.assertEqual(second["questioned"], [])
        self.assertTrue(already_questioned("plan-closed", base_dir=self.tools_dir))
        self.assertEqual(
            len(
                list_agent_invocation_requests(
                    base_dir=self.tools_dir, convergence_id="plan-closed", role=QUESTIONING_ROLE
                )
            ),
            1,
        )

    def test_the_sample_is_deterministic_and_bounded(self) -> None:
        decisions = [
            {"plan_id": "a", "state": "CONVERGED", "decided_at": "2026-08-01T00:00:00Z"},
            {"plan_id": "b", "state": "CONVERGED", "decided_at": "2026-08-02T00:00:00Z"},
            {"plan_id": "c", "state": "CONVERGED", "decided_at": "2026-08-03T00:00:00Z"},
        ]
        self.assertEqual(
            [row["plan_id"] for row in sample_decisions(decisions, sample_size=2)], ["b", "c"]
        )
        self.assertEqual(
            sample_decisions(decisions, sample_size=2), sample_decisions(decisions, sample_size=2)
        )
        self.assertEqual(sample_decisions(decisions, sample_size=0), [])

    def test_sample_size_bounds_how_much_judge_budget_one_cycle_can_spend(self) -> None:
        # Unbounded self-questioning is how a meta-layer eats the cycle it
        # was supposed to improve.
        for plan_id in ("plan-1", "plan-2", "plan-3"):
            self._converge(plan_id)
        result = open_decision_questioning(base_dir=self.tools_dir, sample_size=1)
        self.assertEqual(len(result["questioned"]), 1)
        self.assertEqual(result["unquestioned_decisions_seen"], 3)


class DecisionQuestioningIsACyclePhaseTest(unittest.TestCase):
    """The minter must be REACHED, not merely written.

    E9's own invariant hunts mechanisms with no production caller. A
    self-questioning organ that only tests ever call would be that defect
    wearing the fix's name, so the roster membership is pinned here: delete
    the phase and this test says so.
    """

    def _phase(self):
        from aria_kernel.cycle import CYCLE_PHASES

        matches = [phase for phase in CYCLE_PHASES if phase.name == "decision_questioning"]
        self.assertEqual(len(matches), 1, "decision_questioning must appear exactly once")
        return matches[0]

    def test_the_minter_is_registered_as_a_cycle_phase(self) -> None:
        from aria_kernel.cycle import WRITES_PERMITTED

        phase = self._phase()
        self.assertEqual(phase.stage, "post_tool")
        # Minting a request is an action: it must not run in the burn-in lane,
        # whose whole claim is that it took none.
        self.assertEqual(phase.modes, frozenset({"standard"}))
        self.assertIs(phase.precondition, WRITES_PERMITTED)
        # A crash here asked no question; it must not fail the night.
        self.assertEqual(phase.on_error, "record_and_continue")

    def test_the_phase_runner_calls_the_real_minter(self) -> None:
        from datetime import datetime as _datetime

        from aria_kernel.cycle import PhaseContext
        from aria_kernel.workspace import workspace_paths

        phase = self._phase()
        with tempfile.TemporaryDirectory() as workspace:
            repo_root = Path(workspace)
            tools_dir = ensure_tools_dir(str(repo_root / "tools"))
            context = PhaseContext(
                cycle_id="cycle-decision-questioning",
                workspace_root=repo_root,
                base_dir=tools_dir,
                workspace=workspace_paths(repo_root, repo_root / "workspace"),
                plan_id=None,
                shadow_only=False,
                defer_reflection=False,
                snapshot_mode="none",
                profile="observe",
                cycle_started_at=_datetime.now(timezone.utc),
                started_monotonic=0.0,
                results={},
                outcomes={},
            )
            result = phase.runner(context)
        # No closed decisions in a fresh tree: the contract is a summary,
        # not an exception — a phase that raises on an empty ledger is a
        # phase every early cycle has to special-case.
        self.assertEqual(result["$schema"], "aria/decision-questioning/v1")
        self.assertEqual(result["questioned"], [])


if __name__ == "__main__":
    unittest.main()
