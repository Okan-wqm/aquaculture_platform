"""ARIA-HIGH-420 — a failed night still reflects, and still plans the next one.

The autonomy orchestrator runs the cycle with ``defer_reflection=True`` and
writes the reflection itself on its post-drain exits (V3.3 §2b). Before this,
neither failed exit wrote one: the fail-closed ``cycle_failed`` break and the
``bridge_replay_required`` break both appended the summary and left. On
aria/state f5c5c86a1 each of the 22 completed cycles since 2026-10-01 has a
reflection row and none of the 5 failed ones does (2026-10-09T10:44Z ..
2026-10-10T02:51Z, all ``pr_lifecycle``). So the nights that most needed a
next-cycle plan and a daily report produced neither.

Reflection is not a pure observer. It writes the daily report and queues the
next cycle's pressures (``next_cycle_queue.append_pending``). On a failed night
that queueing is the intended self-repair entry, so these tests pin it, not
only the row.

The fixtures drive the real orchestrator. The cycle runner returns the shape
of the five production failures: it returned normally, ``status`` was
``failed``, and the failure was a payload ``pr_lifecycle`` phase. The
production code paths are not patched.
"""
from __future__ import annotations

import json
import shutil
import tempfile
import unittest
from pathlib import Path
from typing import Any
from unittest.mock import Mock

from aria_kernel.autonomy_state import autonomy_state_path
from aria_kernel.ledger import load_jsonl
from aria_kernel.next_cycle_queue import read_pending
from aria_kernel.runtime_profile import set_profile
from aria_kernel.tool_registry import ensure_tools_dir
from tests import test_autonomy_orchestrator as orchestrator_fixtures
from tests._helpers.operator_acts import operator_set_profile

_PRESSURE_ID = "pressure:failed-night:pr-lifecycle-refusal"


def _store_pressure(base_dir: Path, cycle_id: str) -> None:
    """The cycle's ranked pressures, as the pressure phase stores them.

    The pressure phase runs before pr_lifecycle, so a night that failed on
    pr_lifecycle has its pressure payload on disk. The evidence ref has the
    citable ``path:line`` shape the agent law admits.
    """
    root = ensure_tools_dir(base_dir)
    (root / "pressure").mkdir(parents=True, exist_ok=True)
    (root / "pressure" / f"{cycle_id}.json").write_text(
        json.dumps({
            "summary": {"total": 1},
            "pressures": [{
                "pressure_id": _PRESSURE_ID,
                "source": "pipeline_stalled",
                "recommended_action": "investigate",
                "candidate_tools": [],
                "evidence": ["aria-kernel/aria_kernel/cycle.py:1"],
            }],
        }),
        encoding="utf-8",
    )


def _payload_failed_cycle_runner(
    *, workspace_root: Any, cycle_id: str, base_dir: Path, defer_reflection: bool = False,
) -> dict[str, Any]:
    """The five failed nights' shape: the runner RETURNED, failed by payload."""
    _store_pressure(base_dir, cycle_id)
    return {
        "schema_version": 2,
        "cycle_id": cycle_id,
        "status": "failed",
        "runtime_status": "failed",
        "failed_phases": [{
            "phase": "pr_lifecycle",
            "status": "failed",
            "error": "open_pr_head_sha_unresolvable",
        }],
        "reflection": None,
    }


def _crashing_cycle_runner(
    *, workspace_root: Any, cycle_id: str, base_dir: Path, defer_reflection: bool = False,
) -> dict[str, Any]:
    raise RuntimeError("simulated cycle crash")


def _completed_cycle_runner(
    *, workspace_root: Any, cycle_id: str, base_dir: Path, defer_reflection: bool = False,
) -> dict[str, Any]:
    _store_pressure(base_dir, cycle_id)
    return {"schema_version": 2, "cycle_id": cycle_id, "status": "completed", "reflection": None}


