from __future__ import annotations

import json
import importlib.util
import copy
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from aria_kernel.burn_in import (
    DISALLOWED_OBSERVE_SURFACES,
    _require_clean_worktree,
    run_observe_burn_in,
    validate_burn_in_report,
    verify_burn_in_artifact_bundle,
)
from aria_kernel.ledger import read_jsonl
from aria_kernel.tool_registry import GovernanceError
from aria_kernel.worktree import is_runtime_path as worktree_is_runtime_path


_helpers_path = Path(__file__).parent / "_helpers" / "git_fixtures.py"
_spec = importlib.util.spec_from_file_location("aria_kernel_test_helpers_git_fixtures_burn_in", _helpers_path)
git_fixtures = importlib.util.module_from_spec(_spec)
sys.modules["aria_kernel_test_helpers_git_fixtures_burn_in"] = git_fixtures
_spec.loader.exec_module(git_fixtures)


class ObserveBurnInTests(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory(prefix="aria-burn-in-")
        self.tmp = Path(self._tmp.name)
        self.repo = git_fixtures.make_repo_with_initial_commit(
            self.tmp,
            {
                "package.json": "{\"scripts\":{}}\n",
                "apps/api/src/main.ts": "export const api = true;\n",
                "docs/adr/001-seed.md": "# Seed\n",
            },
            name="repo",
        )
        self.tools_dir = self.tmp / "tools-root"
        self.workspace_base = self.tmp / "workspaces"
        self.output_dir = self.tools_dir / "burn-in" / "test-run"

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def test_observe_burn_in_runs_without_action_surfaces(self) -> None:
        report = run_observe_burn_in(
            workspace_root=self.repo,
            workspace_base=self.workspace_base,
            base_dir=self.tools_dir,
            target_ref="HEAD",
            cycles=30,
            min_valid_cycles=20,
            output_dir=self.output_dir,
        )

        self.assertEqual(report["schema_version"], "aria/autonomy-burn-in-report/v1")
        self.assertEqual(report["acceptance_verdict"], "passed")
        self.assertEqual(report["profile"], "observe")
        self.assertEqual(report["cycle_attempts"], 30)
        self.assertEqual(report["valid_cycles"], 30)
        self.assertEqual(report["disallowed_actions_observed"], [])
        self.assertIn("cycles.json", report["artifact_hashes"])
        self.assertTrue((self.output_dir / "evidence-bundle.json").exists())
        self.assertTrue((self.output_dir / "cycle-ledger-summary.json").exists())
        self.assertTrue((self.output_dir / "disallowed-actions.json").exists())
        self.assertTrue((self.output_dir / "manifest-tail-hashes.json").exists())
        self.assertTrue((self.output_dir / "autonomy-burn-in-report.json").exists())
        persisted = json.loads((self.output_dir / "autonomy-burn-in-report.json").read_text(encoding="utf-8"))
        self.assertEqual(persisted["acceptance_verdict"], "passed")
        self.assertTrue(persisted["evidence_bundle_hash"].startswith("sha256:"))
        bundle = json.loads((self.output_dir / "evidence-bundle.json").read_text(encoding="utf-8"))
        self.assertTrue(bundle["burn_in_report_hash"].startswith("sha256:"))
        verify_burn_in_artifact_bundle(self.output_dir)

        for _surface, relative in DISALLOWED_OBSERVE_SURFACES:
            if not relative.endswith(".jsonl"):
                continue
            self.assertEqual(read_jsonl(self.tools_dir / relative), [])

    def test_burn_in_report_schema_rejects_contradictory_pass(self) -> None:
        report = run_observe_burn_in(
            workspace_root=self.repo,
            workspace_base=self.workspace_base,
            base_dir=self.tools_dir,
            target_ref="HEAD",
            cycles=30,
            min_valid_cycles=20,
            output_dir=self.output_dir,
        )
        mismatch = copy.deepcopy(report)
        mismatch["cycles"][0]["valid_cycle"] = False
        with self.assertRaisesRegex(GovernanceError, "valid_cycle_count_mismatch"):
            validate_burn_in_report(mismatch)
        report["valid_cycles"] = 19
        with self.assertRaisesRegex(GovernanceError, "insufficient_valid_cycles"):
            validate_burn_in_report(report)

    def test_burn_in_bundle_hash_mismatch_rejects(self) -> None:
        run_observe_burn_in(
            workspace_root=self.repo,
            workspace_base=self.workspace_base,
            base_dir=self.tools_dir,
            target_ref="HEAD",
            cycles=30,
            min_valid_cycles=20,
            output_dir=self.output_dir,
        )
        bundle_path = self.output_dir / "evidence-bundle.json"
        payload = json.loads(bundle_path.read_text(encoding="utf-8"))
        payload["burn_in_report_hash"] = "sha256:" + "0" * 64
        bundle_path.write_text(json.dumps(payload), encoding="utf-8")
        with self.assertRaisesRegex(GovernanceError, "report_hash_mismatch"):
            verify_burn_in_artifact_bundle(self.output_dir)

    def test_observe_burn_in_rejects_short_acceptance(self) -> None:
        with self.assertRaisesRegex(GovernanceError, "requires_30_cycles"):
            run_observe_burn_in(
                workspace_root=self.repo,
                workspace_base=self.workspace_base,
                base_dir=self.tools_dir,
                target_ref="HEAD",
                cycles=1,
                min_valid_cycles=1,
                output_dir=self.output_dir,
            )

    def test_observe_burn_in_rejects_repo_local_tools_dir(self) -> None:
        with self.assertRaisesRegex(GovernanceError, "tools_dir_must_be_outside_workspace_root"):
            run_observe_burn_in(
                workspace_root=self.repo,
                workspace_base=self.workspace_base,
                base_dir=self.repo / "aria-tools",
                target_ref="HEAD",
                cycles=30,
                min_valid_cycles=20,
                output_dir=self.output_dir,
            )

    def test_observe_burn_in_rejects_unsafe_output_before_write(self) -> None:
        unsafe_output = self.repo / "burn-in-output"
        with self.assertRaisesRegex(GovernanceError, "output_dir_must_be_outside_workspace_root"):
            run_observe_burn_in(
                workspace_root=self.repo,
                workspace_base=self.workspace_base,
                base_dir=self.tools_dir,
                target_ref="HEAD",
                cycles=30,
                min_valid_cycles=20,
                output_dir=unsafe_output,
            )
        self.assertFalse(unsafe_output.exists())

    def test_observe_burn_in_rejects_dirty_worktree(self) -> None:
        (self.repo / "scratch.txt").write_text("dirty\n", encoding="utf-8")
        with self.assertRaisesRegex(GovernanceError, "pre_worktree_not_clean"):
            run_observe_burn_in(
                workspace_root=self.repo,
                workspace_base=self.workspace_base,
                base_dir=self.tools_dir,
                target_ref="HEAD",
                cycles=30,
                min_valid_cycles=20,
                output_dir=self.output_dir,
            )

    def test_clean_worktree_guard_ignores_the_kernels_own_runtime_writes(self) -> None:
        """A runtime write must not make the observe burn-in unstartable.

        The guard used to reject any porcelain output at all. Once
        `aria-tools/reports/daily/*.md` became trackable, `reflection` writes it
        every cycle, so the next burn-in dispatch died with
        `observe_burn_in_pre_worktree_not_clean` and produced zero ladder
        evidence — a gate defeating the thing it exists to measure. CI cannot
        see it either, because CI points the kernel at `.aria-ci/tools`.

        `_require_clean_worktree` is called directly rather than through
        `run_observe_burn_in`. Driving it through the public entry point made
        this assertion vacuous: `_validate_args` rejects the small cycle counts
        a fast test wants, so the guard was never reached and the test passed
        against the unfixed code too.
        """
        runtime_report = self.repo / "aria-tools" / "reports" / "daily" / "2099-01-01.md"
        runtime_report.parent.mkdir(parents=True, exist_ok=True)
        runtime_report.write_text("# anchor\n", encoding="utf-8")
        subprocess.run(
            ["git", "add", "-f", "aria-tools/reports/daily/2099-01-01.md"],
            cwd=self.repo, check=True, capture_output=True,
        )
        porcelain = subprocess.run(
            ["git", "status", "--porcelain"],
            cwd=self.repo, text=True, capture_output=True, check=True,
        ).stdout
        self.assertIn(
            "aria-tools/reports/daily/2099-01-01.md", porcelain,
            msg="fixture precondition: the runtime write must be visible to git",
        )
        _require_clean_worktree(self.repo, "pre")

    def test_clean_worktree_guard_still_rejects_a_dirty_source_tree(self) -> None:
        """Filtering runtime paths must not weaken the guard for source dirt."""
        (self.repo / "apps" / "api" / "src" / "main.ts").write_text(
            "export const api = false;\n", encoding="utf-8",
        )
        with self.assertRaisesRegex(GovernanceError, "pre_worktree_not_clean"):
            _require_clean_worktree(self.repo, "pre")

    def test_clean_worktree_guard_agrees_with_the_preflight_gate(self) -> None:
        """One definition of "clean" over one tree, not two.

        `worktree.preflight` already excluded runtime paths while this guard did
        not, so the same tree was clean to one gate and dirty to the other. The
        notion is now imported, and this pins that it stays imported rather than
        being restated and allowed to drift.
        """
        for line in (
            "A  aria-tools/reports/daily/2099-01-01.md",
            "?? aria-findings/F-999.json",
            " M aria-debts/DEBT-2026-01-01-001.json",
        ):
            self.assertTrue(
                worktree_is_runtime_path(line),
                msg=f"preflight treats this as runtime, the burn-in guard must too: {line!r}",
            )
        for line in (" M apps/api/src/main.ts", "?? scratch.txt"):
            self.assertFalse(worktree_is_runtime_path(line))

    def test_observe_burn_in_rejects_target_ref_mismatch(self) -> None:
        first_head = subprocess.run(
            ["git", "rev-parse", "HEAD"],
            cwd=self.repo,
            text=True,
            capture_output=True,
            check=True,
        ).stdout.strip()
        (self.repo / "README.md").write_text("next\n", encoding="utf-8")
        subprocess.run(["git", "add", "README.md"], cwd=self.repo, check=True)
        subprocess.run(
            ["git", "commit", "-q", "-m", "fixture: next"],
            cwd=self.repo,
            check=True,
        )

        with self.assertRaisesRegex(GovernanceError, "target_ref_mismatch"):
            run_observe_burn_in(
                workspace_root=self.repo,
                workspace_base=self.workspace_base,
                base_dir=self.tools_dir,
                target_ref=first_head,
                cycles=30,
                min_valid_cycles=20,
                output_dir=self.output_dir,
            )


if __name__ == "__main__":
    unittest.main()
