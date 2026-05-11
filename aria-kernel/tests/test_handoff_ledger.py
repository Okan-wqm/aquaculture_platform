"""Plan 020 Phase 3 — handoff ledger tests.

What this suite pins (≥8 tests):
- 4-trigger taxonomy validated.
- 7-field snapshot shape (active_plan, open_findings, open_debts,
  pending_requests, claimed_requests, last_change_chain, last_validation,
  next_logical_step).
- Persistence to aria-tools/handoffs.jsonl.
- handoff_snapshot_recorded governance event emitted.
- list_handoffs / read_handoff query API.
- Frozen-aware: frozen profile blocks the persist step (handoffs is in
  PLAN_020_WRITE_SURFACES).
- Observe profile permits handoff snapshots (observation-class write).
- next_logical_step heuristic surfaces in plain English.
"""
from __future__ import annotations

import json
import shutil
import tempfile
import unittest
from pathlib import Path

from aria_kernel.handoff_ledger import (
    HANDOFFS_FILENAME,
    VALID_TRIGGERS,
    list_handoffs,
    read_handoff,
    take_handoff_snapshot,
)
from aria_kernel.runtime_profile import set_profile
from aria_kernel.tool_registry import GovernanceError, ensure_tools_dir


def _seed() -> tuple[Path, Path]:
    tmp = Path(tempfile.mkdtemp(prefix="aria-handoff-"))
    tools = tmp / "aria-tools"
    ensure_tools_dir(tools)
    repo = tmp / "repo"
    repo.mkdir()
    (repo / "docs" / "aria" / "plans").mkdir(parents=True, exist_ok=True)
    (repo / "aria-findings").mkdir(parents=True, exist_ok=True)
    (repo / "aria-debts").mkdir(parents=True, exist_ok=True)
    return tools, repo


class TriggerTaxonomyTests(unittest.TestCase):
    def test_four_triggers_locked(self) -> None:
        self.assertEqual(VALID_TRIGGERS, frozenset({
            "manual", "session_start", "pre_compact", "session_stop",
        }))


class SnapshotShapeTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tools, self.repo = _seed()

    def tearDown(self) -> None:
        shutil.rmtree(self.tools.parent, ignore_errors=True)

    def test_snapshot_carries_seven_fields(self) -> None:
        snap = take_handoff_snapshot(
            session_id="session-test-1",
            trigger="manual",
            base_dir=self.tools,
            repo_root=self.repo,
        )
        for key in (
            "active_plan", "open_findings", "open_debts",
            "pending_requests", "claimed_requests",
            "last_change_chain", "last_validation",
            "next_logical_step",
        ):
            self.assertIn(key, snap)

    def test_snapshot_carries_session_id_trigger_recorded_at(self) -> None:
        snap = take_handoff_snapshot(
            session_id="session-test-2",
            trigger="session_start",
            base_dir=self.tools,
            repo_root=self.repo,
        )
        self.assertEqual(snap["session_id"], "session-test-2")
        self.assertEqual(snap["trigger"], "session_start")
        self.assertIn("recorded_at", snap)

    def test_active_plan_resolves_newest_md(self) -> None:
        plans = self.repo / "docs" / "aria" / "plans"
        (plans / "010-old.md").write_text("old plan\n", encoding="utf-8")
        # Touch the newer file.
        newer = plans / "020-new.md"
        newer.write_text("new plan\n", encoding="utf-8")
        # Push old mtime back.
        import os
        os.utime(plans / "010-old.md", (1_000_000, 1_000_000))
        snap = take_handoff_snapshot(
            session_id="session-plan",
            trigger="manual",
            base_dir=self.tools,
            repo_root=self.repo,
        )
        self.assertIsNotNone(snap["active_plan"])
        self.assertTrue(snap["active_plan"]["path"].endswith("020-new.md"))

    def test_active_plan_is_none_when_plans_dir_empty(self) -> None:
        snap = take_handoff_snapshot(
            session_id="s-empty",
            trigger="manual",
            base_dir=self.tools,
            repo_root=self.repo,
        )
        self.assertIsNone(snap["active_plan"])


class TriggerValidationTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tools, self.repo = _seed()

    def tearDown(self) -> None:
        shutil.rmtree(self.tools.parent, ignore_errors=True)

    def test_unknown_trigger_raises(self) -> None:
        with self.assertRaises(GovernanceError) as cm:
            take_handoff_snapshot(
                session_id="s-x", trigger="halt-and-catch-fire",
                base_dir=self.tools, repo_root=self.repo,
            )
        self.assertIn("unknown handoff trigger", str(cm.exception))

    def test_empty_session_id_raises(self) -> None:
        with self.assertRaises(GovernanceError) as cm:
            take_handoff_snapshot(
                session_id="", trigger="manual",
                base_dir=self.tools, repo_root=self.repo,
            )
        self.assertIn("session_id is required", str(cm.exception))


class PersistenceTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tools, self.repo = _seed()

    def tearDown(self) -> None:
        shutil.rmtree(self.tools.parent, ignore_errors=True)

    def test_persists_to_handoffs_jsonl(self) -> None:
        take_handoff_snapshot(
            session_id="s-persist", trigger="manual",
            base_dir=self.tools, repo_root=self.repo,
        )
        path = self.tools / HANDOFFS_FILENAME
        self.assertTrue(path.exists())
        rows = [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["session_id"], "s-persist")

    def test_emits_handoff_snapshot_recorded_governance_event(self) -> None:
        take_handoff_snapshot(
            session_id="s-gov", trigger="session_stop",
            base_dir=self.tools, repo_root=self.repo,
        )
        gov = (self.tools / "governance.jsonl").read_text(encoding="utf-8").splitlines()
        kinds = [json.loads(line)["kind"] for line in gov if line.strip()]
        self.assertIn("handoff_snapshot_recorded", kinds)


class QueryApiTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tools, self.repo = _seed()

    def tearDown(self) -> None:
        shutil.rmtree(self.tools.parent, ignore_errors=True)

    def test_list_handoffs_filters_by_session(self) -> None:
        take_handoff_snapshot(session_id="s-A", trigger="manual",
                              base_dir=self.tools, repo_root=self.repo)
        take_handoff_snapshot(session_id="s-B", trigger="manual",
                              base_dir=self.tools, repo_root=self.repo)
        take_handoff_snapshot(session_id="s-A", trigger="session_stop",
                              base_dir=self.tools, repo_root=self.repo)
        rows = list_handoffs(base_dir=self.tools, session_id="s-A")
        self.assertEqual(len(rows), 2)

    def test_list_handoffs_filters_by_trigger(self) -> None:
        take_handoff_snapshot(session_id="s-A", trigger="session_start",
                              base_dir=self.tools, repo_root=self.repo)
        take_handoff_snapshot(session_id="s-A", trigger="session_stop",
                              base_dir=self.tools, repo_root=self.repo)
        rows = list_handoffs(base_dir=self.tools, trigger="session_stop")
        self.assertEqual(len(rows), 1)

    def test_read_handoff_returns_last_for_session(self) -> None:
        take_handoff_snapshot(session_id="s-A", trigger="session_start",
                              base_dir=self.tools, repo_root=self.repo,
                              operator_note="first")
        take_handoff_snapshot(session_id="s-A", trigger="session_stop",
                              base_dir=self.tools, repo_root=self.repo,
                              operator_note="last")
        latest = read_handoff(session_id="s-A", base_dir=self.tools)
        self.assertIsNotNone(latest)
        self.assertEqual(latest["operator_note"], "last")


class ProfileGateTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tools, self.repo = _seed()

    def tearDown(self) -> None:
        shutil.rmtree(self.tools.parent, ignore_errors=True)

    def test_frozen_blocks_handoff_persist(self) -> None:
        set_profile("frozen", operator_approval_ref="op:freeze",
                    base_dir=self.tools)
        with self.assertRaises(GovernanceError) as cm:
            take_handoff_snapshot(
                session_id="s-frozen", trigger="manual",
                base_dir=self.tools, repo_root=self.repo,
            )
        self.assertIn("handoffs", str(cm.exception))
        self.assertIn("frozen", str(cm.exception))

    def test_observe_permits_handoff_persist(self) -> None:
        set_profile("observe", operator_approval_ref="op:observe",
                    base_dir=self.tools)
        snap = take_handoff_snapshot(
            session_id="s-observe", trigger="manual",
            base_dir=self.tools, repo_root=self.repo,
        )
        self.assertEqual(snap["session_id"], "s-observe")


class NextLogicalStepHeuristicTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tools, self.repo = _seed()

    def tearDown(self) -> None:
        shutil.rmtree(self.tools.parent, ignore_errors=True)

    def test_idle_when_no_open_work(self) -> None:
        snap = take_handoff_snapshot(
            session_id="s-idle", trigger="manual",
            base_dir=self.tools, repo_root=self.repo,
        )
        self.assertIn("no actionable work", snap["next_logical_step"])


if __name__ == "__main__":
    unittest.main()
