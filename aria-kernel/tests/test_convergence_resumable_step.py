"""CL-1 (ORPHAN-725) — convergence is a resumable step, never a wait.

Production measured the old shape's failure exactly: the cycle lane
polled for states only the LATER executor run could produce — 13/13
challenger poll-timeouts, zero plans ever CONVERGED, and the round-1
re-entry wedged every adopted plan behind `convergence_invalid_plan`.
Deliberate-breakage pins:

* an adopted DRAFT plan is NEVER re-started (K1);
* no step branch ever sleeps (K2 — waiting is structurally impossible);
* the same live envelope is never double-minted (idempotency);
* a cross-cycle sequence of steps reaches CONVERGED with zero polling;
* an undeliverable envelope exhausts its X4-mirror re-mint budget into
  an HONEST terminal HUMAN_REQUIRED instead of orbiting forever.
"""
from __future__ import annotations

import json
import tempfile
import time
import unittest
from pathlib import Path
from unittest import mock

from aria_kernel import convergence_drainer as cd
from aria_kernel.ledger import load_jsonl
from aria_kernel.plan_convergence import (
    content_hash,
    events_path,
    fold_plan_state,
    plan_status,
    record_cross_review,
    request_cross_review,
    start_plan,
    submit_challenger_plan,
)

_MS = [{"id": "MS-1", "kind": "obligation", "description": "do x", "source": "test"}]


class _StepCase(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name) / "workspace"
        agents = self.root / ".claude" / "agents"
        agents.mkdir(parents=True)
        for name, owns in (("farm-expert", "apps/farm-service/**"), ("access-boundary-auditor", "web/**")):
            (agents / f"{name}.md").write_text(
                f"---\nname: {name}\ndescription: r\n---\n\nOwns `{owns}`.\n",
                encoding="utf-8",
            )
        self.tools = Path(self.tmp.name) / "aria-tools"

    def tearDown(self) -> None:
        self.tmp.cleanup()

    @staticmethod
    def plan() -> dict:
        return {
            "schema_version": 1,
            "title": "T",
            "summary": "S",
            "affected_surfaces": [{"paths": ["aria-kernel/aria_kernel/plan_convergence.py"]}],
            "key_changes": ["x"],
            "validation_commands": [
                {"cmd": "python3 -m unittest discover aria-kernel -p '*test*.py'"},
            ],
            "evidence_refs": ["docs/aria/SPEC.md"],
        }

    def step(self) -> dict:
        return cd.run_convergence_drainer(
            cycle_id="cyc-step",
            base_dir=self.tools,
            workspace_root=self.root,
            plan_id="plan-1",
            plan_seed=self.plan(),
            must_satisfy=list(_MS),
            evidence_refs=["docs/aria/SPEC.md"],
            allowed_scope=["aria-kernel/**"],
            max_rounds=4,
        )

    def requests(self) -> list[dict]:
        path = self.tools / "agent-invocations" / "requests.jsonl"
        if not path.exists():
            return []
        return [json.loads(l) for l in path.read_text(encoding="utf-8").splitlines() if l.strip()]


class AdoptedDraftNeverRestarts(_StepCase):
    def test_draft_plan_steps_without_restart(self) -> None:
        start_plan(
            plan_id="plan-1", initial_revision_id="rev-0",
            plan_content=self.plan(), base_dir=self.tools,
        )
        result = self.step()
        self.assertEqual(result["arbiter_verdict"], "in_progress")
        started_events = [
            row for row in load_jsonl(events_path(self.tools))
            if row.get("event_type") == "plan_started"
        ]
        self.assertEqual(len(started_events), 1, "adopted DRAFT was re-started")
        challengers = [r for r in self.requests() if r.get("role") == "challenger_plan"]
        self.assertEqual(len(challengers), 1)

    def test_second_step_does_not_double_mint_a_live_envelope(self) -> None:
        start_plan(
            plan_id="plan-1", initial_revision_id="rev-0",
            plan_content=self.plan(), base_dir=self.tools,
        )
        self.step()
        before = len(self.requests())
        result = self.step()
        self.assertEqual(result["arbiter_verdict"], "in_progress")
        self.assertEqual(len(self.requests()), before, "live envelope re-minted")


class NoStepEverSleeps(_StepCase):
    def test_every_state_branch_completes_without_sleeping(self) -> None:
        def _explode(*_a, **_k):
            raise AssertionError("the resumable step slept")

        start_plan(
            plan_id="plan-1", initial_revision_id="rev-0",
            plan_content=self.plan(), base_dir=self.tools,
        )
        with mock.patch.object(time, "sleep", _explode):
            first = self.step()   # DRAFT branch
            second = self.step()  # idempotent await branch
        self.assertEqual(first["arbiter_verdict"], "in_progress")
        self.assertEqual(second["arbiter_verdict"], "in_progress")


