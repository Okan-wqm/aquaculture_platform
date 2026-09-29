"""E2 — the implementation state machine gets a real entry (F1) and plans
survive their cycle (F9).

Pre-fix world, proven by audit + adversarial verification: the three
implementation transitions had ZERO production callers — the envelope
issuer's own error message promised "exactly one escape from CONVERGED"
and never wrote it; every implementer result was refused against an
unreachable IN_FLIGHT precondition; the implementer poll accepted only
MERGED/REJECTED so even success timed out; and plan identity was minted
from the cycle id so each night's answered envelopes landed on a plan
nobody watched.
"""
from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from aria_kernel.implementation_reconciler import (
    _pr_number_from_url,
    reconcile_recorded_implementations,
)
from aria_kernel.plan_convergence import (
    fold_plan_state,
    record_implementation_outcome,
    record_implementation_started,
    request_implementation,
    resume_candidate_plan_id,
    start_plan,
)


def _plan_content(title: str = "E2 plan") -> dict:
    return {
        "schema_version": 1,
        "title": title,
        "summary": "E2 continuity test plan.",
        "affected_surfaces": [{"paths": ["aria-kernel/aria_kernel/plan_convergence.py"]}],
        "key_changes": ["change"],
        "validation_commands": [{"cmd": "true"}],
        "evidence_refs": ["docs/aria/SPEC.md"],
    }


def seed_reviewer_agent(workspace_root: Path) -> None:
    """The one agent `record_critique` resolves the reviewer against."""
    agents = workspace_root / ".claude" / "agents"
    agents.mkdir(parents=True, exist_ok=True)
    (agents / "farm-expert.md").write_text(
        "---\nname: farm-expert\ndescription: Farm reviewer.\n---\n\nBody.\n",
        encoding="utf-8",
    )


def drive_plan_to_converged(
    *, plan_id: str, tools: Path, workspace_root: Path, title: str = "E2 plan",
) -> None:
    """CONVERGED via the direct evaluator path (zero-risk round one).

    Module-level, not a TestCase method, because the orphan-reaper suite in
    `tests/test_autonomy_orchestrator.py` needs a plan that is genuinely in
    IMPLEMENTATION_REQUESTED — a synthetic dict would let the reaper's window
    pass against a plan the real transition would have refused.
    """
    from aria_kernel.plan_convergence import evaluate_plan, record_critique, request_critics

    start_plan(
        plan_id=plan_id,
        initial_revision_id="rev-0",
        plan_content=_plan_content(title),
        base_dir=tools,
    )
    content_hash = fold_plan_state(
        plan_id=plan_id, base_dir=tools,
    )["latest_revision"]["content_hash"]
    request_critics(
        plan_id=plan_id,
        request={
            "round_number": 1,
            "target_revision_id": "rev-0",
            "target_plan_content_hash": content_hash,
            "tasks": [{
                "task_id": "t-1",
                "task_packet_hash": "sha256:" + "a" * 64,
                "target_agent": "farm-expert",
                "target_revision_id": "rev-0",
                "target_plan_content_hash": content_hash,
                "sla_deadline": "2099-01-01T00:00:00+00:00",
                "status_after": "PENDING",
            }],
        },
        base_dir=tools,
    )
    record_critique(
        plan_id=plan_id,
        critique={
            "task_packet_hash": "sha256:" + "a" * 64,
            "target_revision_id": "rev-0",
            "target_plan_content_hash": content_hash,
            "reviewer": "farm-expert",
            "risks": [],
            "critique_content_hash": "sha256:" + "b" * 64,
            "status_after": "ANSWERED",
        },
        workspace_root=workspace_root,
        base_dir=tools,
    )
    evaluate_plan(plan_id=plan_id, round_number=1, base_dir=tools)


def drive_plan_to_implementation_requested(
    *, plan_id: str, tools: Path, workspace_root: Path, title: str = "E2 plan",
) -> None:
    drive_plan_to_converged(
        plan_id=plan_id, tools=tools, workspace_root=workspace_root, title=title,
    )
    request_implementation(
        plan_id=plan_id,
        implementer_agent="aria-implementer",
        converged_plan_revision_id="rev-0",
        converged_plan_content_hash=fold_plan_state(
            plan_id=plan_id, base_dir=tools,
        )["latest_revision"]["content_hash"],
        base_dir=tools,
    )


class ImplementationChainTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.tools = Path(self.tmp.name) / "aria-tools"
        self.root = Path(self.tmp.name) / "workspace"
        seed_reviewer_agent(self.root)

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def _converged_plan(self, plan_id: str = "plan-e2") -> None:
        drive_plan_to_converged(
            plan_id=plan_id, tools=self.tools, workspace_root=self.root,
        )
        self.assertEqual(
            fold_plan_state(plan_id=plan_id, base_dir=self.tools)["state"], "CONVERGED"
        )

    def _to_recorded(self, plan_id: str = "plan-e2") -> None:
        drive_plan_to_implementation_requested(
            plan_id=plan_id, tools=self.tools, workspace_root=self.root,
        )
        record_implementation_started(
            plan_id=plan_id,
            claim_id="claim-1",
            implementer_agent="aria-implementer",
            started_at="2026-08-12T10:00:00Z",
            base_dir=self.tools,
        )
        record_implementation_outcome(
            plan_id=plan_id,
            claim_id="claim-1",
            pr_url="https://github.com/o/r/pull/4242",
            diff_hash="sha256:" + "c" * 64,
            branch_tip_sha="d" * 40,
            base_branch_sha="e" * 40,
            validation_results=[],
            signer_key_fp="fp-1",
            completed_at="2026-08-12T10:30:00Z",
            base_dir=self.tools,
        )
        self.assertEqual(
            fold_plan_state(plan_id=plan_id, base_dir=self.tools)["state"],
            "IMPLEMENTATION_RECORDED",
        )

    def test_full_chain_reaches_recorded(self) -> None:
        # The chain the arc audit proved unreachable: CONVERGED →
        # REQUESTED → IN_FLIGHT → RECORDED, with the real transition fns.
        self._to_recorded()

    def test_reconciler_folds_merged_pr_to_terminal(self) -> None:
        self._to_recorded()

        class _Reader:
            def readable(self):
                return (True, "ok")

            def pr_merge_state(self, pr_number: int):
                assert pr_number == 4242
                return {
                    "state": "MERGED",
                    "mergedAt": "2026-08-12T11:00:00Z",
                    "mergeCommit": {"oid": "f" * 40},
                }

        result = reconcile_recorded_implementations(base_dir=self.tools, reader=_Reader())
        self.assertEqual([m["plan_id"] for m in result["merged"]], ["plan-e2"])
        self.assertEqual(
            fold_plan_state(plan_id="plan-e2", base_dir=self.tools)["state"],
            "IMPLEMENTATION_MERGED",
        )
        # Idempotent: a second pass finds a terminal plan and does nothing.
        again = reconcile_recorded_implementations(base_dir=self.tools, reader=_Reader())
        self.assertEqual(again["merged"], [])

    def test_reconciler_leaves_unmerged_pr_alone(self) -> None:
        self._to_recorded()

        class _Reader:
            def readable(self):
                return (True, "ok")

            def pr_merge_state(self, pr_number: int):
                return {"state": "OPEN", "mergedAt": None, "mergeCommit": None}

        result = reconcile_recorded_implementations(base_dir=self.tools, reader=_Reader())
        self.assertEqual(result["merged"], [])
        self.assertEqual(
            fold_plan_state(plan_id="plan-e2", base_dir=self.tools)["state"],
            "IMPLEMENTATION_RECORDED",
        )

    def test_pr_number_extraction(self) -> None:
        self.assertEqual(_pr_number_from_url("https://github.com/o/r/pull/17"), 17)
        self.assertIsNone(_pr_number_from_url("not-a-url"))


