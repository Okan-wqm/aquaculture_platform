"""ARIA-LOW-542 — an adapter walks the tracked view the room grants.

The adapter room shows only what git tracks (``workspace_view``): an
untracked file beneath a tracked directory is covered by a read-only bind of
``/dev/null``. The directory listing still names it, and its entry type still
reads "regular file" — the cover changes what the path IS, not what its
parent's directory says — so a walker that trusted the listing returned the
entry and the adapter died opening it: with ``digest.py`` untracked,
kernel-dead-wire-adapter exited 1 with ``EACCES`` in the room and 0 outside it.

These tests run the real ``tools/aria-adapters/adapter-fs.ts`` walker
(``collectFiles``) and reader (``containedWorkspace``) in a real room over a
checkout holding one tracked and one untracked file under the scan root. The
walker is TypeScript; Node runs it with its own type stripping, so the test
needs no installed dependency tree.
"""
from __future__ import annotations

import json
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

from aria_kernel import implementation_safety as impl
from aria_kernel.adapter_room import prepare_adapter_spawn, run_adapter
from tests._helpers.git_fixtures import commit_files, make_local_git_repo

REPO_ROOT = Path(__file__).resolve().parents[2]
ADAPTER_FS = REPO_ROOT / "tools" / "aria-adapters" / "adapter-fs.ts"
WALKER_ARGV = ["node", "--experimental-strip-types", "--no-warnings", "tools/aria-adapters/walk-probe.ts"]
# Every .py file the walk lists under src/, read through the contained reader:
# what an adapter does with a scan root.
WALK_PROBE = """import { relative } from 'node:path';
import { collectFiles, containedWorkspace } from './adapter-fs.ts';

const root = process.cwd();
const workspace = containedWorkspace(root);
const read: Record<string, number> = {};
for (const file of collectFiles(`${root}/src`, { extensions: ['.py'] })) {
  const path = relative(root, file);
  read[path] = workspace.readFile(path).length;
}
process.stdout.write(`${JSON.stringify(read)}\\n`);
"""
TRACKED = "TRACKED = 1\n"
UNTRACKED = "UNTRACKED = 1\n"


def _node_strips_types() -> bool:
    try:
        probe = subprocess.run(
            ["node", "--experimental-strip-types", "--version"], capture_output=True, text=True, timeout=30, check=False,
        )
    except (OSError, subprocess.TimeoutExpired):
        return False
    return probe.returncode == 0


class UntrackedEntryUnderAScanRootTests(unittest.TestCase):
    def setUp(self) -> None:
        if impl.sandbox_backend() is None:
            self.skipTest(f"bwrap is not usable on this host: {impl.sandbox_unavailable_detail()}")
        if not _node_strips_types():
            self.skipTest("the node on PATH cannot run TypeScript (--experimental-strip-types needs Node >= 22.6)")
        # Under /var/tmp, not /tmp: the room mounts its own /tmp.
        base = Path(tempfile.mkdtemp(prefix="aria-low-542-", dir="/var/tmp"))
        self.addCleanup(shutil.rmtree, base, True)
        self.workspace = make_local_git_repo(base, name="repo", initial_commit=False)
        commit_files(self.workspace, {
            "tools/aria-adapters/adapter-fs.ts": ADAPTER_FS.read_text(encoding="utf-8"),
            "tools/aria-adapters/walk-probe.ts": WALK_PROBE,
            "src/tracked.py": TRACKED,
        })
        (self.workspace / "src" / "untracked.py").write_text(UNTRACKED, encoding="utf-8")

    def test_in_the_room_the_walk_lists_only_what_the_room_shows(self) -> None:
        spawn = prepare_adapter_spawn(WALKER_ARGV, workspace_root=self.workspace, cwd=self.workspace)
        done = run_adapter(spawn, input_text=None, timeout_seconds=120)
        self.assertEqual(done.returncode, 0, f"the walker crashed in the room: {done.stderr[-2000:]}")
        self.assertEqual(json.loads(done.stdout), {"src/tracked.py": len(TRACKED)})

    def test_outside_the_room_nothing_is_masked_and_both_files_are_walked(self) -> None:
        # The walk follows what the filesystem shows; it does not start
        # ignoring untracked files on a plain checkout.
        done = subprocess.run(
            WALKER_ARGV, cwd=self.workspace, capture_output=True, text=True, timeout=120, check=False,
        )
        self.assertEqual(done.returncode, 0, done.stderr[-2000:])
        self.assertEqual(
            json.loads(done.stdout), {"src/tracked.py": len(TRACKED), "src/untracked.py": len(UNTRACKED)},
        )


if __name__ == "__main__":
    unittest.main()
