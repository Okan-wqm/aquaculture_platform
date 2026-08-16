"""Drain-mode tests for the scheduled executor lane.

WHY this file exists: the nightly executor claimed exactly ONE request per
run while the producer mints many per cycle, so the queue only ever grew
(162 pending judge requests by 2026-08-11). `MAX_REQUESTS_PER_RUN` was
exported by the workflow and read by nothing — the "tunable that gates
nothing" class ci_executor.py itself condemns at ORPHAN-HIGH-472.
`drain_pending` makes the cap real; these tests pin its contract:

* each request runs through the LOCKED single-request argv as a subprocess
  (invariant I-V3-21), with `target_agent` passed through from the row;
* a request that comes back pending after being attempted stops the loop
  (an environment fault must not be priced as N request failures);
* the cap and the aggregate GITHUB_OUTPUT contract hold;
* any child failure turns the run red WITHOUT discarding the successes.
"""
from __future__ import annotations

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

import ci_executor  # noqa: E402
import ci_executor_drain  # noqa: E402


class _FakeProc:
    def __init__(self, returncode: int = 0, stdout: str = "", stderr: str = ""):
        self.returncode = returncode
        self.stdout = stdout
        self.stderr = stderr


def _drain(queue, child_results, env=None, tmp=None):
    """Run drain_pending against a scripted queue.

    ``queue`` is consumed one row per next-pending call (None → "null").
    ``child_results`` maps request_id → (exit_code, publish_paths_bool).
    Returns (exit_code, calls, github_output_text).
    """
    calls = {"next_pending": 0, "dispatch": []}
    out_dir = Path(tmp)
    parent_output = out_dir / "github-output.txt"
    parent_output.write_text("", encoding="utf-8")

    def fake_run(argv, **kwargs):
        if "next-pending" in argv:
            calls["next_pending"] += 1
            excluded = {argv[i + 1] for i, tok in enumerate(argv) if tok == "--exclude"}
            role = next((argv[i + 1] for i, tok in enumerate(argv) if tok == "--role"), None)
            row = None
            for candidate in queue:
                if candidate is None:
                    continue
                if candidate.get("request_id") in excluded:
                    continue
                if role is not None and candidate.get("role", "evidence_judgment") != role:
                    continue
                row = candidate
                break
            if row is not None:
                queue.remove(row)
            return _FakeProc(stdout=json.dumps(row) if row else "null")
        # Child dispatch: argv is [python3, <script>, request_id, (target)].
        request_id = argv[2]
        target = argv[3] if len(argv) > 3 else None
        calls["dispatch"].append((request_id, target))
        exit_code, publishes = child_results[request_id]
        child_output = Path(kwargs["env"]["GITHUB_OUTPUT"])
        if publishes:
            child_output.write_text(
                f"envelope_path=outputs/{request_id}.md\n"
                f"transcript_path=outputs/{request_id}.transcript.jsonl\n",
                encoding="utf-8",
            )
        return _FakeProc(returncode=exit_code)

    env_vars = {
        "GITHUB_OUTPUT": str(parent_output),
        "RUNNER_TEMP": str(out_dir),
        **(env or {}),
    }
    with patch.dict(os.environ, env_vars), patch.object(
        ci_executor_drain.subprocess, "run", side_effect=fake_run
    ):
        rc = ci_executor_drain.drain_pending(
            tools_dir=out_dir / "aria-tools", repo_root=_REPO_ROOT
        )
    return rc, calls, parent_output.read_text(encoding="utf-8")


