"""ARIA-HIGH-005 (Task 8) — the pre-merge evidence is an immutable snapshot.

The merge owner captures the native identities the pre-merge perimeter
judges (``merge_authority._capture_pre_merge_context``) into one frozen
``implementation_safety._PreMergeEvidence``. These tests pin the Task-8
properties at their real entry points:

* the snapshot cannot be mutated after capture;
* it cannot be forged by constructing the dataclass directly — only the
  capture (and the workspace-refusal branch beside it) holds the
  construction token, exactly as ``HardFailReport`` is built only by the
  registry;
* a source that changes between the capture's first read and its
  in-transaction re-check makes the snapshot unavailable by name
  (``native_context_changed_during_capture``), and the perimeter refuses;
* an incomplete join is a named unavailable reason, never ``available``;
* a PR head that moves between the green evaluation and the fresh re-read
  is refused before the perimeter and the merge call;
* the merge call is bound to the evaluated head (``expected_head_sha``).

The capture fixture is production-shaped: a real git repository, a real
converged plan, real change-ledger and PR-lifecycle rows, and the real
capture function. The concurrent writer is the real PR-lifecycle recorder,
run at the seam between the first read and the re-check.
"""
from __future__ import annotations

import dataclasses
import os
import subprocess
import tempfile
import unittest
from pathlib import Path
from typing import Any
from unittest.mock import patch

import aria_kernel.merge_authority as merge_owner
from aria_kernel.implementation_safety import (
    GATE_PRE_MERGE,
    ForgedVerdict,
    HardFailContext,
    _PreMergeEvidence,
    run_hard_fail_checks,
)
from aria_kernel.merge_authority import merge_pr_if_ready
from aria_kernel.tool_registry import ensure_tools_dir
from tests._helpers.operator_acts import operator_set_profile
from tests.test_merge_authority_pre_merge_perimeter import _SHA, _gate_patches

_SOURCE_PATH = "apps/farm-service/src/sample-interval.ts"


class _NativeCapture:
    """A real store, repository and PR the capture can join end to end.

    The change has no implementation request (it was not made by the
    executor), so the capture runs every read, the re-check transaction and
    the snapshot, and names the one join it cannot make.
    """

    def __init__(self, test: unittest.TestCase) -> None:
        from aria_kernel.auto_merge import record_pr_lifecycle
        from aria_kernel.change_ledger import emit_change_committed, emit_change_planned
        from aria_kernel.tool_registry import ensure_tools_binding
        from tests._helpers.git_fixtures import make_repo_with_initial_commit
        from tests._helpers.production_shaped import production_converged_plan

        directory = tempfile.TemporaryDirectory(prefix="aria-pre-merge-evidence-")
        test.addCleanup(directory.cleanup)
        root = Path(directory.name)
        environment = patch.dict(os.environ, {
            "ARIA_REPO_STATE_ROOT": str(root / "repo-state"),
            "ARIA_STATE_STORE_ROOT": str(root / "state-store"),
            "ARIA_WORKSPACE_BASE": str(root / "workspaces"),
            "ARIA_TOOLS_DIR": str(root / "store" / "tools"),
        })
        environment.start()
        test.addCleanup(environment.stop)
        self.repo = make_repo_with_initial_commit(root, {
            _SOURCE_PATH: "export const sampleIntervalMs = 30000;\n",
        })
        self.tools = root / "store" / "tools"
        operator_set_profile("strict", base_dir=self.tools)
        ensure_tools_binding(self.tools, workspace_root=self.repo)
        plan = production_converged_plan(
            tools_dir=self.tools, workspace_root=self.repo,
            plan_id="plan-pre-merge-evidence", affected_paths=[_SOURCE_PATH],
            evidence_refs=[_SOURCE_PATH],
        )
        self.git("add", ".claude/agents/farm-expert.md")
        self.git("commit", "-q", "-m", "fixture: commit the real plan reviewer")
        self.git("branch", "-M", "main")
        self.base_sha = self.git("rev-parse", "HEAD")
        planned = emit_change_planned(
            plan_id=plan.plan_id, finding_id="F-pre-merge-evidence",
            intended_affected_files=[_SOURCE_PATH], intended_validation_refs=[],
            architectural_tier=1, base_dir=self.tools,
        )
        self.git("checkout", "-q", "-b", "aria/pre-merge-evidence")
        (self.repo / _SOURCE_PATH).write_text("export const sampleIntervalMs = 15000;\n", encoding="utf-8")
        self.git("add", _SOURCE_PATH)
        self.git("commit", "-q", "-m", "fixture: change the declared sample interval")
        self.head_sha = self.git("rev-parse", "HEAD")
        emit_change_committed(
            change_id=planned["change_id"], commit_sha=self.head_sha,
            actual_affected_files=[_SOURCE_PATH], base_dir=self.tools,
        )
        opener = {
            "number": 731, "base_branch": "main", "base_sha": self.base_sha,
            "head_ref": "aria/pre-merge-evidence", "head_sha": self.head_sha,
            "changed_files": [_SOURCE_PATH], "change_id": planned["change_id"],
            "body": "Apply the converged sample-interval change.",
        }
        record_pr_lifecycle(opener, event="opened", base_dir=self.tools)
        self.pr = {key: value for key, value in opener.items() if key != "change_id"}
        record_pr_lifecycle(self.pr, event="observed", base_dir=self.tools)
        self.change_id = planned["change_id"]

    def git(self, *argv: str) -> str:
        return subprocess.check_output(["git", *argv], cwd=self.repo, text=True).strip()

    def capture(self) -> HardFailContext:
        return merge_owner._capture_pre_merge_context(
            workspace_root=self.repo, base_dir=self.tools, pr=self.pr,
            diff_text=self.git("diff", self.base_sha, self.head_sha),
        )


