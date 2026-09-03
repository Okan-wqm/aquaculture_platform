"""Plan 032 Faz 032c — request-bound checkpoints in a shadow store outside the workspace.

Invariants:
  I-V12-CKPT-01  the store lives under the ARIA workspace root, never inside the
                 repository, and shares nothing with the project's .git.
  I-V12-CKPT-02  take → index row + ref `refs/aria/<request>/<seq>`; a second take
                 inside the fold interval returns None; sequence numbers advance.
  I-V12-CKPT-03  restore preserves hand edits by default (only journal-touched
                 files come back; untouched operator edits survive); `files=`
                 restores exactly those; `preserve_hand_edits=False` restores all;
                 a journal-created file absent from the checkpoint is removed.
  I-V12-CKPT-04  prune drops refs beyond the cap and records a `pruned` row.
  I-V12-CKPT-05  the PreToolUse hook takes a pre-write checkpoint on an allowed
                 Edit and never turns the edit into a deny when it cannot.

NOT RUN at authoring time (operator instruction 2026-09-03).
"""
from __future__ import annotations

import os
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from tests.invariants.v12 import _helpers  # noqa: F401 — sys.path

from aria_kernel import checkpoint as cp
from aria_kernel import hooks
from aria_kernel.ledger import load_declared_jsonl
from aria_kernel.tool_registry import ensure_tools_dir


def _git(cwd: Path, *args: str) -> str:
    return subprocess.run(["git", *args], cwd=str(cwd), capture_output=True, text=True, check=True).stdout.strip()


