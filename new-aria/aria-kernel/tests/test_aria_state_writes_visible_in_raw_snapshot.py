"""Plan ARIA-V2 §3.4 + I-24 — gitignored runtime writes still visible
in the scope-out mutation detector.

After Phase 5 gitignores most of ``aria-tools/``, the worry is that
``git status --porcelain`` (used by ``_workspace_snapshot_raw`` in
``tool_runner``) will silently swallow runtime writes — and the
Plan 022 §C-5 scope-out partitioning will go blind to ledger
mutations that should still be auditable.

This invariant verifies the opposite is true: ``_workspace_snapshot_raw``
operates on the directory-snapshot fallback when no ``.git`` is
present, and on ``git status`` when one is, but in EITHER case a
write to a path under ``aria-tools/`` produces a detectable
before-vs-after delta. Gitignore does not hide the write from the
scope-out detector.

The contract being locked: a write to ANY aria-tools file (whether
gitignored or not) MUST appear in the symmetric difference of two
consecutive raw snapshots. If that ever stops being true, scope-out
detection becomes lossy and Plan 022 §C-5 ships broken.
"""

from __future__ import annotations

import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


_REPO_ROOT = Path(__file__).resolve().parents[2]
if str(_REPO_ROOT / "aria-kernel") not in sys.path:
    sys.path.insert(0, str(_REPO_ROOT / "aria-kernel"))

from aria_kernel.tool_runner import _workspace_snapshot_raw


def _init_repo(path: Path) -> None:
    path.mkdir(parents=True, exist_ok=True)
    subprocess.run(["git", "-C", str(path), "init", "-q", "-b", "main"], check=True, capture_output=True)
    subprocess.run(
        ["git", "-C", str(path), "config", "user.email", "test@example.com"],
        check=True,
        capture_output=True,
    )
    subprocess.run(
        ["git", "-C", str(path), "config", "user.name", "Test"],
        check=True,
        capture_output=True,
    )
    (path / "README.md").write_text("seed\n", encoding="utf-8")
    subprocess.run(["git", "-C", str(path), "add", "README.md"], check=True, capture_output=True)
    subprocess.run(["git", "-C", str(path), "commit", "-q", "-m", "seed"], check=True, capture_output=True)


def _write_aria_gitignore(path: Path) -> None:
    """Mirror the real-repo gitignore patterns the operator runs under."""
    (path / ".gitignore").write_text(
        "aria-tools/runs.jsonl\n"
        "aria-tools/governance.jsonl\n"
        "aria-tools/cycles.jsonl\n"
        "aria-tools/observability/\n"
        "aria-tools/memory/\n",
        encoding="utf-8",
    )
    subprocess.run(
        ["git", "-C", str(path), "add", ".gitignore"],
        check=True,
        capture_output=True,
    )
    subprocess.run(
        ["git", "-C", str(path), "commit", "-q", "-m", "gitignore"],
        check=True,
        capture_output=True,
    )


class AriaStateWritesVisibleInRawSnapshot(unittest.TestCase):
    def test_gitignored_runtime_write_appears_in_raw_snapshot_delta(self) -> None:
        with tempfile.TemporaryDirectory(prefix="aria-i24-") as tmp:
            root = Path(tmp)
            _init_repo(root)
            _write_aria_gitignore(root)
            (root / "aria-tools").mkdir()

            before_raw = _workspace_snapshot_raw(root)

            # Simulate a runtime write to a gitignored ledger.
            (root / "aria-tools" / "governance.jsonl").write_text(
                '{"event":"phase4_test","ts":1}\n', encoding="utf-8"
            )

            after_raw = _workspace_snapshot_raw(root)

            # Both snapshots are tuple ("git"|"dir", paths_tuple).
            self.assertNotEqual(
                before_raw,
                after_raw,
                msg=(
                    "Raw workspace snapshot must change when an aria-tools "
                    "ledger is written, even if gitignored. Got identical "
                    "snapshots — scope-out detection is now blind to "
                    "runtime ledger mutations."
                ),
            )

    def test_dir_fallback_sees_aria_tools_write_when_no_git(self) -> None:
        with tempfile.TemporaryDirectory(prefix="aria-i24-nogit-") as tmp:
            root = Path(tmp)
            (root / "aria-tools").mkdir()

            before_raw = _workspace_snapshot_raw(root)
            (root / "aria-tools" / "runs.jsonl").write_text(
                '{"event":"phase4_test","ts":2}\n', encoding="utf-8"
            )
            after_raw = _workspace_snapshot_raw(root)

            self.assertEqual(before_raw[0], "dir")
            self.assertEqual(after_raw[0], "dir")
            self.assertNotEqual(before_raw, after_raw)


if __name__ == "__main__":
    unittest.main()
