from __future__ import annotations

import io
import json
import subprocess
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path

from aria_kernel.burn_in import (
    EVIDENCE_NAME,
    MANIFEST_NAME,
    REPORT_NAME,
    run_observe_burn_in,
    verify_burn_in_artifact_bundle,
)
from aria_kernel.cli import main as cli_main


def _git(repo: Path, *args: str) -> str:
    return subprocess.check_output(["git", *args], cwd=repo, text=True).strip()


class BurnInProofTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.repo = self.root / "repo"
        self.repo.mkdir()
        _git(self.repo, "init", "-q", "-b", "main")
        _git(self.repo, "config", "user.email", "aria@example.invalid")
        _git(self.repo, "config", "user.name", "ARIA Test")
        (self.repo / "README.md").write_text("burn in\n", encoding="utf-8")
        _git(self.repo, "add", "README.md")
        _git(self.repo, "commit", "-q", "-m", "initial")
        self.head = _git(self.repo, "rev-parse", "HEAD")
        self.tools = self.root / "aria-tools"
        self.workspace_base = self.root / "workspaces"
        self.out = self.tools / "burn-in" / "run"

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def test_observe_burn_in_writes_v2_manifest_and_verifies(self) -> None:
        report = run_observe_burn_in(
            tools_dir=self.tools,
            workspace_root=self.repo,
            workspace_base=self.workspace_base,
            target_ref=self.head,
            cycles=3,
            min_valid_cycles=2,
            output_dir=self.out,
        )
        self.assertEqual(report["acceptance_verdict"], "pass")
        for name in (REPORT_NAME, EVIDENCE_NAME, MANIFEST_NAME):
            self.assertTrue((self.out / name).is_file(), name)
        manifest = json.loads((self.out / MANIFEST_NAME).read_text(encoding="utf-8"))
        self.assertEqual(manifest["schema_version"], 2)
        self.assertTrue(manifest["contract_hash"])
        self.assertTrue(manifest["workflow_hash"])
        self.assertTrue(manifest["upload"]["name"])
        self.assertEqual(
            {Path(item["path"]).name for item in manifest["artifacts"]},
            {REPORT_NAME, EVIDENCE_NAME},
        )
        verifier = verify_burn_in_artifact_bundle(self.out)
        self.assertEqual(verifier["status"], "ok")
        self.assertEqual(verifier["target_sha"], self.head)

    def test_artifact_swap_fails_closed(self) -> None:
        run_observe_burn_in(
            tools_dir=self.tools,
            workspace_root=self.repo,
            workspace_base=self.workspace_base,
            target_ref=self.head,
            cycles=2,
            min_valid_cycles=2,
            output_dir=self.out,
        )
        report = json.loads((self.out / REPORT_NAME).read_text(encoding="utf-8"))
        report["valid_cycles"] = 999
        (self.out / REPORT_NAME).write_text(
            json.dumps(report, indent=2, sort_keys=True) + "\n",
            encoding="utf-8",
        )
        with self.assertRaisesRegex(Exception, "burn_in_manifest_hash_mismatch"):
            verify_burn_in_artifact_bundle(self.out)

    def test_cli_observe_command_prints_report(self) -> None:
        with redirect_stdout(io.StringIO()) as buf:
            rc = cli_main([
                "--tools-dir", str(self.tools),
                "autonomy", "burn-in", "observe",
                "--workspace-root", str(self.repo),
                "--workspace-base", str(self.workspace_base),
                "--target-ref", self.head,
                "--cycles", "2",
                "--min-valid-cycles", "2",
                "--output-dir", str(self.out),
            ])
        self.assertEqual(rc, 0)
        payload = json.loads(buf.getvalue())
        self.assertEqual(payload["acceptance_verdict"], "pass")
        self.assertEqual(payload["target_sha"], self.head)


if __name__ == "__main__":
    unittest.main()