class SnapshotShapeTests(unittest.TestCase):
    def test_a_captured_snapshot_cannot_be_mutated(self) -> None:
        evidence = _NativeCapture(self).capture().pre_merge_evidence
        self.assertIsNotNone(evidence)
        with self.assertRaises(dataclasses.FrozenInstanceError):
            evidence.head_sha = "c" * 40  # type: ignore[misc]
        with self.assertRaises(dataclasses.FrozenInstanceError):
            evidence.unavailable_reasons = ()  # type: ignore[misc]

    def test_direct_construction_is_refused_as_a_forged_verdict(self) -> None:
        # Task 8: a caller cannot forge a snapshot by instantiating fields
        # directly. The all-present shape below is what every predicate
        # reads as a bound implementation.
        bound = {
            "repo_identity": "repo", "snapshot_hash": "sha256:snap", "pr_row_hash": "sha256:pr",
            "planned_row_hash": "sha256:planned", "committed_row_hash": "sha256:committed",
            "request_id": "AIR-1", "claim_id": "claim-1", "request_row_hash": "sha256:req",
            "claim_row_hash": "sha256:claim", "result_row_hash": "sha256:res",
            "implementation_event_hash": "sha256:evt", "head_sha": _SHA, "base_sha": "b" * 40,
        }
        with self.assertRaisesRegex(ForgedVerdict, "forged_perimeter_verdict:_PreMergeEvidence"):
            _PreMergeEvidence((), **bound)
        with self.assertRaisesRegex(ForgedVerdict, "forged_perimeter_verdict:_PreMergeEvidence"):
            _PreMergeEvidence(("workspace_root_unavailable",))
        with self.assertRaisesRegex(ForgedVerdict, "forged_perimeter_verdict:_PreMergeEvidence"):
            _PreMergeEvidence((), _token=object(), **bound)

    def test_the_capture_is_the_producer(self) -> None:
        # The producer path constructs without refusal and returns the
        # snapshot bound to the PR it read.
        fixture = _NativeCapture(self)
        evidence = fixture.capture().pre_merge_evidence
        self.assertEqual(evidence.pr_number, 731)
        self.assertEqual(evidence.change_id, fixture.change_id)
        self.assertEqual(evidence.head_sha, fixture.head_sha)
        self.assertEqual(evidence.base_sha, fixture.base_sha)
        self.assertRegex(str(evidence.snapshot_hash), r"^sha256:[0-9a-f]{64}$")


class IncompleteJoinTests(unittest.TestCase):
    def test_no_workspace_is_a_named_gap(self) -> None:
        directory = tempfile.TemporaryDirectory(prefix="aria-pre-merge-evidence-tools-")
        self.addCleanup(directory.cleanup)
        tools = Path(directory.name)
        ensure_tools_dir(tools)
        context = merge_owner._capture_pre_merge_context(
            workspace_root=None, base_dir=tools, pr={"number": 7}, diff_text=None,
        )
        evidence = context.pre_merge_evidence
        self.assertFalse(evidence.available)
        self.assertEqual(evidence.unavailable_reasons, ("workspace_root_unavailable",))

    def test_a_missing_implementation_request_is_named_never_available(self) -> None:
        evidence = _NativeCapture(self).capture().pre_merge_evidence
        self.assertFalse(evidence.available)
        self.assertIn("implementation_request_unavailable", evidence.unavailable_reasons)
        self.assertTrue(all(isinstance(reason, str) and reason for reason in evidence.unavailable_reasons))


