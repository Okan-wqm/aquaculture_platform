"""ADR-0018 D4 — a plan's origin (``finding_id``) is fixed when the plan starts.

Pre-fix nothing compared a submitted body's ``finding_id`` with the started
plan's: a challenger draft or a revision that changed or dropped it was
recorded, so an operator- or F-sourced plan could converge as a plain plan
and the commit contract and K-A closure lost the finding they were about.
One check in ``plan_convergence._validate_submitted_plan`` now refuses it for
every origin kind, and the planner bridge carries the started origin onto a
body that names none (the planners cannot read it).
"""
from __future__ import annotations

import json
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

from aria_kernel.plan_convergence import (
    content_hash,
    plan_status,
    record_critique,
    record_revision,
    request_critics,
    start_plan,
    submit_challenger_plan,
)
from aria_kernel.plan_convergence_bridge import (
    _canonicalize_challenger_payload,
    _canonicalize_revision_payload,
)
from aria_kernel.plan_origin import PLAN_ORIGIN_CHANGED
from aria_kernel.tool_registry import GovernanceError

# Origin kinds the synthesizer stamps: an aging F finding, an ORPHAN, and an
# operator request (its F finding plus the consumed request ref).
ORIGINS: dict[str, dict] = {
    "f_finding": {"finding_id": "F-007"},
    "orphan_finding": {"finding_id": "ORPHAN-HIGH-104"},
    "operator_feedback": {"finding_id": "F-007",
                          "evidence_refs": ["docs/aria/SPEC.md", "aria-tools/operator-feedback.jsonl:OP-1"]},
}


def _plan(**overrides) -> dict:
    body = {
        "schema_version": 1,
        "title": "Origin fixture",
        "summary": "Plan whose origin is fixed.",
        "affected_surfaces": [{"paths": ["apps/hr-service/src/leave/leave.service.ts"]}],
        "key_changes": ["fix the drift"],
        "validation_commands": [{"cmd": "nx affected --target=test"}],
        "evidence_refs": ["docs/aria/SPEC.md"],
        "architectural_tier": 2,
    }
    body.update(overrides)
    return body


def _without_origin(body: dict) -> dict:
    return {key: value for key, value in body.items() if key != "finding_id"}


class OriginFixedAtStartTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory(prefix="aria-origin-")
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name) / "workspace"
        agents = self.root / ".claude" / "agents"
        agents.mkdir(parents=True)
        (agents / "farm-expert.md").write_text(
            "---\nname: farm-expert\ndescription: Farm reviewer.\n---\n\nOwns `apps/**`.\n", encoding="utf-8",
        )
        self.tools = Path(self.tmp.name) / "aria-tools"
        self.plan_counter = 0

    def _start(self, body: dict) -> str:
        self.plan_counter += 1
        plan_id = f"plan-{self.plan_counter}"
        start_plan(plan_id=plan_id, plan_content=body, initial_revision_id=f"{plan_id}-r0", base_dir=self.tools,
                   workspace_root=self.root)
        return plan_id

    def _challenge(self, plan_id: str, body: dict) -> dict:
        latest = plan_status(plan_id=plan_id, base_dir=self.tools)["latest_revision"]
        return submit_challenger_plan(plan_id=plan_id, challenger={
            "challenger_agent": "aria-challenger-planner", "challenger_revision_id": f"{plan_id}-c1",
            "source_revision_id": latest["revision_id"], "source_plan_content_hash": latest["content_hash"],
            "plan_content": body,
        }, base_dir=self.tools)

    def _critiqued(self, plan_id: str) -> None:
        latest = plan_status(plan_id=plan_id, base_dir=self.tools)["latest_revision"]
        deadline = (datetime.now(timezone.utc) + timedelta(minutes=60)).isoformat()
        task = {"task_id": f"{plan_id}-t1", "task_packet_hash": content_hash({"task": plan_id}),
                "target_agent": "farm-expert", "target_revision_id": latest["revision_id"],
                "target_plan_content_hash": latest["content_hash"], "sla_deadline": deadline}
        request_critics(plan_id=plan_id, request={
            "round_number": 1, "target_revision_id": latest["revision_id"],
            "target_plan_content_hash": latest["content_hash"], "tasks": [task],
        }, base_dir=self.tools)
        record_critique(plan_id=plan_id, critique={
            "task_packet_hash": task["task_packet_hash"], "target_revision_id": latest["revision_id"],
            "target_plan_content_hash": latest["content_hash"], "reviewer": "farm-expert", "risks": [],
            "critique_content_hash": content_hash({"reviewer": "farm-expert", "risks": []}),
        }, workspace_root=self.root, base_dir=self.tools)

    def _revise(self, plan_id: str, body: dict) -> dict:
        state = plan_status(plan_id=plan_id, base_dir=self.tools)
        return record_revision(plan_id=plan_id, revision={
            "revision_id": f"{plan_id}-r1", "round": state["current_round"], "content_hash": content_hash(body),
            "parent_revision_hash": state["latest_revision"]["content_hash"],
            "content": json.dumps(body, sort_keys=True), "addresses_review_risk_ids": [],
        }, base_dir=self.tools)

    def test_a_challenger_draft_cannot_change_or_drop_the_origin(self) -> None:
        for kind, origin in ORIGINS.items():
            with self.subTest(origin=kind):
                started = _plan(**origin)
                plan_id = self._start(started)
                for label, body in (("changed", dict(started, finding_id="F-999")),
                                    ("dropped", _without_origin(started))):
                    with self.subTest(body=label), self.assertRaisesRegex(GovernanceError, PLAN_ORIGIN_CHANGED):
                        self._challenge(plan_id, body)
                self.assertTrue(self._challenge(plan_id, dict(started, title="Challenger"))["event_appended"])

    def test_a_revision_cannot_change_or_drop_the_origin(self) -> None:
        for kind, origin in ORIGINS.items():
            with self.subTest(origin=kind):
                started = _plan(**origin)
                plan_id = self._start(started)
                self._critiqued(plan_id)
                for label, body in (("changed", dict(started, finding_id="ORPHAN-LOW-001")),
                                    ("dropped", _without_origin(started))):
                    with self.subTest(body=label), self.assertRaisesRegex(GovernanceError, PLAN_ORIGIN_CHANGED):
                        self._revise(plan_id, dict(body, summary="revised"))
                self.assertTrue(self._revise(plan_id, dict(started, summary="revised"))["event_appended"])

    def test_a_plan_started_without_an_origin_cannot_gain_one(self) -> None:
        plan_id = self._start(_plan())
        with self.assertRaisesRegex(GovernanceError, PLAN_ORIGIN_CHANGED):
            self._challenge(plan_id, _plan(finding_id="F-007"))
        self.assertTrue(self._challenge(plan_id, _plan(title="Challenger"))["event_appended"])

    def test_the_planner_bridge_carries_the_origin_it_cannot_read(self) -> None:
        started = _plan(**ORIGINS["operator_feedback"])
        plan_id = self._start(started)
        response = {"request_id": "AIR-challenger-000000000001", "agent_id": "aria-challenger-planner",
                    "plan_content": _without_origin(dict(started, title="Challenger"))}
        challenger = _canonicalize_challenger_payload(
            response=response, details={}, plan_id=plan_id, base_dir=self.tools,
        )
        self.assertEqual(challenger["plan_content"]["finding_id"], "F-007")
        self.assertTrue(submit_challenger_plan(plan_id=plan_id, challenger=challenger,
                                               base_dir=self.tools)["event_appended"])
        # An agent can omit the origin, never replace it.
        replaced = _canonicalize_challenger_payload(
            response=dict(response, plan_content=dict(started, finding_id="F-999")),
            details={}, plan_id=plan_id, base_dir=self.tools,
        )
        self.assertEqual(replaced["plan_content"]["finding_id"], "F-999")

        revised_plan = self._start(started)
        self._critiqued(revised_plan)
        revision = _canonicalize_revision_payload(
            response={"request_id": "AIR-primary-000000000001", "agent_id": "aria-primary-planner",
                      "plan_content": _without_origin(dict(started, summary="revised"))},
            details={}, plan_id=revised_plan, base_dir=self.tools,
        )
        self.assertEqual(json.loads(revision["content"])["finding_id"], "F-007")
        self.assertTrue(record_revision(plan_id=revised_plan, revision=revision,
                                        base_dir=self.tools)["event_appended"])


if __name__ == "__main__":
    unittest.main()
