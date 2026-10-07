"""The readiness claim's DLP diff surface is a real unified diff of the PR.

WHY THIS EXISTS. ``produce_dlp_proof`` refuses a diff surface that does not
name every file the head commit touched (ARIA-AUDIT-022: scope is proven,
not promised). The claim lane fed it ``gh api compare --jq
'.files[].patch'`` — hunk bodies only, no ``diff --git a/<path> b/<path>``
headers — so a file name reached the scanned text only when the file's own
content happened to spell it. 37 of the 44 aria-readiness-claim failures on
2026-10-04 were ``dlp_diff_surface_incomplete`` (e.g. run 37221868753, PR
#1779), and the lane had not produced one claim since it was wired.

The surface is now built by the kernel from the same object store its scope
check reads (``git diff <base>...<head>``), so the scanned text and the
verifier's touched-file set come from one source and cannot disagree on
file names. These tests pin both halves: the headless patch shape is
refused (the defect, reproduced), and the git-built surface passes the
verifier's own scope check.
"""
from __future__ import annotations

import json
import subprocess
import tempfile
import unittest
from pathlib import Path

from aria_kernel.tool_registry import GovernanceError, ensure_tools_dir

_REPO = Path(__file__).resolve().parents[2]


def _git(repo: Path, *args: str) -> str:
    return subprocess.run(
        ["git", *args], cwd=repo, check=True, capture_output=True, text=True,
    ).stdout.strip()


class DiffSurfaceTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        self.tools = root / "aria-tools"
        ensure_tools_dir(self.tools)
        self.repo = root / "workspace"
        self.repo.mkdir()
        _git(self.repo, "init", "-q", "-b", "main")
        _git(self.repo, "config", "user.email", "t@example.invalid")
        _git(self.repo, "config", "user.name", "T")
        (self.repo / "seed.txt").write_text("seed\n", encoding="utf-8")
        _git(self.repo, "add", ".")
        _git(self.repo, "commit", "-q", "-m", "seed")
        self.base_sha = _git(self.repo, "rev-parse", "HEAD")
        _git(self.repo, "checkout", "-q", "-b", "feat/x")
        # Neither file's CONTENT spells its own path — exactly the shape a
        # headless patch cannot cover.
        (self.repo / ".github" / "workflows").mkdir(parents=True)
        (self.repo / ".github" / "workflows" / "lane.yml").write_text(
            "name: lane\non: push\n", encoding="utf-8",
        )
        (self.repo / "seed.txt").write_text("seed\nchanged\n", encoding="utf-8")
        _git(self.repo, "add", ".")
        _git(self.repo, "commit", "-q", "-m", "change")
        self.head_sha = _git(self.repo, "rev-parse", "HEAD")
        self.evidence = root / "evidence"
        self.evidence.mkdir()
        self.surfaces: dict[str, list[Path]] = {}
        for surface in ("prompt", "transcript", "logs", "artifacts"):
            path = self.evidence / f"{surface}.txt"
            path.write_text(f"clean {surface} content\n", encoding="utf-8")
            self.surfaces[surface] = [path]

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def _dlp_kwargs(self) -> dict:
        return dict(
            pr_number=77, repo="okan/aqua", target_ref="main",
            head_ref="feat/x", head_sha=self.head_sha,
            readiness_claim_id="claim:77:" + self.head_sha[:12],
            workflow_run_id="123456", artifact_id="artifact-1",
            artifact_sha256="sha256:" + "b" * 64,
            workflow_hash="sha256:" + "c" * 64,
            contract_hash="sha256:" + "d" * 64,
            network_policy="github_artifact,github_git",
            runtime_write_paths=["^\\.aria-state-store(/.*)?$"],
            base_dir=self.tools,
            workspace_root=self.repo,
        )

    def test_a_headless_patch_is_refused_by_the_scope_check(self) -> None:
        """The defect, reproduced: hunk bodies without file headers."""
        from aria_kernel.readiness_proofs import produce_dlp_proof

        headless = self.evidence / "compare.patch"
        headless.write_text(
            "@@ -0,0 +1,2 @@\n+name: lane\n+on: push\n"
            "@@ -1 +1,2 @@\n seed\n+changed\n",
            encoding="utf-8",
        )
        with self.assertRaisesRegex(GovernanceError, "dlp_diff_surface_incomplete"):
            produce_dlp_proof(
                **self._dlp_kwargs(),
                surface_paths={**self.surfaces, "diff": [headless]},
            )

    def test_the_git_built_surface_passes_the_scope_check(self) -> None:
        from aria_kernel.readiness_diff_surface import build_diff_surface
        from aria_kernel.readiness_proofs import produce_dlp_proof

        output = self.evidence / "compare.patch"
        built = build_diff_surface(
            workspace_root=self.repo, base_sha=self.base_sha,
            head_sha=self.head_sha, output_path=output,
        )
        text = output.read_text(encoding="utf-8")
        self.assertIn("diff --git a/.github/workflows/lane.yml b/.github/workflows/lane.yml", text)
        self.assertIn("diff --git a/seed.txt b/seed.txt", text)
        self.assertEqual(built["file_count"], 2)
        self.assertEqual(built["base_sha"], self.base_sha)
        self.assertEqual(built["head_sha"], self.head_sha)
        self.assertTrue(built["sha256"].startswith("sha256:"))

        report = produce_dlp_proof(
            **self._dlp_kwargs(), surface_paths={**self.surfaces, "diff": [output]},
        )
        self.assertEqual(report["status"], "passed")

    def test_a_secret_anywhere_in_the_pr_reaches_the_scan(self) -> None:
        """The surface is the PR's content, not a caller-chosen excerpt."""
        from aria_kernel.readiness_diff_surface import build_diff_surface
        from aria_kernel.readiness_proofs import produce_dlp_proof

        secret = "ghp_" + "Z9y8X7w6" * 4
        (self.repo / "config.env.example").write_text(f"TOKEN={secret}\n", encoding="utf-8")
        _git(self.repo, "add", ".")
        _git(self.repo, "commit", "-q", "-m", "leak")
        self.head_sha = _git(self.repo, "rev-parse", "HEAD")
        output = self.evidence / "compare.patch"
        build_diff_surface(
            workspace_root=self.repo, base_sha=self.base_sha,
            head_sha=self.head_sha, output_path=output,
        )
        report = produce_dlp_proof(
            **self._dlp_kwargs(), surface_paths={**self.surfaces, "diff": [output]},
        )
        self.assertEqual(report["status"], "failed")
        self.assertNotIn(secret, json.dumps(report["snapshot"], default=str))

    def test_an_unresolvable_head_fails_closed(self) -> None:
        from aria_kernel.readiness_diff_surface import build_diff_surface

        output = self.evidence / "compare.patch"
        with self.assertRaisesRegex(GovernanceError, "dlp_diff_surface_commit_unresolvable:head"):
            build_diff_surface(
                workspace_root=self.repo, base_sha=self.base_sha,
                head_sha="f" * 40, output_path=output,
            )
        self.assertFalse(output.exists())

    def test_a_non_sha_revision_is_refused(self) -> None:
        """Only full object ids: a ref name is a moving target, and an
        option-shaped value must never reach git's argv."""
        from aria_kernel.readiness_diff_surface import build_diff_surface

        for bad in ("main", "--output=/tmp/x", self.head_sha[:12]):
            with self.assertRaisesRegex(GovernanceError, "dlp_diff_surface_sha_invalid"):
                build_diff_surface(
                    workspace_root=self.repo, base_sha=self.base_sha,
                    head_sha=bad, output_path=self.evidence / "x.patch",
                )

    def test_the_cli_writes_the_surface_and_reports_it(self) -> None:
        import contextlib
        import io

        from aria_kernel.cli import main as cli_main

        output = self.evidence / "compare.patch"
        stdout = io.StringIO()
        with contextlib.redirect_stdout(stdout):
            rc = cli_main([
                "readiness", "build-diff-surface",
                "--workspace-root", str(self.repo),
                "--base-sha", self.base_sha,
                "--head-sha", self.head_sha,
                "--output", str(output),
            ])
        self.assertEqual(rc or 0, 0)
        self.assertEqual(json.loads(stdout.getvalue())["file_count"], 2)
        self.assertIn("diff --git a/seed.txt b/seed.txt", output.read_text(encoding="utf-8"))


class ClaimLaneUsesTheKernelSurfaceTests(unittest.TestCase):
    """The lane must hand the verifier the kernel-built surface."""

    def setUp(self) -> None:
        self.workflow = (_REPO / ".github" / "workflows" / "aria-readiness-claim.yml").read_text(
            encoding="utf-8",
        )

    def test_the_diff_surface_is_built_by_the_kernel(self) -> None:
        self.assertIn("readiness build-diff-surface", self.workflow)
        self.assertIn('--output "${work}/compare.patch"', self.workflow)

    def test_the_headless_compare_patch_is_gone(self) -> None:
        self.assertNotIn(".files[].patch", self.workflow)


if __name__ == "__main__":
    unittest.main()
