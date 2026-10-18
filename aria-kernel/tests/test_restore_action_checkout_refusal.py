"""ARIA-LOW-577/578 — a lineage refusal reaches the operator as a refusal.

The ARIA-HIGH-572 purge investigation replaced the remote ``aria/state`` tip
with a commit that has a new root. A host that had tracked the old lineage
refused it, but by raising the transport class (``StateStoreError``), so
``state checkout`` exited 1 and the restore action printed "failed to reach
the remote" and "wrote no verdict": a verdict on the state's lineage was
reported as a network failure, which is the reading an operator retries.

A host that never tracked the branch (ARIA-LOW-578) adopted the same
replacement with exit 0; the checkout's lineage pin now refuses it there too,
and through the same exit-3 channel.

These tests run the restore action's checkout step itself, under the shell
flags GitHub uses for ``shell: bash``, against the REAL kernel and a real
fixture remote whose tip was replaced — not a stand-in that exits 3 on cue.
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

import yaml

from tests._helpers.hermetic_git import apply_hermetic_git_env
from tests._helpers.state_lineage_pin import write_state_lineage_policy

REPO_ROOT = Path(__file__).resolve().parents[2]
KERNEL_ROOT = REPO_ROOT / "aria-kernel"
ACTION = REPO_ROOT / ".github" / "actions" / "restore-aria-state" / "action.yml"
GITHUB_BASH = ["bash", "--noprofile", "--norc", "-eo", "pipefail"]
STATE_REF = "refs/heads/aria/state"
TRACKING_REF = "refs/remotes/origin/aria/state"


def _hermetic_env(base: dict[str, str] | None = None) -> dict[str, str]:
    """Every inherited GIT_* dropped, then the suite's hermetic config bound.

    An inherited GIT_DIR (a pre-push hook in a linked worktree) would point
    these fixture commands at the developer's repository.
    """
    env = {
        key: value for key, value in (os.environ if base is None else base).items()
        if not key.startswith("GIT_")
    }
    apply_hermetic_git_env(env)
    return env


def _git(cwd: Path, *args: str) -> str:
    return subprocess.run(
        ["git", "-C", str(cwd), *args],
        capture_output=True, text=True, check=True, env=_hermetic_env(),
    ).stdout


def _checkout_step_script() -> str:
    steps = yaml.safe_load(ACTION.read_text(encoding="utf-8"))["runs"]["steps"]
    step = next(s for s in steps if s.get("id") == "restore")
    assert step["shell"] == "bash", step["shell"]
    return step["run"]


def _commit(cwd: Path, message: str, *parents: str) -> str:
    empty_tree = _git(cwd, "hash-object", "-t", "tree", "/dev/null").strip()
    parent_args = [arg for parent in parents for arg in ("-p", parent)]
    return _git(
        cwd, "-c", "user.name=Fixture", "-c", "user.email=f@example.invalid",
        "commit-tree", empty_tree, *parent_args, "-m", message,
    ).strip()


class CheckoutStepReportsALineageRefusal(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="aria-restore-refusal-"))
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.remote = self.tmp / "remote.git"
        self.remote.mkdir()
        _git(self.remote, "init", "--bare", "--initial-branch=main", ".")
        self.repo = self.tmp / "work"
        self.repo.mkdir()
        _git(self.repo, "init", "--initial-branch=main", ".")
        _git(self.repo, "remote", "add", "origin", str(self.remote))
        (self.repo / "README.md").write_text("seed\n", encoding="utf-8")
        _git(self.repo, "add", "README.md")
        _git(
            self.repo, "-c", "user.name=Fixture", "-c", "user.email=f@example.invalid",
            "-c", "commit.gpgsign=false", "commit", "-m", "seed",
        )
        _git(self.repo, "push", "origin", "main")
        # The step runs `PYTHONPATH=aria-kernel python3 -m aria_kernel` from
        # the checkout root; the fixture checkout reaches the real kernel.
        (self.repo / "aria-kernel").symlink_to(KERNEL_ROOT, target_is_directory=True)
        with (self.repo / ".git" / "info" / "exclude").open("a", encoding="utf-8") as fh:
            fh.write("aria-kernel\n")
        # The lineage the checkout's policy pins (ARIA-LOW-578): a genesis
        # and one published commit on it.
        self.genesis = _commit(self.remote, "genesis")
        self.tip = _commit(self.remote, "a published snapshot", self.genesis)
        _git(self.remote, "update-ref", STATE_REF, self.tip)
        write_state_lineage_policy(self.repo, {"aria/state": self.genesis})

    def _host_tracks_the_tip(self) -> str:
        _git(self.repo, "fetch", "origin", f"{STATE_REF}:{TRACKING_REF}")
        return self.tip

    def _run_step(self) -> subprocess.CompletedProcess[str]:
        runner_temp = self.tmp / "runner-temp"
        runner_temp.mkdir()
        script = self.tmp / "step.sh"
        script.write_text(_checkout_step_script(), encoding="utf-8")
        env = _hermetic_env({
            key: value for key, value in os.environ.items()
            if key not in {"ARIA_STATE_BOOTSTRAP_ACK", "PYTHONPATH"}
        })
        env.update({
            "RUNNER_TEMP": str(runner_temp),
            "GITHUB_OUTPUT": str(self.tmp / "github_output"),
            "GITHUB_ENV": str(self.tmp / "github_env"),
            "GITHUB_STEP_SUMMARY": str(self.tmp / "summary"),
        })
        return subprocess.run(
            [*GITHUB_BASH, str(script)], cwd=self.repo, env=env,
            text=True, capture_output=True, timeout=300,
        )

    def _assert_reported_as_refusal(self, proc: subprocess.CompletedProcess[str], reason: str) -> None:
        self.assertEqual(proc.returncode, 3, proc.stderr)
        self.assertIn("aria/state refused the checkout (verdict, not a transport failure)", proc.stderr)
        self.assertIn(f"aria/state refusal: {reason}", proc.stderr)
        self.assertNotIn("failed to reach the remote", proc.stderr)
        self.assertNotIn("wrote no verdict", proc.stderr)
        verdict = json.loads(
            (self.tmp / "runner-temp" / "aria-state-checkout.json").read_text(encoding="utf-8")
        )
        self.assertEqual(verdict["published"], False)
        self.assertTrue(verdict["refusal"].startswith(reason), verdict)
        self.assertFalse((self.tmp / "github_output").exists())

    def test_a_tip_that_left_the_tracked_history_is_reported_as_a_refusal(self) -> None:
        # Same root (the pin holds), but the tip no longer descends from what
        # this host tracked: the tracking ancestry's verdict, ARIA-LOW-577.
        tracked = self._host_tracks_the_tip()
        diverged = _commit(self.remote, "a rewritten tail", self.genesis)
        _git(self.remote, "update-ref", STATE_REF, diverged)

        proc = self._run_step()

        self._assert_reported_as_refusal(proc, "state_store_remote_history_unrelated")
        self.assertEqual(_git(self.repo, "rev-parse", TRACKING_REF).strip(), tracked)

    def test_a_replaced_lineage_is_reported_as_a_refusal_on_a_tracking_host(self) -> None:
        # The ARIA-HIGH-572 lab shape: the remote tip became a new root.
        tracked = self._host_tracks_the_tip()
        _git(self.remote, "update-ref", STATE_REF, _commit(self.remote, "replacement root"))

        proc = self._run_step()

        self._assert_reported_as_refusal(proc, "state_store_lineage_root_mismatch")
        self.assertEqual(_git(self.repo, "rev-parse", TRACKING_REF).strip(), tracked)

    def test_a_replaced_lineage_is_refused_on_a_fresh_host(self) -> None:
        # The aria-state-maintenance shape (ARIA-LOW-578): a GitHub-hosted
        # runner that never tracked aria/state used to adopt it with exit 0.
        _git(self.remote, "update-ref", STATE_REF, _commit(self.remote, "replacement root"))

        proc = self._run_step()

        self._assert_reported_as_refusal(proc, "state_store_lineage_root_mismatch")
        self.assertEqual(_git(self.repo, "for-each-ref", "--format=%(refname)", TRACKING_REF), "")


if __name__ == "__main__":
    unittest.main()
