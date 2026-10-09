"""ARIA-HIGH-356 — the writer-lease step yields green under the shell GitHub runs it in.

Measured on main 2026-10-05: every `aria-readiness-claim` run that met a held
lease (the executor holds it for hours) failed at "Acquire the aria/state
writer lease" with exit 3 after its 300 s wait (runs 37249919142,
37259375696). GitHub runs a `shell: bash` step as `bash --noprofile --norc
-eo pipefail`, and the step's own `set -uo pipefail` leaves errexit on, so
the acquire's exit 3 ended the step before `LEASE_EXIT=$?` ran. The yield
branch existed and was unreachable. The pin that guarded it read the YAML as
text (`'"$LEASE_EXIT" -ne 3' in action`), which a dead branch satisfies.

These tests run the step's script itself, under GitHub's flags, against a
stand-in kernel that answers the way `state lease acquire` does.
"""
from __future__ import annotations

import json
import os
import stat
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

import yaml

REPO_ROOT = Path(__file__).resolve().parents[2]
ACTION = REPO_ROOT / ".github" / "actions" / "restore-aria-state" / "action.yml"
# What GitHub executes for `shell: bash` (docs: "Workflow syntax", `shell`).
GITHUB_BASH = ["bash", "--noprofile", "--norc", "-eo", "pipefail"]

HOLDER_VERDICT = {
    "refusal": "state_writer_lease_held",
    "holder": {"owner": "aria-agent-executor/37245553509", "expires_at": "2026-10-05T05:07:40Z"},
}


def _lease_step_script() -> str:
    steps = yaml.safe_load(ACTION.read_text(encoding="utf-8"))["runs"]["steps"]
    step = next(s for s in steps if s.get("id") == "writer_lease")
    assert step["shell"] == "bash", step["shell"]
    return step["run"]


class _LeaseStep(unittest.TestCase):
    def run_step(self, *, exit_code: int, verdict: dict) -> tuple[subprocess.CompletedProcess[str], str]:
        tmp = Path(tempfile.mkdtemp(prefix="aria-lease-step-"))
        self.addCleanup(lambda: __import__("shutil").rmtree(tmp, ignore_errors=True))
        bindir = tmp / "bin"
        bindir.mkdir()
        # A `python3` that answers `-m aria_kernel state lease acquire` the way
        # the kernel does (verdict on stdout, exit code), and runs everything
        # else — the step's JSON one-liners — on the real interpreter.
        fake = bindir / "python3"
        fake.write_text(
            "#!/bin/sh\n"
            'if [ "$1" = "-m" ] && [ "$2" = "aria_kernel" ]; then\n'
            f"  printf '%s' '{json.dumps(verdict)}'\n"
            f"  exit {exit_code}\n"
            "fi\n"
            f'exec "{sys.executable}" "$@"\n',
            encoding="utf-8",
        )
        fake.chmod(fake.stat().st_mode | stat.S_IEXEC)
        script = tmp / "step.sh"
        script.write_text(_lease_step_script(), encoding="utf-8")
        output = tmp / "github_output"
        output.touch()
        env = {
            **os.environ,
            "PATH": f"{bindir}{os.pathsep}{os.environ['PATH']}",
            "RUNNER_TEMP": str(tmp),
            "GITHUB_OUTPUT": str(output),
            "GITHUB_STEP_SUMMARY": str(tmp / "summary"),
            "LEASE_TTL_MINUTES": "240",
            "LEASE_WAIT_SECONDS": "1",
        }
        proc = subprocess.run(
            [*GITHUB_BASH, str(script)], cwd=tmp, env=env, text=True, capture_output=True, timeout=60,
        )
        return proc, output.read_text(encoding="utf-8")


class AHeldLeaseYieldsGreen(_LeaseStep):
    def test_exit_three_with_a_holder_is_a_yield(self) -> None:
        proc, outputs = self.run_step(exit_code=3, verdict=HOLDER_VERDICT)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertIn("writer_lease=yielded", outputs)
        self.assertIn("::warning::aria/state writer lease yielded", proc.stdout)


class EveryOtherRefusalStaysRed(_LeaseStep):
    def test_exit_three_without_a_holder_is_red(self) -> None:
        proc, outputs = self.run_step(exit_code=3, verdict={"refusal": "state_writer_lease_held"})
        self.assertEqual(proc.returncode, 1, proc.stderr)
        self.assertNotIn("writer_lease=", outputs)

    def test_an_unreadable_record_is_red(self) -> None:
        proc, outputs = self.run_step(exit_code=4, verdict={"error": "state_writer_lease_record_missing"})
        self.assertEqual(proc.returncode, 1, proc.stderr)
        self.assertIn("the aria/state writer lease is not usable (exit 4)", proc.stderr)
        self.assertNotIn("writer_lease=", outputs)


if __name__ == "__main__":
    unittest.main()