def _stuck_bridge_drainer(*, base_dir: Path, max_iterations: int) -> dict[str, Any]:
    return {"status": "ok", "iterations": 1, "pending_after": 2}


def _tamper_then_crash(
    *, workspace_root: Any, cycle_id: str, base_dir: Path, defer_reflection: bool = False,
) -> dict[str, Any]:
    """dedupe's repro: an out-of-band write leaves a row with no ledger_hash
    in a ledger reflection reads strictly, and the cycle crashes on it."""
    root = ensure_tools_dir(base_dir)
    (root / "auto-merge-decisions.jsonl").write_text('{"decision": "blocked"}\n', encoding="utf-8")
    raise RuntimeError("ledger chain broken: auto-merge-decisions.jsonl")


def _tamper_findings_then_crash(
    *, workspace_root: Any, cycle_id: str, base_dir: Path, defer_reflection: bool = False,
) -> dict[str, Any]:
    """dedupe's second repro: the broken chain is in a ledger OUTSIDE the
    tools root (the committed findings beside the workspace), so the refusal
    text carries a host path that no tools-root prefix covers."""
    from aria_kernel.finding import findings_dir

    events = findings_dir(Path(workspace_root)) / "finding-events.jsonl"
    events.parent.mkdir(parents=True, exist_ok=True)
    events.write_text('{"event": "finding_emitted"}\n', encoding="utf-8")
    raise RuntimeError("ledger chain broken: finding-events.jsonl")