class CrossCycleConvergence(_StepCase):
    def _cross_task(self, task_id: str, reviewer: str, direction: str, rev: str, h: str) -> dict:
        from datetime import datetime, timedelta, timezone

        return {
            "task_id": task_id,
            "reviewer_agent": reviewer,
            "review_direction": direction,
            "target_revision_id": rev,
            "target_plan_content_hash": h,
            "task_packet_hash": content_hash({"t": task_id}),
            "sla_deadline": (datetime.now(timezone.utc) + timedelta(minutes=30)).isoformat(),
        }

    def test_steps_reach_converged_across_cycles_with_zero_polling(self) -> None:
        # Cycle 1: no plan yet → started + challenger minted.
        first = self.step()
        self.assertEqual(first["arbiter_verdict"], "in_progress")
        # "Executor" delivers the challenger (kernel-native fold).
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
        # Cycle 2: CHALLENGER_DRAFTED → cross_review envelope minted.
        second = self.step()
        self.assertEqual(second["arbiter_verdict"], "in_progress")
        self.assertEqual(
            len([r for r in self.requests() if r.get("role") == "cross_review"]), 1,
        )
        # "Executor" delivers both cross-review directions.
        state = plan_status(plan_id="plan-1", base_dir=self.tools)
        latest = state["latest_revision"]
        request_cross_review(
            plan_id="plan-1",
            request={
                "round_number": 1,
                "target_revision_id": latest["revision_id"],
                "target_plan_content_hash": latest["content_hash"],
                "tasks": [
                    self._cross_task("task-p2c-1", "farm-expert", "primary_to_challenger", latest["revision_id"], latest["content_hash"]),
                    self._cross_task("task-c2p-1", "access-boundary-auditor", "challenger_to_primary", latest["revision_id"], latest["content_hash"]),
                ],
            },
            base_dir=self.tools,
        )
        for task_id, reviewer, direction in (
            ("task-p2c-1", "farm-expert", "primary_to_challenger"),
            ("task-c2p-1", "access-boundary-auditor", "challenger_to_primary"),
        ):
            state = plan_status(plan_id="plan-1", base_dir=self.tools)
            current = state["cross_reviews"][state["current_round"]]
            task = next(t for t in current["tasks"].values() if t["task_id"] == task_id)
            record_cross_review(
                plan_id="plan-1",
                review={
                    "task_packet_hash": task["task_packet_hash"],
                    "target_revision_id": task["target_revision_id"],
                    "target_plan_content_hash": task["target_plan_content_hash"],
                    "reviewer_agent": reviewer,
                    "review_direction": direction,
                    "risks": [],
                    "review_content_hash": content_hash({"r": reviewer}),
                },
                workspace_root=self.root,
                base_dir=self.tools,
            )
        self.assertEqual(
            plan_status(plan_id="plan-1", base_dir=self.tools)["state"], "CROSS_REVIEWED",
        )
        # Cycle 3: CROSS_REVIEWED → evaluate → terminal (schema v1: no
        # coverage gate; zero risks converge). Independence may honestly
        # downgrade (the kernel-native folds carry no claim trail), so the
        # pin is: a TERMINAL verdict with zero polling governance rows.
        third = self.step()
        self.assertIn(
            third["arbiter_verdict"], {"converged", "cross_review_self_agreement"},
        )
        self.assertEqual(
            plan_status(plan_id="plan-1", base_dir=self.tools)["state"], "CONVERGED",
        )
        gov_path = self.tools / "governance.jsonl"
        gov = gov_path.read_text(encoding="utf-8") if gov_path.exists() else ""
        self.assertNotIn("poll_timeout", gov)
        self.assertIn("convergence_step_advanced", gov)


class DeadEnvelope(_StepCase):
    def test_dead_envelope_forces_honest_terminal_not_an_orbit(self) -> None:
        # Retry budgeting lives at the request layer (Y1) and bridge
        # mints are idempotent, so a dead envelope cannot be re-minted —
        # the step must escalate to a TERMINAL HUMAN_REQUIRED instead of
        # returning in_progress forever.
        start_plan(
            plan_id="plan-1", initial_revision_id="rev-0",
            plan_content=self.plan(), base_dir=self.tools,
        )
        first = self.step()
        self.assertEqual(first["arbiter_verdict"], "in_progress")
        with mock.patch.object(cd, "_live_request_id", return_value=None):
            second = self.step()
        self.assertNotEqual(second["arbiter_verdict"], "in_progress")
        self.assertEqual(
            plan_status(plan_id="plan-1", base_dir=self.tools)["state"], "HUMAN_REQUIRED",
        )
        gov = (self.tools / "governance.jsonl").read_text(encoding="utf-8")
        self.assertIn("convergence_envelope_dead", gov)
        # Next cycle: terminal plan short-circuits — fresh plans are the
        # adopter's business, not this one's.
        final = self.step()
        self.assertNotEqual(final["arbiter_verdict"], "in_progress")


if __name__ == "__main__":
    unittest.main()
