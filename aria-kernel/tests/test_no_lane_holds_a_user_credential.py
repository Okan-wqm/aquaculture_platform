"""ARIA-CRITICAL-246 — no ARIA lane holds the operator's credential.

``ARIA_GH_TOKEN`` in the runner ``.env`` was the operator's PAT. The cycle and
executor kernel-run steps exported it as ``GH_TOKEN``, and the daily report
opened its PR with it, so ARIA's writes were authored as the operator. An
operator's act on GitHub is what an ``ARIA-APPROVE`` line is verified against.
The kernel now writes only on an installation token (``github_writes``). These
tests pin the lane side: no workflow or composite action reads the key, the
daily report's PR identity is the App token it mints, and the provisioner
reports the key as a fault while a runner still holds it.
"""
from __future__ import annotations

import unittest
from pathlib import Path
from typing import Any

import yaml  # type: ignore[import-untyped]

_REPO_ROOT = Path(__file__).resolve().parents[2]
_RETIRED = "ARIA_GH_TOKEN"


def _executable(text: str) -> str:
    # Comments are prose about the key, not reads of it.
    return "\n".join(line for line in text.splitlines() if not line.lstrip().startswith("#"))


def _ci_files() -> list[Path]:
    workflows = sorted((_REPO_ROOT / ".github/workflows").glob("*.y*ml"))
    actions = sorted((_REPO_ROOT / ".github/actions").glob("*/action.y*ml"))
    return workflows + actions


def _step(workflow: str, job: str, name: str) -> dict[str, Any]:
    jobs = yaml.safe_load((_REPO_ROOT / ".github/workflows" / workflow).read_text(encoding="utf-8"))["jobs"]
    return next(step for step in jobs[job]["steps"] if step.get("name") == name)


class NoLaneReadsTheOperatorsPat(unittest.TestCase):
    def test_no_ci_file_reads_the_retired_key(self) -> None:
        readers = [
            path.relative_to(_REPO_ROOT).as_posix()
            for path in _ci_files()
            if _RETIRED in _executable(path.read_text(encoding="utf-8"))
        ]
        self.assertEqual(readers, [])

    def test_the_kernel_run_steps_hold_the_job_token(self) -> None:
        # The ambient identity of both kernel lanes is the job token, a Bot.
        # A delivery mints its own App token; nothing falls back to a user.
        cycle = _step("aria-auto-cycle.yml", "cycle", "Run the nightly cycle under the resolved profile")
        executor = _step("aria-agent-executor.yml", "executor", "Run CI executor")
        for step in (cycle, executor):
            self.assertEqual(step["env"]["GH_TOKEN"], "${{ github.token }}", step["name"])
            self.assertEqual(step["env"]["ARIA_REQUIRE_MODE_A"], "true", step["name"])

    def test_the_daily_report_pr_is_opened_with_the_app_token_it_mints(self) -> None:
        mint = _step("aria-daily-report.yml", "commit-report", "Mint GitHub App installation token")
        self.assertEqual(mint["id"], "app_token")
        self.assertIn("mint_installation_token", mint["run"])
        self.assertIn('echo "::add-mask::${TOKEN}"', mint["run"])
        # Mode A or nothing: no ambient GH_TOKEN is copied into the author.
        self.assertEqual(mint["env"]["ARIA_REQUIRE_MODE_A"], "true")
        opened = _step("aria-daily-report.yml", "commit-report", "Open or update daily report PR")
        self.assertEqual(opened["env"]["GH_TOKEN"], "${{ steps.app_token.outputs.token }}")
        self.assertEqual(opened["env"]["PR_TOKEN_SOURCE"], "aria-github-app")
        # The token is revoked with its own value whatever the PR step did.
        revoke = _step("aria-daily-report.yml", "commit-report", "Revoke GitHub App installation token")
        self.assertTrue(revoke["if"].startswith("always()"), revoke["if"])
        self.assertEqual(revoke["env"]["GH_TOKEN"], "${{ steps.app_token.outputs.token }}")
        self.assertIn("gh api -X DELETE /installation/token", revoke["run"])

    def test_the_provisioner_reports_a_runner_that_still_holds_the_key(self) -> None:
        text = (_REPO_ROOT / "scripts/aria/provision_runner.sh").read_text(encoding="utf-8")
        loop = text[text.index(f"for key in {_RETIRED}; do"):]
        loop = loop[: loop.index("done")]
        present, absent = loop.split("else", 1)
        self.assertIn('bad "$key still in', present)
        self.assertIn('ok "$key absent', absent)


if __name__ == "__main__":
    unittest.main()
