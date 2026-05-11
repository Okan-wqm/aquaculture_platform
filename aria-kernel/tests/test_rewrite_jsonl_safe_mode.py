"""Plan 026R §A.2 — safe rewrite_jsonl lock-order + fsync invariants.

3 tests:

* rewrite_jsonl acquires the locks declared by _lock_requirements_for_path
* rewrite_jsonl fsyncs the tmp file via _atomic_write_text
* rewrite_jsonl on indexed paths holds index-group OUTER + per-file INNER
  in the correct order (instrumented via patched with_exclusive_lock).
"""
from __future__ import annotations

import json
import tempfile
import unittest
from contextlib import contextmanager
from pathlib import Path
from unittest.mock import patch

from aria_kernel import ledger
from aria_kernel.ledger import (
    _lock_requirements_for_path,
    append_jsonl,
    rewrite_jsonl,
    verify_jsonl,
)


class RewriteJsonlSafeModeTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="aria-a2-rewrite-"))

    def tearDown(self) -> None:
        import shutil
        shutil.rmtree(self.tmp, ignore_errors=True)

    # ------------------------------------------------------------------
    # Lock acquisition per requirements
    # ------------------------------------------------------------------
    def test_rewrite_jsonl_acquires_lock_per_requirements_non_indexed(self) -> None:
        target = self.tmp / "claims.jsonl"
        target.touch()
        acquired: list[Path] = []
        real_lock = ledger.with_exclusive_lock

        @contextmanager
        def tracking(path, *args, **kwargs):
            acquired.append(Path(path).resolve())
            with real_lock(path, *args, **kwargs):
                yield

        with patch("aria_kernel.ledger.with_exclusive_lock", tracking):
            rewrite_jsonl(target, [{"event": "a"}, {"event": "b"}])

        # Non-indexed path → single per-file lock only.
        req = _lock_requirements_for_path(target)
        self.assertIsNone(req.index_group_lock_path)
        self.assertEqual(acquired, [target.resolve()])
        # Output is strict-clean.
        self.assertTrue(verify_jsonl(target)["valid"])

    # ------------------------------------------------------------------
    # tmp fsync via _atomic_write_text
    # ------------------------------------------------------------------
    def test_rewrite_jsonl_fsyncs_tmp_via_atomic_write_text(self) -> None:
        target = self.tmp / "claims.jsonl"
        import os
        fsync_paths: list[int] = []
        real_fsync = os.fsync

        def tracked(fd):
            fsync_paths.append(fd)
            return real_fsync(fd)

        with patch("aria_kernel.ledger.os.fsync", side_effect=tracked):
            rewrite_jsonl(target, [{"event": "a"}])

        # At least one fsync for the rewritten data (rewrite_jsonl invokes
        # _atomic_write_text inside _rewrite_jsonl_unlocked AND a separate
        # write of the integrity_index on indexed-group rewrites). Here
        # the path is non-indexed → exactly the tmp fsync at minimum.
        self.assertGreaterEqual(len(fsync_paths), 1)
        self.assertTrue(verify_jsonl(target)["valid"])

    # ------------------------------------------------------------------
    # Indexed lock order: outer index-group, inner per-file
    # ------------------------------------------------------------------
    def test_rewrite_jsonl_indexed_path_holds_locks_in_correct_order(self) -> None:
        tools = self.tmp / "aria-tools"
        tools.mkdir()
        (tools / "integrity_index.json").write_text(
            json.dumps({"ledger_hashes": {}, "schema_version": 2}),
            encoding="utf-8",
        )
        target = tools / "cycles.jsonl"
        append_jsonl(target, {"event": "seed"})  # chain so rewrite has content
        acquired: list[Path] = []
        real_lock = ledger.with_exclusive_lock

        @contextmanager
        def tracking(path, *args, **kwargs):
            acquired.append(Path(path).resolve())
            with real_lock(path, *args, **kwargs):
                yield

        with patch("aria_kernel.ledger.with_exclusive_lock", tracking):
            rewrite_jsonl(target, [{"event": "rewritten"}])

        # Indexed-group path: the first 2 acquisitions are the public
        # rewrite_jsonl's own (OUTER index-group → INNER per-file).
        # Subsequent acquisitions are siblings during the held-lock-aware
        # index refresh and are unordered by group invariant.
        req = _lock_requirements_for_path(target)
        self.assertIsNotNone(req.index_group_lock_path)
        index_lock = req.index_group_lock_path.resolve()
        file_lock = req.file_lock_path.resolve()
        self.assertGreaterEqual(len(acquired), 2)
        self.assertEqual(acquired[0], index_lock,
                         "OUTER index-group lock must be first")
        self.assertEqual(acquired[1], file_lock,
                         "INNER per-file lock must be second")


if __name__ == "__main__":
    unittest.main()