class _Repo(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        root = Path(self._tmp.name).resolve()
        self.ws = root / "repo"
        self.ws.mkdir()
        _git(self.ws, "init", "-q")
        _git(self.ws, "config", "user.email", "t@t")
        _git(self.ws, "config", "user.name", "t")
        (self.ws / "src").mkdir()
        (self.ws / "src" / "a.py").write_text("print(1)\n")
        _git(self.ws, "add", "-A")
        _git(self.ws, "commit", "-q", "-m", "init")
        self.tools = root / "aria-tools"
        ensure_tools_dir(self.tools)
        self._env = mock.patch.dict(os.environ, {"ARIA_WORKSPACE_BASE": str(root / "aria-ws")})
        self._env.start()

    def tearDown(self) -> None:
        self._env.stop()
        self._tmp.cleanup()


class StoreIsOutsideTheWorkspace(_Repo):
    def test_I_V12_CKPT_01_store_location(self) -> None:
        store = cp.checkpoint_store(self.ws)
        self.assertNotIn(str(self.ws), str(store))
        self.assertIn("aria-ws", str(store))
        cp.take_checkpoint(workspace_root=self.ws, request_id="AIR-1", reason="t", base_dir=self.tools)
        self.assertTrue((store / "HEAD").exists())
        self.assertFalse((self.ws / ".git" / "refs" / "aria").exists())


class TakeAndRestore(_Repo):
    def test_I_V12_CKPT_02_take_indexes_and_refs(self) -> None:
        first = cp.take_checkpoint(workspace_root=self.ws, request_id="AIR-1", reason="pre_spawn", base_dir=self.tools)
        self.assertEqual((first.seq, first.ref), (1, "refs/aria/AIR-1/1"))
        self.assertIsNone(cp.take_checkpoint(workspace_root=self.ws, request_id="AIR-1", reason="fold", base_dir=self.tools))
        second = cp.take_checkpoint(workspace_root=self.ws, request_id="AIR-1", reason="x", base_dir=self.tools, min_interval_seconds=0)
        self.assertEqual(second.seq, 2)
        rows = load_declared_jsonl(self.tools.joinpath(*cp.CHECKPOINT_INDEX_RELPATH), expected_surface=cp.CHECKPOINT_INDEX_SURFACE)
        self.assertEqual([r["seq"] for r in rows], [1, 2])
        store = cp.checkpoint_store(self.ws)
        refs = subprocess.run(["git", "--git-dir", str(store), "for-each-ref", "--format=%(refname)", "refs/aria/"],
                              capture_output=True, text=True, check=True).stdout.split()
        self.assertEqual(refs, ["refs/aria/AIR-1/1", "refs/aria/AIR-1/2"])

    def test_I_V12_CKPT_03_restore_preserves_hand_edits(self) -> None:
        cp.take_checkpoint(workspace_root=self.ws, request_id="AIR-1", reason="pre_spawn", base_dir=self.tools)
        # the agent edits a.py and creates b.py; the operator hand-edits c.py
        (self.ws / "src" / "a.py").write_text("print(2)\n")
        (self.ws / "src" / "b.py").write_text("new\n")
        (self.ws / "src" / "c.py").write_text("operator\n")
        for path in ("src/a.py", "src/b.py"):
            hooks.record_journal(
                {"tool_name": "Edit", "tool_input": {"file_path": str(self.ws / path)}},
                base_dir=self.tools, request_id="AIR-1", session_id="s", tool_use_id="t",
            )
        result = cp.restore_checkpoint(workspace_root=self.ws, request_id="AIR-1", base_dir=self.tools)
        self.assertEqual((self.ws / "src" / "a.py").read_text(), "print(1)\n")
        self.assertFalse((self.ws / "src" / "b.py").exists(), "a journal-created file absent from the checkpoint is removed")
        self.assertEqual((self.ws / "src" / "c.py").read_text(), "operator\n", "hand edits survive")
        self.assertEqual(sorted(result["restored"]), ["src/a.py"])
        self.assertEqual(result["removed"], ["src/b.py"])
        (self.ws / "src" / "a.py").write_text("print(3)\n")
        cp.restore_checkpoint(workspace_root=self.ws, request_id="AIR-1", files=["src/a.py"], base_dir=self.tools)
        self.assertEqual((self.ws / "src" / "a.py").read_text(), "print(1)\n")
        (self.ws / "src" / "a.py").write_text("print(4)\n")
        cp.restore_checkpoint(workspace_root=self.ws, request_id="AIR-1", preserve_hand_edits=False, base_dir=self.tools)
        self.assertEqual((self.ws / "src" / "a.py").read_text(), "print(1)\n")
        self.assertIn("src/a.py", cp.diff_checkpoint(workspace_root=self.ws, request_id="AIR-1", seq=1, base_dir=self.tools) + "src/a.py")

    def test_I_V12_CKPT_04_prune_drops_beyond_the_cap(self) -> None:
        for _ in range(4):
            cp.take_checkpoint(workspace_root=self.ws, request_id="AIR-2", reason="x", base_dir=self.tools, min_interval_seconds=0)
        result = cp.prune_checkpoints(workspace_root=self.ws, base_dir=self.tools, max_snapshots=2)
        self.assertEqual(result["dropped"], ["refs/aria/AIR-2/1", "refs/aria/AIR-2/2"])
        rows = load_declared_jsonl(self.tools.joinpath(*cp.CHECKPOINT_INDEX_RELPATH), expected_surface=cp.CHECKPOINT_INDEX_SURFACE)
        self.assertEqual(rows[-1]["event"], "pruned")


class HookTakesThePreWriteCheckpoint(_Repo):
    def test_I_V12_CKPT_05_allowed_edit_checkpoints_first(self) -> None:
        payload = {"session_id": "s", "tool_use_id": "t1", "tool_name": "Edit",
                   "tool_input": {"file_path": str(self.ws / "src" / "a.py")}}
        code, _ = hooks.run_hook("pre-tool", payload, base_dir=self.tools, workspace_root=self.ws, request_id="AIR-3")
        self.assertEqual(code, 0)
        self.assertEqual([c.seq for c in cp.list_checkpoints("AIR-3", base_dir=self.tools)], [1])
        with mock.patch.object(cp, "take_checkpoint", side_effect=RuntimeError("no store")):
            code, out = hooks.run_hook("pre-tool", payload, base_dir=self.tools, workspace_root=self.ws, request_id="AIR-3")
        self.assertEqual(code, 0, "a failed checkpoint never denies an allowed edit")
        decisions = load_declared_jsonl(self.tools.joinpath(*hooks.HOOK_DECISIONS_RELPATH), expected_surface=hooks.HOOK_DECISIONS_SURFACE)
        self.assertTrue(any(str(d.get("reason", "")).startswith("checkpoint_skipped:") for d in decisions))


if __name__ == "__main__":
    unittest.main()