class FailedCycleReflectionTests(unittest.TestCase):
    # The production-shaped orchestrator kwargs (every REQUIRED runner
    # injected), borrowed rather than copied so the two suites cannot drift.
    _run = orchestrator_fixtures.AutonomyOrchestratorTests._run

    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="aria-high-420-"))
        self.base = self.tmp / "aria-tools"
        set_profile("standard", operator_approval_ref="high-420", base_dir=self.base)

    def tearDown(self) -> None:
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _reflections(self) -> list[dict[str, Any]]:
        path = self.base / "reflections.jsonl"
        return load_jsonl(path) if path.exists() else []

    def _assert_reflected(self, result: dict[str, Any], *, exit_reason: str) -> dict[str, Any]:
        self.assertEqual(result["exit_reason"], exit_reason)
        self.assertEqual(len(result["per_cycle"]), 1)
        cycle_id = result["per_cycle"][0]["cycle_id"]
        rows = [row for row in self._reflections() if row.get("cycle_id") == cycle_id]
        self.assertEqual(len(rows), 1, f"a {exit_reason} night must write exactly one reflection row")
        # The summary the run returns carries the row, as every other exit's does.
        self.assertEqual(result["per_cycle"][0]["reflection"]["cycle_id"], cycle_id)
        return rows[0]

    def test_fail_closed_night_reflects_and_queues_the_next_cycle(self) -> None:
        planner = Mock(wraps=orchestrator_fixtures._fake_planner_drainer)
        result = self._run(cycle_runner=_payload_failed_cycle_runner, planner_drainer=planner)

        row = self._assert_reflected(result, exit_reason="cycle_failed")
        cycle_id = row["cycle_id"]
        # The work lanes are still skipped: the reflection is the only thing
        # that runs after a fail-closed cycle.
        planner.assert_not_called()
        self.assertIsNone(row["convergence"], "no Gate A/B ran; the legitimately-skipped sentinel")
        # The row describes the failed cycle, not a blank one.
        self.assertEqual(row["cycle_runner"]["status"], "failed")
        self.assertEqual(
            row["cycle_runner"]["failed_phases"],
            [{"phase": "pr_lifecycle", "status": "failed", "error": "open_pr_head_sha_unresolvable"}],
        )
        # Self-repair entry: the failed night's top pressure is queued for the next cycle.
        self.assertEqual(
            [(item["pressure_id"], item["source_cycle_id"]) for item in read_pending(self.base)],
            [(_PRESSURE_ID, cycle_id)],
        )
        self.assertTrue(list((self.base / "reports" / "daily").glob("*.md")), "the daily report is written")

    def test_crashed_night_reflects_with_the_crash_on_the_row(self) -> None:
        result = self._run(cycle_runner=_crashing_cycle_runner)

        row = self._assert_reflected(result, exit_reason="cycle_failed")
        self.assertEqual(row["cycle_runner"]["status"], "failed")
        self.assertEqual(row["cycle_runner"]["error"], "simulated cycle crash")

    def test_bridge_replay_required_night_reflects(self) -> None:
        operator_set_profile("strict", base_dir=self.base, scheduler_ceiling="strict")
        worker = Mock(wraps=orchestrator_fixtures._fake_worker_drainer)
        result = self._run(
            profile="strict", cycle_runner=_completed_cycle_runner,
            bridge_drainer=_stuck_bridge_drainer, worker_drainer=worker,
        )

        row = self._assert_reflected(result, exit_reason="bridge_replay_required")
        worker.assert_not_called()
        self.assertEqual(
            result["per_cycle"][0]["failed_phases"],
            [{"phase": "bridge", "status": "failed", "bridge_status": "ok", "pending_after": 2}],
        )
        self.assertEqual([item["pressure_id"] for item in read_pending(self.base)], [_PRESSURE_ID])
        self.assertEqual(row["cycle_runner"]["status"], "completed")

    def test_a_store_that_refuses_verification_still_exits_cycle_failed(self) -> None:
        # Review of 0c9fd8f35 (dedupe): the reflection's strict read raised
        # LedgerIntegrityError out of the orchestrator. There was no return,
        # no exit row, and the night exited worse than on the parent.
        result = self._run(cycle_runner=_tamper_then_crash)

        self.assertEqual(result["exit_reason"], "cycle_failed")
        self.assertFalse(result["exits_clean"])
        refusal = result["per_cycle"][0]["reflection"]
        self.assertEqual((refusal["status"], refusal["reason"]), ("refused", "ledger_integrity"))
        self.assertIn("auto-merge-decisions.jsonl", refusal["error"])
        self.assertNotIn(self.base.resolve().as_posix(), refusal["error"], "published text carries no host path")
        self.assertEqual(self._reflections(), [])
        # In order on the orchestrator's own ledger: the cycle's verdict, then
        # the refusal, both written by the same writer on the same night.
        cycle_id = result["per_cycle"][0]["cycle_id"]
        phases = [
            (row["phase"], row["status"]) for row in load_jsonl(autonomy_state_path(self.base))
            if row.get("cycle_id") == cycle_id
        ]
        self.assertEqual(
            phases[-2:], [("cycle_completed", "failed"), ("failed_cycle_reflection_refused", "refused")],
        )
        # The exit row the parent wrote is still written.
        exits = [
            row for row in load_jsonl(self.base / "governance.jsonl")
            if row.get("kind") == "autonomy_orchestrator_exit"
        ]
        self.assertEqual([row["details"]["exit_reason"] for row in exits], ["cycle_failed"])

    def test_a_refusal_outside_the_store_publishes_no_host_path(self) -> None:
        # Review of 5aadb57e0 (dedupe): only the tools root was stripped, and
        # the refusal row is published on aria/state (a public repository).
        result = self._run(cycle_runner=_tamper_findings_then_crash)

        self.assertEqual(result["exit_reason"], "cycle_failed")
        refusal = result["per_cycle"][0]["reflection"]
        self.assertEqual((refusal["status"], refusal["reason"]), ("refused", "ledger_integrity"))
        self.assertIn("finding-events.jsonl", refusal["error"])
        for root in {self.tmp.as_posix(), self.tmp.resolve().as_posix()}:
            self.assertNotIn(root, refusal["error"])
        self.assertNotRegex(refusal["error"], r"(?<![\w.\-~])/[^\s]", "no absolute path of any root")


if __name__ == "__main__":
    unittest.main()
