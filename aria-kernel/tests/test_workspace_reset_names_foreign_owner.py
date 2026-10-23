"""ARIA-HIGH-426 — the lanes' workspace reset names what it cannot remove.

The reset step of every self-hosted ARIA job (``aria-auto-cycle.yml`` and
``aria-agent-executor.yml``) — the job's first WORK step since
ARIA-MEDIUM-277 put the host workspace lock ahead of it — was ``set -euo
pipefail; git reset --hard; git clean -ffdx -e node_modules``. On 2026-10-08
a root-run rescue publish left root-owned files in the runner's workspace.
``git clean`` exits 1 on an entry it cannot remove, so every job failed
there, red and anonymous, from 19:24Z until an operator chowned the tree at
about 06:02Z.

Pins, on the step body exactly as the workflows carry it:

* both workflows carry one identical body (it runs before checkout, so no
  repository action or script can hold the single copy; the workspace-lock
  step ahead of it holds no part of this body);
* a path another account owns fails the step with a ``::error`` that counts
  and names it, the job summary lists it, and the remedy names
  ``sudo -u <runner>``. This runs only where the suite can create such a path:
  as root, the step itself runs as ``nobody``;
* an unremovable path the runner owns fails with the other ``::error``;
* a clean reset still removes untracked files and keeps ``node_modules``.
"""
from __future__ import annotations

import os
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

import yaml

_REPO = Path(__file__).resolve().parents[2]
_WORKFLOWS = ("aria-auto-cycle.yml", "aria-agent-executor.yml")
_STEP = "Reset the persistent workspace, keeping installed dependencies"
_NOBODY = 65534


def _reset_bodies() -> dict[str, str]:
    bodies: dict[str, str] = {}
    for name in _WORKFLOWS:
        workflow = yaml.safe_load((_REPO / ".github" / "workflows" / name).read_text(encoding="utf-8"))
        steps = [step for job in workflow["jobs"].values() for step in job.get("steps", [])
                 if step.get("name") == _STEP]
        assert len(steps) == 1, (name, len(steps))
        bodies[name] = steps[0]["run"]
    return bodies


class OneBodyInBothLanes(unittest.TestCase):
    def test_both_workflows_carry_the_same_diagnosing_reset(self) -> None:
        bodies = _reset_bodies()
        self.assertEqual(len(set(bodies.values())), 1, "the two reset bodies drifted apart")
        body = next(iter(bodies.values()))
        self.assertIn("git clean -ffdx -e node_modules", body)
        self.assertIn("::error title=Foreign-owned files in the persistent workspace::", body)
        self.assertIn("sudo -u ${me}", body)


class TheResetNamesWhatItCannotRemove(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="aria-426-reset-")).resolve()
        self.addCleanup(self._cleanup)
        self.as_nobody = os.geteuid() == 0
        self.tmp.chmod(0o755)
        self.repo = self.tmp / "workspace"
        self.runner_temp = self.tmp / "runner-temp"
        self.runner_temp.mkdir()
        self.summary = self.runner_temp / "summary.md"
        self.summary.write_text("", encoding="utf-8")
        subprocess.run(["git", "init", "-q", str(self.repo)], check=True, capture_output=True)
        for args in (["config", "user.email", "t@example.invalid"], ["config", "user.name", "t"]):
            subprocess.run(["git", "-C", str(self.repo), *args], check=True, capture_output=True)
        (self.repo / "tracked.txt").write_text("tracked\n", encoding="utf-8")
        subprocess.run(["git", "-C", str(self.repo), "add", "tracked.txt"], check=True, capture_output=True)
        subprocess.run(["git", "-C", str(self.repo), "commit", "-q", "-m", "fixture"], check=True, capture_output=True)

    def _cleanup(self) -> None:
        subprocess.run(["chmod", "-R", "u+w", str(self.tmp)], check=False, capture_output=True)
        shutil.rmtree(self.tmp, ignore_errors=True)

    def hand_to_runner(self) -> None:
        """The workspace and RUNNER_TEMP belong to the account the step runs as."""
        if self.as_nobody:
            subprocess.run(["chown", "-R", f"{_NOBODY}:{_NOBODY}", str(self.repo), str(self.runner_temp)],
                           check=True)

    def run_reset(self) -> subprocess.CompletedProcess[str]:
        body = next(iter(_reset_bodies().values()))
        env = {"PATH": os.environ.get("PATH", "/usr/bin:/bin"), "HOME": str(self.runner_temp),
               "RUNNER_TEMP": str(self.runner_temp), "GITHUB_WORKSPACE": str(self.repo),
               "GITHUB_STEP_SUMMARY": str(self.summary)}
        argv = ["bash", "-c", body]
        if self.as_nobody:
            argv = ["setpriv", f"--reuid={_NOBODY}", f"--regid={_NOBODY}", "--clear-groups", *argv]
        return subprocess.run(argv, cwd=self.repo, env=env, text=True, capture_output=True, timeout=60)

    def test_a_clean_reset_keeps_node_modules_and_removes_the_rest(self) -> None:
        (self.repo / "node_modules").mkdir()
        (self.repo / "node_modules" / "kept.js").write_text("x", encoding="utf-8")
        (self.repo / ".aria-state-store").mkdir()
        (self.repo / ".aria-state-store" / "row.jsonl").write_text("{}", encoding="utf-8")
        self.hand_to_runner()
        result = self.run_reset()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertTrue((self.repo / "node_modules" / "kept.js").exists())
        self.assertFalse((self.repo / ".aria-state-store").exists())

    @unittest.skipUnless(os.geteuid() == 0, "only root can leave a path another account owns")
    def test_a_path_another_account_owns_is_named_with_the_remedy(self) -> None:
        stuck = self.repo / ".aria-state-store" / "tools"
        stuck.mkdir(parents=True)
        (stuck / "governance.jsonl").write_text("{}", encoding="utf-8")
        self.hand_to_runner()
        # What the 2026-10-08 rescue publish left: root's files in the runner's tree.
        subprocess.run(["chown", "-R", "0:0", str(self.repo / ".aria-state-store")], check=True)
        result = self.run_reset()
        self.assertEqual(result.returncode, 1)
        self.assertIn("::error title=Foreign-owned files in the persistent workspace::", result.stdout)
        self.assertIn("are not owned by nobody", result.stdout)
        self.assertIn("sudo -u nobody", result.stdout)
        self.assertIn("root ./.aria-state-store/tools/governance.jsonl", result.stdout)
        self.assertIn("./.aria-state-store/tools/governance.jsonl", self.summary.read_text(encoding="utf-8"))

    def test_an_unremovable_path_the_runner_owns_fails_with_the_other_error(self) -> None:
        stuck = self.repo / "stuck"
        stuck.mkdir()
        (stuck / "file.txt").write_text("x", encoding="utf-8")
        self.hand_to_runner()
        stuck.chmod(0o555)
        result = self.run_reset()
        self.assertEqual(result.returncode, 1)
        self.assertIn("::error title=Persistent workspace reset failed::", result.stdout)
        self.assertNotIn("Foreign-owned", result.stdout)


if __name__ == "__main__":
    unittest.main()