class CaptureRecheckTests(unittest.TestCase):
    """The capture's first read and its in-transaction re-check must agree."""

    def _capture_with_a_write_between_the_reads(self, fixture: _NativeCapture) -> HardFailContext:
        from aria_kernel.auto_merge import record_pr_lifecycle

        real_join = merge_owner._join_pre_merge_implementation
        writes: list[str] = []

        def join_then_another_writer_appends(**kwargs: Any):
            joined = real_join(**kwargs)
            # Another lane records what it saw of the PR while the capture
            # is between its first read and its re-check.
            row = record_pr_lifecycle(dict(fixture.pr), event="observed", base_dir=fixture.tools)
            writes.append(row["ledger_hash"])
            return joined

        with patch.object(merge_owner, "_join_pre_merge_implementation", join_then_another_writer_appends):
            context = fixture.capture()
        self.assertEqual(len(writes), 1, "the concurrent writer did not run between the reads")
        return context

    def test_a_ledger_that_moved_during_capture_makes_the_snapshot_unavailable(self) -> None:
        fixture = _NativeCapture(self)
        context = self._capture_with_a_write_between_the_reads(fixture)
        evidence = context.pre_merge_evidence
        self.assertFalse(evidence.available)
        self.assertEqual(evidence.unavailable_reasons, ("native_context_changed_during_capture",))
        # Nothing bound survives a changed source: no half-captured identity.
        self.assertIsNone(evidence.change_id)
        self.assertIsNone(evidence.snapshot_hash)
        report = run_hard_fail_checks(context, gate=GATE_PRE_MERGE)
        self.assertFalse(report.passed)
        self.assertTrue(report.failures)

    def test_an_unchanged_source_passes_the_recheck(self) -> None:
        # Control: the same capture with no writer between the reads keeps
        # its join (only the request it never had is named).
        evidence = _NativeCapture(self).capture().pre_merge_evidence
        self.assertNotIn("native_context_changed_during_capture", evidence.unavailable_reasons)
        self.assertIsNotNone(evidence.change_id)


class _RecordingAdapter:
    def __init__(self) -> None:
        self.merge_calls: list[dict[str, Any]] = []

    def get_pr(self, pr_number: int) -> dict:
        return {
            "number": pr_number, "state": "OPEN", "repository": "okan/aqua",
            "base_branch": "main", "head_ref": "feat/x", "head_sha": _SHA,
            "changed_files": ["aria-kernel/aria_kernel/merge_authority.py"],
        }

    def merge_pr(self, pr_number: int, **kwargs: Any) -> dict:
        self.merge_calls.append({"pr_number": pr_number, **kwargs})
        return {"merged": True, "merge_commit_sha": "c" * 40}

    def get_pr_diff(self, pr_number: int) -> tuple[str | None, str | None]:
        # The Protocol's required read (ARIA-MEDIUM-581); this fixture's PR
        # carries no diff, and says so by name.
        return None, "fixture_pr_diff_absent"

    def get_open_issues(self, *, labels: list[str]) -> dict:
        return {"readable": True, "issues": []}


class MergeBindingTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.tools = Path(self.tmp.name) / "aria-tools"
        ensure_tools_dir(self.tools)

    def _run(self, adapter: _RecordingAdapter, extra: list) -> dict:
        patches = _gate_patches() + extra
        for item in patches:
            item.start()
        try:
            return merge_pr_if_ready(
                adapter=adapter, pr_number=77, base_dir=self.tools,
                readiness_claim_id="claim:77:aaaaaaaaaaaa",
                intent_publisher=lambda intent: {"published": True},
            )
        finally:
            for item in reversed(patches):
                item.stop()

    def test_a_head_that_moved_after_the_green_evaluation_is_refused_before_the_perimeter(self) -> None:
        adapter = _RecordingAdapter()
        moved = "c" * 40
        perimeter = patch.object(merge_owner, "_evaluate_pre_merge_perimeter")
        fresh = patch(
            "aria_kernel.merge_authority.evaluate_auto_merge",
            return_value={"eligible": True, "head_sha": moved},
        )
        with perimeter as evaluated:
            result = self._run(adapter, [fresh])
        self.assertEqual(result["decision"], "blocked")
        self.assertEqual(result["stage"], "pre_merge_re_evaluation")
        self.assertEqual(result["reasons"], ["PR head SHA changed after green evaluation"])
        self.assertEqual(result["latest_head_sha"], moved)
        evaluated.assert_not_called()
        self.assertEqual(adapter.merge_calls, [])

    def test_the_merge_is_bound_to_the_evaluated_head(self) -> None:
        adapter = _RecordingAdapter()
        passing = patch(
            "aria_kernel.merge_authority.run_hard_fail_checks",
            return_value=type("Report", (), {"passed": True, "failures": ()})(),
        )
        result = self._run(adapter, [passing])
        self.assertEqual(result["decision"], "merged")
        self.assertEqual(len(adapter.merge_calls), 1)
        self.assertEqual(adapter.merge_calls[0]["expected_head_sha"], _SHA)
        self.assertEqual(adapter.merge_calls[0]["method"], "squash")


if __name__ == "__main__":
    unittest.main()