class DrainPendingTests(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def test_drains_queue_to_empty_and_aggregates_outputs(self) -> None:
        queue = [
            {"request_id": "AIR-1", "target_agent": "aria-evidence-judge"},
            {"request_id": "AIR-2", "target_agent": "aria-cross-reviewer"},
            None,
        ]
        rc, calls, output = _drain(
            queue,
            {"AIR-1": (0, True), "AIR-2": (0, True)},
            tmp=self._tmp.name,
        )
        self.assertEqual(rc, 0)
        # target_agent flows through — the single-shot workflow path dropped
        # it, running every request under the evidence-judge default profile.
        self.assertEqual(
            calls["dispatch"],
            [("AIR-1", "aria-evidence-judge"), ("AIR-2", "aria-cross-reviewer")],
        )
        self.assertIn("outputs/AIR-1.md", output)
        self.assertIn("outputs/AIR-2.md", output)
        self.assertIn("drained=2\n", output)
        self.assertIn("drain_failed=0\n", output)

    def test_poison_request_is_skipped_not_fatal(self) -> None:
        # E3/F10 — AIR-1 fails and releases its claim; the kernel-side
        # exclusion steps past it and the night CONTINUES with AIR-2.
        # Pre-fix, "repeat_request" ended the entire drain here.
        queue = [
            {"request_id": "AIR-1", "target_agent": "aria-evidence-judge"},
            {"request_id": "AIR-2", "target_agent": "aria-evidence-judge"},
        ]
        rc, calls, output = _drain(
            queue, {"AIR-1": (1, False), "AIR-2": (0, True)}, tmp=self._tmp.name
        )
        self.assertEqual(rc, 1)  # the failure is still reported
        self.assertEqual(
            [rid for rid, _ in calls["dispatch"]], ["AIR-1", "AIR-2"]
        )
        self.assertIn("drained=1\n", output)
        self.assertIn("drain_failed=1\n", output)

    def test_priority_roles_run_before_judges(self) -> None:
        # D10b — an older judge request must NOT starve a younger
        # lane-unlocking request.
        queue = [
            {"request_id": "AIR-judge", "target_agent": "aria-evidence-judge", "role": "evidence_judgment"},
            {"request_id": "AIR-impl", "target_agent": "aria-implementer", "role": "implementation"},
        ]
        rc, calls, _ = _drain(
            queue,
            {"AIR-judge": (0, True), "AIR-impl": (0, True)},
            tmp=self._tmp.name,
        )
        self.assertEqual(rc, 0)
        self.assertEqual(
            [rid for rid, _ in calls["dispatch"]], ["AIR-impl", "AIR-judge"]
        )

    def test_max_requests_cap_is_real(self) -> None:
        queue = [
            {"request_id": f"AIR-{i}", "target_agent": "aria-evidence-judge"}
            for i in range(5)
        ]
        rc, calls, _ = _drain(
            queue,
            {f"AIR-{i}": (0, True) for i in range(5)},
            env={"MAX_REQUESTS_PER_RUN": "2"},
            tmp=self._tmp.name,
        )
        self.assertEqual(rc, 0)
        self.assertEqual(len(calls["dispatch"]), 2)

    def test_one_failure_makes_the_run_red_but_finishes_the_queue(self) -> None:
        queue = [
            {"request_id": "AIR-1", "target_agent": "aria-evidence-judge"},
            {"request_id": "AIR-2", "target_agent": "aria-evidence-judge"},
            None,
        ]
        rc, calls, output = _drain(
            queue,
            {"AIR-1": (1, False), "AIR-2": (0, True)},
            tmp=self._tmp.name,
        )
        self.assertEqual(rc, 1)
        self.assertEqual(len(calls["dispatch"]), 2)
        self.assertIn("drained=1\n", output)
        self.assertIn("drain_failed=1\n", output)

    def test_main_routes_drain_flag(self) -> None:
        with patch.object(ci_executor_drain, "drain_pending", return_value=0) as dp:
            rc = ci_executor.main(["--drain"])
        self.assertEqual(rc, 0)
        dp.assert_called_once()


if __name__ == "__main__":
    unittest.main()


class DrainBudgetWorstCaseTests(unittest.TestCase):
    """Run 31542485896 — the budget must price the NEXT child's worst case.

    Elapsed-only accounting started a request at t=1987s of a 2100s budget;
    that child could legally run 1800s more, sailed past the job reaper, and
    the run was cancelled before the state publish — two submitted results
    died with the runner. The loop now starts a child only when
    elapsed + MAX_TIMEOUT_SECONDS still fits inside the budget.
    """

    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def test_no_child_starts_when_worst_case_overflows_budget(self) -> None:
        queue = [
            {"request_id": "AIR-1", "target_agent": "aria-evidence-judge"},
        ]
        # Budget 100s, child worst case 1800s: even at elapsed=0 the worst
        # case cannot fit, so NOTHING is dispatched and the loop reports a
        # clean budget stop instead of gambling on a fast child.
        rc, calls, output = _drain(
            queue,
            {"AIR-1": (0, True)},
            env={
                "ARIA_DRAIN_BUDGET_SECONDS": "100",
                "MAX_TIMEOUT_SECONDS": "1800",
            },
            tmp=self._tmp.name,
        )
        self.assertEqual(rc, 0)
        self.assertEqual(calls["dispatch"], [])
        self.assertIn("drained=0\n", output)

    def test_child_starts_when_worst_case_fits(self) -> None:
        queue = [
            {"request_id": "AIR-1", "target_agent": "aria-evidence-judge"},
            None,
        ]
        rc, calls, _ = _drain(
            queue,
            {"AIR-1": (0, True)},
            env={
                "ARIA_DRAIN_BUDGET_SECONDS": "3600",
                "MAX_TIMEOUT_SECONDS": "1800",
            },
            tmp=self._tmp.name,
        )
        self.assertEqual(rc, 0)
        self.assertEqual(len(calls["dispatch"]), 1)