class OrphanReapWindowTests(unittest.TestCase):
    """ORPHAN-HIGH-729 — an outstanding request is not the same thing as an
    abandoned one, once mint and drain live in different workflow runs.

    The scanner has always carried `last_event_at`; nothing read it. These
    pin the reap window itself, at the scanner boundary the orchestrator's
    startup hook consumes, so the policy is testable without booting an
    orchestrator (the hook's own behaviour is pinned in
    `tests/test_autonomy_orchestrator.py`).
    """

    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.tools = Path(self.tmp.name) / "aria-tools"

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def test_the_window_is_one_executor_night_plus_slack(self) -> None:
        from aria_kernel.plan_convergence import (
            ORPHAN_IMPLEMENTATION_REAP_AFTER_HOURS,
            STALE_PLAN_MAX_AGE_HOURS,
        )
        self.assertEqual(ORPHAN_IMPLEMENTATION_REAP_AFTER_HOURS, 24)
        self.assertEqual(
            STALE_PLAN_MAX_AGE_HOURS, 72,
            "adoption staleness mirrors autonomy_unlock's acceptance gap and "
            "is a different policy; folding the two together would tie the "
            "executor window to the ladder's continuity rule",
        )

    @staticmethod
    def _hours_ago(hours: float) -> str:
        from datetime import datetime, timedelta, timezone

        return (
            datetime.now(timezone.utc) - timedelta(hours=hours)
        ).isoformat().replace("+00:00", "Z")

    def test_a_request_inside_the_window_is_not_old_enough_to_reap(self) -> None:
        from aria_kernel.plan_convergence import (
            ORPHAN_DECISION_REAP,
            ORPHAN_DECISION_SPARE_RECENT,
            decide_orphan_reap,
        )
        self.assertEqual(
            decide_orphan_reap({"last_event_at": self._hours_ago(1)}).decision,
            ORPHAN_DECISION_SPARE_RECENT,
        )
        self.assertEqual(
            decide_orphan_reap({"last_event_at": self._hours_ago(30)}).decision,
            ORPHAN_DECISION_REAP,
        )

    def test_an_unreadable_newest_stamp_falls_back_to_the_plans_birth(self) -> None:
        """A corrupt `recorded_at` must not be able to buy a plan immunity.

        The first version of this bound asked `_older_than_hours`, which
        answers False for an unparseable stamp — so a mangled row read
        exactly like a request minted ten minutes ago, and the plan was
        filed as `spared_recent` forever. The age now comes from the plan's
        FIRST event when its newest one cannot be read: older by definition,
        so the fallback can only ever make a plan look old enough, never
        young enough.
        """
        from aria_kernel.plan_convergence import (
            ORPHAN_DECISION_REAP,
            ORPHAN_DECISION_SPARE_RECENT,
            decide_orphan_reap,
        )
        stale = decide_orphan_reap({
            "last_event_at": "not-a-date",
            "first_event_at": self._hours_ago(30),
        })
        self.assertEqual(stale.decision, ORPHAN_DECISION_REAP)
        self.assertEqual(stale.age_source, "first_event_at")
        recent = decide_orphan_reap({
            "last_event_at": "not-a-date",
            "first_event_at": self._hours_ago(2),
        })
        self.assertEqual(recent.decision, ORPHAN_DECISION_SPARE_RECENT)
        self.assertEqual(recent.age_source, "first_event_at")

    def test_a_plan_with_no_readable_stamp_at_all_is_undateable(self) -> None:
        """Neither stamp readable is a corrupt ledger, not a schedule
        question: `_append_event` always stamps, so this shape cannot be
        produced by the writer. The decision says so by name, and the caller
        escalates rather than guessing in either direction — sparing it was
        what made such a plan immortal, since `resume_candidate_plan_id`
        skips implementation-phase states and never sees it."""
        from aria_kernel.plan_convergence import (
            ORPHAN_DECISION_ESCALATE_UNDATEABLE,
            decide_orphan_reap,
        )
        for orphan in (
            {"last_event_at": None, "first_event_at": None},
            {"last_event_at": "not-a-date", "first_event_at": "also-not-a-date"},
            {},
        ):
            with self.subTest(orphan=orphan):
                decision = decide_orphan_reap(orphan)
                self.assertEqual(
                    decision.decision, ORPHAN_DECISION_ESCALATE_UNDATEABLE,
                )
                self.assertIsNone(decision.age_source)

    def test_the_scanner_reports_the_stamp_the_window_is_measured_from(self) -> None:
        """The bound is only as real as the field it reads. `last_event_at`
        was `None` for every orphan until the writer/reader mismatch was
        fixed (C12/E8); a bound over `None` would spare everything forever."""
        from aria_kernel.plan_convergence import scan_orphan_implementation_requests

        start_plan(
            plan_id="plan-window",
            initial_revision_id="rev-0",
            plan_content=_plan_content("window"),
            base_dir=self.tools,
        )
        with patch(
            "aria_kernel.plan_convergence.fold_plan_state",
            return_value={"state": "IMPLEMENTATION_REQUESTED"},
        ):
            orphans = scan_orphan_implementation_requests(base_dir=self.tools)
        self.assertEqual([row["plan_id"] for row in orphans], ["plan-window"])
        self.assertIsInstance(orphans[0]["last_event_at"], str)
        self.assertTrue(orphans[0]["last_event_at"])
        # ...and the second clock, which is what gives a plan with one
        # mangled row a terminal path instead of permanent immunity.
        self.assertIsInstance(orphans[0]["first_event_at"], str)
        self.assertTrue(orphans[0]["first_event_at"])


class PlanContinuityTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.tools = Path(self.tmp.name) / "aria-tools"

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def test_mid_flight_plan_is_adopted(self) -> None:
        start_plan(
            plan_id="plan-last-night",
            initial_revision_id="rev-0",
            plan_content=_plan_content("last night"),
            base_dir=self.tools,
        )
        self.assertEqual(
            resume_candidate_plan_id(base_dir=self.tools), "plan-last-night"
        )

    def test_no_mid_flight_plan_means_fresh_start(self) -> None:
        self.assertIsNone(resume_candidate_plan_id(base_dir=self.tools))


if __name__ == "__main__":
    unittest.main()
