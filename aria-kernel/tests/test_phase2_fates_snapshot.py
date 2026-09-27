"""Plan ARIA-V2 §Phase 2 invariants I-8..I-13, I-35, I-36 — FATES on
snapshot value object + memory rebuild-fates + memory reset.

Locks the architectural decision that ``_verify_fates_integrity``
operates on the immutable snapshot (committed mode) or emits a drift
governance event (working_tree mode) — NOT on the live working tree.
Working-tree edits between discovery and memory write are no longer
false-positive errors blocking the cycle.
"""

from __future__ import annotations

import hashlib
import importlib.util
import json
import os
import subprocess
import sys
import tempfile
import unittest
from contextlib import contextmanager
from pathlib import Path
from typing import Iterator
from unittest.mock import patch

import aria_kernel.snapshot as snapshot_module
from aria_kernel.discovery import run_discovery
from aria_kernel.ledger import read_jsonl
from aria_kernel.memory import (
    _verify_fates_integrity,
    rebuild_fates,
    reset_memory,
    update_memory,
)
from aria_kernel.migration import (
    migrate_tools_bootstrap,
    migrate_workspace_v1_to_v2,
)
from aria_kernel.tool_registry import GovernanceError
from aria_kernel.snapshot import build_repo_snapshot


_helpers_path = Path(__file__).parent / "_helpers" / "git_fixtures.py"
_spec = importlib.util.spec_from_file_location("aria_kernel_test_helpers_git_fixtures", _helpers_path)
git_fixtures = importlib.util.module_from_spec(_spec)
sys.modules["aria_kernel_test_helpers_git_fixtures"] = git_fixtures
_spec.loader.exec_module(git_fixtures)


def _sha256_prefixed(data: bytes) -> str:
    return "sha256:" + hashlib.sha256(data).hexdigest()


class _SnapshotViewFixture(unittest.TestCase):
    def setUp(self) -> None:
        scratch = tempfile.TemporaryDirectory()
        self.addCleanup(scratch.cleanup)
        self.tmp = Path(scratch.name)
        self.repo = git_fixtures.make_local_git_repo(
            self.tmp, remote_url=None, initial_commit=False,
        )

    def _git(self, *args: str) -> str:
        return subprocess.run(
            ["git", *args], cwd=self.repo, check=True, capture_output=True, text=True,
        ).stdout.strip()

    def _commit(self, files: dict[str, bytes]) -> str:
        for name, content in files.items():
            (self.repo / name).write_bytes(content)
        self._git("add", "--", *files)
        self._git("commit", "-q", "-m", "fixture: snapshot source revision")
        return self._git("rev-parse", "HEAD")

    @contextmanager
    def _advance_head_on_progress(self) -> Iterator[list[str]]:
        revisions: list[str] = []
        original_progress = snapshot_module.emit_progress

        def advance(step: str, **fields: object) -> None:
            if step == "discovery_scan" and fields.get("scanned") == 0 and not revisions:
                revisions.append(self._commit({
                    "a.txt": b"a at B\n", "z.txt": b"z at B\n", "later.txt": b"only B\n",
                }))
            original_progress(step, **fields)

        with patch.object(snapshot_module, "emit_progress", side_effect=advance):
            yield revisions


class ScopedSourceObservationTests(_SnapshotViewFixture):
    def test_a_budget_must_state_its_deadline(self) -> None:
        # ARIA-MEDIUM-082 — the constructor used to carry ``+ 2``, the one
        # literal every qualification inherited. Now a caller states either
        # an allowance (seconds from now) or an absolute instant, never both
        # and never neither; the allowance itself is policy upstream.
        with self.assertRaises(GovernanceError):
            snapshot_module._ScopedSourceBudget()
        with self.assertRaises(GovernanceError):
            snapshot_module._ScopedSourceBudget(deadline_seconds=1.0, deadline_monotonic=1.0)
        clock = [10.0]
        with patch.object(snapshot_module._time, "monotonic", side_effect=lambda: clock[0]):
            budget = snapshot_module._ScopedSourceBudget(deadline_seconds=2.5)
            self.assertEqual(budget.deadline_monotonic, 12.5)
            self.assertFalse(budget.expired())
            clock[0] = 12.5
            self.assertTrue(budget.expired())
        # A zero allowance is already expired: the honest "nothing qualified".
        self.assertTrue(snapshot_module._ScopedSourceBudget(deadline_seconds=0.0).expired())

    def _working_fate(self) -> dict:
        self._commit({"owner.py": b"def present():\n    return True\n"})
        captured = build_repo_snapshot(workspace_root=self.repo, mode="working_tree")
        return next(row for row in captured["fates"] if row["path"] == "owner.py")

    def test_expiry_during_file_preparation_prevents_content_read(self) -> None:
        fate = self._working_fate()
        clock = [0.0]
        real_fstat = os.fstat
        actual_reads = []
        real_open = Path.open

        class ObservedStream:
            def __init__(self, stream):
                self.stream = stream
            def __enter__(self):
                return self
            def __exit__(self, *args):
                self.stream.close()
            def fileno(self):
                return self.stream.fileno()
            def read(self, size):
                data = self.stream.read(size)
                actual_reads.append(len(data))
                return data

        def observed_open(path, *args, **kwargs):
            return ObservedStream(real_open(path, *args, **kwargs))

        def expiry_after_metadata(fd):
            result = real_fstat(fd)
            clock[0] = 3.0
            return result

        budget = snapshot_module._ScopedSourceBudget(deadline_monotonic=2.0)
        with patch.object(snapshot_module._time, "monotonic", side_effect=lambda: clock[0]), \
                patch.object(os, "fstat", side_effect=expiry_after_metadata), \
                patch.object(Path, "open", observed_open):
            row, data = snapshot_module._read_scoped_source_bytes(
                self.repo, fate, snapshot_mode="working_tree", base_commit_sha=None, budget=budget,
            )
        self.assertEqual(actual_reads, [])
        self.assertIsNone(data)
        self.assertEqual((row["status"], row["reason"]), ("unknown", "qualification_deadline"))
        self.assertEqual(budget.source_bytes_read, 0)

    def test_expiry_during_hashing_keeps_source_unavailable(self) -> None:
        fate = self._working_fate()
        clock = [0.0]
        real_hash = snapshot_module._sha256
        hashed = []

        def expiry_after_hash(data):
            result = real_hash(data)
            hashed.append(result)
            clock[0] = 3.0
            return result

        # The committed branch hashes after transport and the existing
        # deadline checkpoint; no filesystem-read helper masks that edge.
        budget = snapshot_module._ScopedSourceBudget(deadline_monotonic=2.0)
        head = self._git("rev-parse", "HEAD")
        with patch.object(snapshot_module._time, "monotonic", side_effect=lambda: clock[0]), \
                patch.object(snapshot_module, "_sha256", side_effect=expiry_after_hash):
            row, data = snapshot_module._read_scoped_source_bytes(
                self.repo, fate, snapshot_mode="committed", base_commit_sha=head, budget=budget,
            )
        self.assertEqual(hashed, [fate["content_hash"]])
        self.assertIsNone(data)
        self.assertEqual((row["status"], row["reason"]), ("unknown", "qualification_deadline"))


class CommittedSnapshotViewTests(_SnapshotViewFixture):
    def test_committed_snapshot_excludes_staged_new_file(self) -> None:
        base = self._commit({"kept.txt": b"kept at A\n"})
        (self.repo / "new.txt").write_bytes(b"not committed\n")
        self._git("add", "new.txt")

        snapshot = build_repo_snapshot(workspace_root=self.repo, mode="committed")

        self.assertEqual(snapshot["base_commit_sha"], base)
        self.assertIn("new.txt", snapshot["dirty_paths"])
        self.assertEqual(snapshot["allowed_paths"], ["kept.txt"])
        self.assertEqual(
            {row["path"]: row.get("content_hash") for row in snapshot["fates"]},
            {"kept.txt": _sha256_prefixed(b"kept at A\n")},
        )

    def test_committed_snapshot_retains_staged_deleted_file(self) -> None:
        base = self._commit({"kept.txt": b"kept at A\n", "removed.txt": b"removed at A\n"})
        self._git("rm", "removed.txt")
        self.assertFalse((self.repo / "removed.txt").exists())

        snapshot = build_repo_snapshot(workspace_root=self.repo, mode="committed")

        self.assertEqual(snapshot["base_commit_sha"], base)
        self.assertEqual(snapshot["allowed_paths"], ["kept.txt", "removed.txt"])
        self.assertEqual(
            {row["path"]: row.get("content_hash") for row in snapshot["fates"]},
            {"kept.txt": _sha256_prefixed(b"kept at A\n"),
             "removed.txt": _sha256_prefixed(b"removed at A\n")},
        )

    def test_committed_snapshot_keeps_one_captured_tree(self) -> None:
        base = self._commit({"a.txt": b"a at A\n", "z.txt": b"z at A\n"})
        before = build_repo_snapshot(workspace_root=self.repo, mode="committed")

        with self._advance_head_on_progress() as revisions:
            snapshot = build_repo_snapshot(workspace_root=self.repo, mode="committed")

        self.assertEqual(len(revisions), 1)
        self.assertNotEqual(revisions[0], base)
        self.assertEqual(self._git("rev-parse", "HEAD"), revisions[0])
        self.assertEqual(snapshot["base_commit_sha"], base)
        self.assertEqual(snapshot["allowed_paths"], ["a.txt", "z.txt"])
        self.assertEqual(
            {row["path"]: row.get("content_hash") for row in snapshot["fates"]},
            {"a.txt": _sha256_prefixed(b"a at A\n"), "z.txt": _sha256_prefixed(b"z at A\n")},
        )
        self.assertEqual(snapshot["snapshot_hash"], before["snapshot_hash"])
        self.assertEqual(snapshot["repo_state_id"], before["repo_state_id"])

    def test_discovery_returns_and_writes_the_captured_tree(self) -> None:
        base = self._commit({"a.txt": b"a at A\n", "z.txt": b"z at A\n"})
        before = build_repo_snapshot(workspace_root=self.repo, mode="committed")
        tools = self.tmp / "store" / "tools"
        cycle_id = "cycle-captured-tree"

        with self._advance_head_on_progress() as revisions:
            result = run_discovery(
                workspace_root=self.repo, cycle_id=cycle_id, base_dir=tools,
                snapshot_mode="committed",
            )

        self.assertEqual(len(revisions), 1)
        self.assertNotEqual(revisions[0], base)
        self.assertEqual(self._git("rev-parse", "HEAD"), revisions[0])
        output = tools / "discovery" / cycle_id
        written_snapshot = json.loads((output / "SNAPSHOT.json").read_text())
        written_fates = json.loads((output / "FATES.json").read_text())
        written_proof = json.loads((output / "COMPLETION_PROOF.json").read_text())
        self.assertEqual(result["artifact_dir"], output.as_posix())
        self.assertEqual(result["snapshot"], written_snapshot)
        self.assertEqual(result["fates"], written_fates["files"])
        self.assertEqual(result["completion_proof"], written_proof)
        self.assertEqual(written_fates["cycle_id"], cycle_id)
        self.assertEqual(written_proof["cycle_id"], cycle_id)
        self.assertEqual(written_snapshot["base_commit_sha"], base)
        self.assertEqual(written_snapshot["allowed_paths"], ["a.txt", "z.txt"])
        self.assertEqual(
            {row["path"]: row.get("content_hash") for row in written_fates["files"]},
            {"a.txt": _sha256_prefixed(b"a at A\n"), "z.txt": _sha256_prefixed(b"z at A\n")},
        )
        for field in ("base_commit_sha", "snapshot_hash", "repo_state_id", "snapshot_mode"):
            self.assertEqual(written_snapshot[field], before[field])
            self.assertEqual(written_proof[field], before[field])
        self.assertEqual(written_proof["file_counts"], written_snapshot["file_counts"])
        self.assertEqual(written_proof["fated_file_count"], 2)
        self.assertEqual(written_proof["missing_fates"], [])
        self.assertTrue(written_proof["complete"])


class SnapshotViewCompatibilityTests(_SnapshotViewFixture):
    def test_working_deletion_is_unknown_in_discovery(self) -> None:
        (self.repo / "dist").mkdir()
        base = self._commit({
            "a.txt": b"later deleted\n", "z.txt": b"available source\n",
            "dist/generated.txt": b"available generated bytes\n",
        })
        (self.repo / "a.txt").unlink()
        self.assertEqual(self._git("diff", "--name-only"), "a.txt")
        self.assertEqual(self._git("diff", "--cached", "--name-only"), "")
        tools = self.tmp / "store" / "tools"
        result = run_discovery(
            workspace_root=self.repo, cycle_id="cycle-working-deletion",
            base_dir=tools, snapshot_mode="working_tree",
        )

        rows = {row["path"]: row for row in result["fates"]}
        self.assertEqual(result["snapshot"]["base_commit_sha"], base)
        self.assertTrue(result["snapshot"]["dirty_snapshot"])
        self.assertEqual(rows["z.txt"]["content_hash"], _sha256_prefixed(b"available source\n"))
        self.assertEqual(rows["dist/generated.txt"]["fate"], "generated")
        self.assertEqual(rows["dist/generated.txt"]["content_hash"], _sha256_prefixed(b"available generated bytes\n"))
        self.assertEqual(rows["dist/generated.txt"]["size_bytes"], len(b"available generated bytes\n"))
        self.assertFalse(
            result["completion_proof"]["complete"],
            {"deleted_fate": rows["a.txt"], "completion_proof": result["completion_proof"]},
        )
        self.assertEqual(rows["a.txt"]["fate"], "unknown")
        self.assertEqual(rows["a.txt"]["error"], "stat_or_read_failed")
        self.assertNotIn("content_hash", rows["a.txt"])
        self.assertNotIn("size_bytes", rows["a.txt"])
        self.assertEqual(result["snapshot"]["allowed_paths"], ["z.txt"])
        self.assertEqual(result["completion_proof"]["missing_fates"], ["a.txt"])
        self.assertEqual(result["completion_proof"]["unknown_count"], 1)
        output = tools / "discovery" / "cycle-working-deletion"
        self.assertEqual(json.loads((output / "SNAPSHOT.json").read_text()), result["snapshot"])
        self.assertEqual(json.loads((output / "FATES.json").read_text())["files"], result["fates"])
        self.assertEqual(json.loads((output / "COMPLETION_PROOF.json").read_text()), result["completion_proof"])

    def test_committed_snapshot_preserves_git_quoted_file_names(self) -> None:
        name = 'quoted "é".txt'
        base = self._commit({name: b"committed named source\n"})

        snapshot = build_repo_snapshot(workspace_root=self.repo, mode="committed")

        self.assertEqual(snapshot["base_commit_sha"], base)
        self.assertEqual(snapshot["allowed_paths"], [name])
        self.assertEqual(snapshot["fates"][0]["content_hash"], _sha256_prefixed(b"committed named source\n"))

    def test_working_tree_keeps_staged_and_nonignored_untracked_bytes(self) -> None:
        self._commit({"kept.txt": b"committed\n", ".gitignore": b"ignored.txt\n"})
        (self.repo / "kept.txt").write_bytes(b"working edit\n")
        (self.repo / "staged.txt").write_bytes(b"staged addition\n")
        self._git("add", "staged.txt")
        (self.repo / "untracked.txt").write_bytes(b"untracked addition\n")
        (self.repo / "ignored.txt").write_bytes(b"ignored\n")

        snapshot = build_repo_snapshot(workspace_root=self.repo, mode="working_tree")
        alias = build_repo_snapshot(workspace_root=self.repo, mode="working-tree")

        self.assertEqual(
            {row["path"]: row.get("content_hash") for row in snapshot["fates"]},
            {".gitignore": _sha256_prefixed(b"ignored.txt\n"),
             "kept.txt": _sha256_prefixed(b"working edit\n"),
             "staged.txt": _sha256_prefixed(b"staged addition\n"),
             "untracked.txt": _sha256_prefixed(b"untracked addition\n")},
        )
        self.assertTrue(snapshot["dirty_snapshot"])
        for field in ("fates", "allowed_paths", "snapshot_mode", "snapshot_hash", "repo_state_id"):
            self.assertEqual(snapshot[field], alias[field])

    def test_no_git_snapshot_preserves_filesystem_observation(self) -> None:
        plain = self.tmp / "plain"
        plain.mkdir()
        (plain / "source.txt").write_bytes(b"filesystem source\n")
        (plain / "aria-tools").mkdir()
        (plain / "aria-tools" / "runtime.txt").write_bytes(b"runtime\n")

        for snapshot in (
            build_repo_snapshot(workspace_root=plain),
            build_repo_snapshot(workspace_root=plain, mode="working_tree"),
        ):
            self.assertIsNone(snapshot["base_commit_sha"])
            self.assertEqual(snapshot["allowed_paths"], ["source.txt"])
            self.assertEqual(
                {row["path"]: row.get("content_hash") for row in snapshot["fates"]},
                {"source.txt": _sha256_prefixed(b"filesystem source\n")},
            )
            self.assertEqual(set(snapshot), {
                "schema_version", "generated_at", "snapshot_mode", "dirty_snapshot",
                "base_commit_sha", "file_counts", "tracked_file_count", "legacy_tracked_file_count",
                "fated_file_count", "unknown_count", "allowed_paths", "dirty_paths", "generated_paths",
                "fates", "snapshot_hash", "repo_state_id",
            })


class CommittedSnapshotAvailabilityTests(_SnapshotViewFixture):
    def test_unborn_git_does_not_label_working_bytes_committed(self) -> None:
        (self.repo / "source.txt").write_bytes(b"not yet committed\n")
        self._git("add", "source.txt")
        with self.assertRaisesRegex(GovernanceError, "committed_snapshot_base_unavailable"):
            build_repo_snapshot(workspace_root=self.repo, mode="committed")
        working = build_repo_snapshot(workspace_root=self.repo, mode="working_tree")
        self.assertIsNone(working["base_commit_sha"])
        self.assertEqual(working["fates"][0]["content_hash"], _sha256_prefixed(b"not yet committed\n"))

    def test_tree_read_error_does_not_produce_an_empty_complete_snapshot(self) -> None:
        self._commit({"source.txt": b"committed\n"})
        original = snapshot_module._run_git_bytes
        fault_hit = False

        def interrupt(root: Path, args: list[str]) -> subprocess.CompletedProcess[bytes]:
            nonlocal fault_hit
            if args[0] == "ls-tree":
                fault_hit = True
                raise OSError("ordinary fixture tree read interruption")
            return original(root, args)

        with patch.object(snapshot_module, "_run_git_bytes", side_effect=interrupt):
            with self.assertRaisesRegex(GovernanceError, "committed_snapshot_tree_unavailable"):
                build_repo_snapshot(workspace_root=self.repo, mode="committed")
        self.assertTrue(fault_hit)

    def test_discovery_reports_unreadable_committed_blob_without_working_fallback(self) -> None:
        base = self._commit({"a.txt": b"a at A\n", "z.txt": b"z at A\n"})
        (self.repo / "a.txt").write_bytes(b"working fallback must not be served\n")
        original = snapshot_module._run_git_bytes

        for failure in ("oserror", "git_exit"):
            with self.subTest(failure=failure):
                def interrupt(root: Path, args: list[str]) -> subprocess.CompletedProcess[bytes]:
                    if args[0] == "show" and args[-1].endswith(":a.txt"):
                        if failure == "oserror":
                            raise OSError("ordinary fixture blob read interruption")
                        return subprocess.CompletedProcess(args, 1, b"", b"ordinary fixture read error")
                    return original(root, args)

                tools = self.tmp / failure / "tools"
                with patch.object(snapshot_module, "_run_git_bytes", side_effect=interrupt):
                    result = run_discovery(
                        workspace_root=self.repo, cycle_id="cycle-unavailable-blob",
                        base_dir=tools, snapshot_mode="committed",
                    )
                rows = {row["path"]: row for row in result["fates"]}
                self.assertEqual(result["snapshot"]["base_commit_sha"], base)
                self.assertEqual(rows["a.txt"]["fate"], "unknown")
                self.assertEqual(rows["a.txt"]["error"], "committed_blob_unavailable")
                self.assertNotIn("content_hash", rows["a.txt"])
                self.assertNotIn("size_bytes", rows["a.txt"])
                self.assertEqual(rows["z.txt"]["content_hash"], _sha256_prefixed(b"z at A\n"))
                self.assertEqual(result["snapshot"]["allowed_paths"], ["z.txt"])
                self.assertEqual(result["completion_proof"]["missing_fates"], ["a.txt"])
                self.assertFalse(result["completion_proof"]["complete"])
                output = tools / "discovery" / "cycle-unavailable-blob"
                self.assertEqual(json.loads((output / "SNAPSHOT.json").read_text()), result["snapshot"])
                self.assertEqual(json.loads((output / "FATES.json").read_text())["files"], result["fates"])
                self.assertEqual(json.loads((output / "COMPLETION_PROOF.json").read_text()), result["completion_proof"])


class FatesIntegrityOnSnapshotBytesTests(unittest.TestCase):
    """Plan ARIA-V2 I-8 — committed-mode FATES verification reads from
    the immutable git tree at ``base_commit_sha``, NOT from the
    working tree. Working-tree edits between discovery and memory
    write CANNOT cause false-positive errors.
    """

    def setUp(self) -> None:
        # ARIA-HIGH-065 — this fixture sets ARIA_WORKSPACE_BASE and its
        # tearDown used to POP it, leaving the rest of the interpreter with
        # no base at all (every later fixture then wrote under ~/.aria).
        # Scope the whole environment to the test instead.
        _environment = patch.dict(os.environ)
        _environment.start()
        self.addCleanup(_environment.stop)
        self._tmpdir = tempfile.TemporaryDirectory()
        self.tmp = Path(self._tmpdir.name)
        self.repo = git_fixtures.make_repo_with_initial_commit(
            self.tmp,
            files={"hello.txt": "hello world\n"},
            remote_url="https://github.com/test-owner/i8.git",
            name="repo",
        )
        self.committed_bytes = (self.repo / "hello.txt").read_bytes()
        self.committed_hash = _sha256_prefixed(self.committed_bytes)
        self.base_sha = subprocess.run(
            ["git", "rev-parse", "HEAD"], cwd=self.repo, capture_output=True, text=True
        ).stdout.strip()

    def tearDown(self) -> None:
        self._tmpdir.cleanup()

    def test_working_tree_edit_does_not_raise_in_committed_mode(self) -> None:
        fates = {"files": [{"path": "hello.txt", "content_hash": self.committed_hash}]}
        snapshot = {"snapshot_mode": "committed", "base_commit_sha": self.base_sha}
        (self.repo / "hello.txt").write_text("totally different content\n", encoding="utf-8")
        _verify_fates_integrity(fates, snapshot=snapshot, workspace_root=self.repo, base_dir=None)


class FatesIntegrityRaisesOnSnapshotTamperTests(unittest.TestCase):
    """Plan ARIA-V2 I-9 — tampered FATES content_hash (mismatch with
    git-tree bytes) raises memory_fates_content_hash_mismatch.
    """

    def setUp(self) -> None:
        # ARIA-HIGH-065 — this fixture sets ARIA_WORKSPACE_BASE and its
        # tearDown used to POP it, leaving the rest of the interpreter with
        # no base at all (every later fixture then wrote under ~/.aria).
        # Scope the whole environment to the test instead.
        _environment = patch.dict(os.environ)
        _environment.start()
        self.addCleanup(_environment.stop)
        self._tmpdir = tempfile.TemporaryDirectory()
        self.tmp = Path(self._tmpdir.name)
        self.repo = git_fixtures.make_repo_with_initial_commit(
            self.tmp,
            files={"hello.txt": "hello world\n"},
            remote_url="https://github.com/test-owner/i9.git",
            name="repo",
        )
        self.base_sha = subprocess.run(
            ["git", "rev-parse", "HEAD"], cwd=self.repo, capture_output=True, text=True
        ).stdout.strip()

    def tearDown(self) -> None:
        self._tmpdir.cleanup()

    def test_tampered_stored_hash_raises(self) -> None:
        fates = {"files": [{"path": "hello.txt", "content_hash": "sha256:tampered-hash-value"}]}
        snapshot = {"snapshot_mode": "committed", "base_commit_sha": self.base_sha}
        with self.assertRaises(GovernanceError) as cm:
            _verify_fates_integrity(fates, snapshot=snapshot, workspace_root=self.repo, base_dir=None)
        self.assertIn("memory_fates_content_hash_mismatch", str(cm.exception))


class DirtyWorkingTreeCommittedModeSucceedsTests(unittest.TestCase):
    """Plan ARIA-V2 I-10 — operator with dirty working tree runs
    committed-mode cycles successfully (the user-facing payoff).
    """

    def setUp(self) -> None:
        # ARIA-HIGH-065 — this fixture sets ARIA_WORKSPACE_BASE and its
        # tearDown used to POP it, leaving the rest of the interpreter with
        # no base at all (every later fixture then wrote under ~/.aria).
        # Scope the whole environment to the test instead.
        _environment = patch.dict(os.environ)
        _environment.start()
        self.addCleanup(_environment.stop)
        self._tmpdir = tempfile.TemporaryDirectory()
        self.tmp = Path(self._tmpdir.name)
        self.repo = git_fixtures.make_repo_with_initial_commit(
            self.tmp,
            files={"hello.txt": "hello world\n"},
            remote_url="https://github.com/test-owner/i10.git",
            name="repo",
        )
        self.committed_hash = _sha256_prefixed((self.repo / "hello.txt").read_bytes())
        self.base_sha = subprocess.run(
            ["git", "rev-parse", "HEAD"], cwd=self.repo, capture_output=True, text=True
        ).stdout.strip()
        (self.repo / "hello.txt").write_text("operator edit during cycle\n", encoding="utf-8")

    def tearDown(self) -> None:
        self._tmpdir.cleanup()

    def test_dirty_tree_committed_snapshot_does_not_raise(self) -> None:
        fates = {"files": [{"path": "hello.txt", "content_hash": self.committed_hash}]}
        snapshot = {"snapshot_mode": "committed", "base_commit_sha": self.base_sha}
        _verify_fates_integrity(fates, snapshot=snapshot, workspace_root=self.repo, base_dir=None)


class WorkingTreeModeDriftEventTests(unittest.TestCase):
    """Plan ARIA-V2 working_tree mode emits drift governance event."""

    def setUp(self) -> None:
        # ARIA-HIGH-065 — this fixture sets ARIA_WORKSPACE_BASE and its
        # tearDown used to POP it, leaving the rest of the interpreter with
        # no base at all (every later fixture then wrote under ~/.aria).
        # Scope the whole environment to the test instead.
        _environment = patch.dict(os.environ)
        _environment.start()
        self.addCleanup(_environment.stop)
        self._tmpdir = tempfile.TemporaryDirectory()
        self.tmp = Path(self._tmpdir.name)
        self.repo = git_fixtures.make_repo_with_initial_commit(
            self.tmp,
            files={"hello.txt": "hello world\n"},
            remote_url="https://github.com/test-owner/i13.git",
            name="repo",
        )
        self.workspace_base = self.tmp / "ws"
        self.workspace_base.mkdir()
        os.environ["ARIA_WORKSPACE_BASE"] = str(self.workspace_base)
        migrate_workspace_v1_to_v2(
            workspace_root=self.repo, workspace_base=self.workspace_base,
            acknowledge=True, reason="Plan ARIA-V2 working_tree mode test bootstrap",
        )
        self.tools_dir = self.tmp / "aria-tools"
        migrate_tools_bootstrap(
            tools_dir=self.tools_dir, workspace_root=self.repo,
            acknowledge=True, reason="Plan ARIA-V2 working_tree mode tools bootstrap",
        )

    def tearDown(self) -> None:
        os.environ.pop("ARIA_WORKSPACE_BASE", None)
        self._tmpdir.cleanup()

    def test_working_tree_mode_emits_drift_event_no_raise(self) -> None:
        fates = {"files": [{"path": "hello.txt", "content_hash": "sha256:will-not-match"}]}
        snapshot = {"snapshot_mode": "working_tree", "base_commit_sha": "deadbeef", "dirty_snapshot": True}
        _verify_fates_integrity(fates, snapshot=snapshot, workspace_root=self.repo, base_dir=self.tools_dir)
        gov_rows = read_jsonl(self.tools_dir / "governance.jsonl")
        drift_events = [r for r in gov_rows if r.get("kind") == "memory_fates_working_tree_drift_observed"]
        self.assertGreaterEqual(len(drift_events), 1)
        self.assertEqual(drift_events[-1]["details"]["snapshot_mode"], "working_tree")


class RebuildFatesCliTests(unittest.TestCase):
    """Plan ARIA-V2 I-11 — rebuild_fates rewrites FATES.json + emits audit row."""

    def setUp(self) -> None:
        # ARIA-HIGH-065 — this fixture sets ARIA_WORKSPACE_BASE and its
        # tearDown used to POP it, leaving the rest of the interpreter with
        # no base at all (every later fixture then wrote under ~/.aria).
        # Scope the whole environment to the test instead.
        _environment = patch.dict(os.environ)
        _environment.start()
        self.addCleanup(_environment.stop)
        self._tmpdir = tempfile.TemporaryDirectory()
        self.tmp = Path(self._tmpdir.name)
        self.repo = git_fixtures.make_repo_with_initial_commit(
            self.tmp,
            files={"a.txt": "alpha\n"},
            remote_url="https://github.com/test-owner/i11.git",
            name="repo",
        )
        self.workspace_base = self.tmp / "ws"
        self.workspace_base.mkdir()
        os.environ["ARIA_WORKSPACE_BASE"] = str(self.workspace_base)
        migrate_workspace_v1_to_v2(
            workspace_root=self.repo, workspace_base=self.workspace_base,
            acknowledge=True, reason="Plan ARIA-V2 I-11 workspace bootstrap fixture",
        )
        self.tools_dir = self.tmp / "aria-tools"
        migrate_tools_bootstrap(
            tools_dir=self.tools_dir, workspace_root=self.repo,
            acknowledge=True, reason="Plan ARIA-V2 I-11 tools bootstrap fixture",
        )
        self.cycle_id = "test-i11"
        discovery_dir = self.tools_dir / "discovery" / self.cycle_id
        discovery_dir.mkdir(parents=True)
        self.stale_hash = "sha256:stale-hash-i11-fixture"
        (discovery_dir / "FATES.json").write_text(json.dumps({
            "schema_version": 1, "cycle_id": self.cycle_id,
            "files": [{"path": "a.txt", "content_hash": self.stale_hash, "fate": "tracked"}],
        }), encoding="utf-8")

    def tearDown(self) -> None:
        os.environ.pop("ARIA_WORKSPACE_BASE", None)
        self._tmpdir.cleanup()

    def test_rebuild_rewrites_fates_and_emits_audit_row(self) -> None:
        result = rebuild_fates(
            cycle_id=self.cycle_id, workspace_root=self.repo,
            workspace_base=self.workspace_base, base_dir=self.tools_dir,
            reason="Plan ARIA-V2 I-11 rebuild for stale-hash recovery",
            acknowledge=True,
        )
        self.assertEqual(result["result"], "SUCCESS")
        self.assertEqual(result["rebuilt_file_count"], 1)
        new_fates = json.loads((self.tools_dir / "discovery" / self.cycle_id / "FATES.json").read_text())
        new_hash = new_fates["files"][0]["content_hash"]
        self.assertEqual(new_hash, _sha256_prefixed(b"alpha\n"))
        self.assertNotEqual(new_hash, self.stale_hash)
        gov_rows = read_jsonl(self.tools_dir / "governance.jsonl")
        rebuilt_events = [r for r in gov_rows if r.get("kind") == "memory_fates_rebuilt"]
        self.assertEqual(len(rebuilt_events), 1)
        details = rebuilt_events[0]["details"]
        rebuilt = details["rebuilt_files"][0]
        self.assertEqual(rebuilt["path"], "a.txt")
        self.assertEqual(rebuilt["pre_state_content_hash"], self.stale_hash)
        self.assertEqual(rebuilt["post_state_content_hash"], new_hash)

    def test_rebuild_requires_acknowledge(self) -> None:
        with self.assertRaises(GovernanceError) as cm:
            rebuild_fates(
                cycle_id=self.cycle_id, workspace_root=self.repo,
                workspace_base=self.workspace_base, base_dir=self.tools_dir,
                reason="Plan ARIA-V2 I-11 acknowledge required",
                acknowledge=False,
            )
        self.assertIn("acknowledge", str(cm.exception))


class ResetMemoryRequiresBackupTests(unittest.TestCase):
    """Plan ARIA-V2 I-12 + I-35 + I-36 — reset_memory full discipline."""

    def setUp(self) -> None:
        # ARIA-HIGH-065 — this fixture sets ARIA_WORKSPACE_BASE and its
        # tearDown used to POP it, leaving the rest of the interpreter with
        # no base at all (every later fixture then wrote under ~/.aria).
        # Scope the whole environment to the test instead.
        _environment = patch.dict(os.environ)
        _environment.start()
        self.addCleanup(_environment.stop)
        self._tmpdir = tempfile.TemporaryDirectory()
        self.tmp = Path(self._tmpdir.name)
        self.repo = git_fixtures.make_repo_with_initial_commit(
            self.tmp, files={"a.txt": "alpha\n"},
            remote_url="https://github.com/test-owner/i12.git", name="repo",
        )
        self.workspace_base = self.tmp / "ws"
        self.workspace_base.mkdir()
        os.environ["ARIA_WORKSPACE_BASE"] = str(self.workspace_base)
        migrate_workspace_v1_to_v2(
            workspace_root=self.repo, workspace_base=self.workspace_base,
            acknowledge=True, reason="Plan ARIA-V2 I-12 workspace bootstrap fixture",
        )
        self.tools_dir = self.tmp / "aria-tools"
        migrate_tools_bootstrap(
            tools_dir=self.tools_dir, workspace_root=self.repo,
            acknowledge=True, reason="Plan ARIA-V2 I-12 tools bootstrap fixture",
        )
        from aria_kernel.workspace import workspace_paths, record_workspace_governance
        paths = workspace_paths(self.repo, workspace_base=self.workspace_base)
        record_workspace_governance(paths, "test_seed", {"seed_id": "i12-row"})
        self.paths = paths

    def tearDown(self) -> None:
        os.environ.pop("ARIA_WORKSPACE_BASE", None)
        self._tmpdir.cleanup()

    def test_reset_succeeds_with_backup(self) -> None:
        backup_to = self.tmp / "backup-i12"
        pre_gov_bytes = (self.paths.ledgers["governance"]).read_bytes()
        result = reset_memory(
            workspace_root=self.repo, workspace_base=self.workspace_base,
            backup_to=backup_to, base_dir=self.tools_dir,
            reason="Plan ARIA-V2 I-12 reset for memory state recovery",
            acknowledge=True,
        )
        self.assertEqual(result["result"], "SUCCESS")
        self.assertTrue(backup_to.exists())
        backup_gov = backup_to / "governance.jsonl"
        self.assertTrue(backup_gov.exists())
        self.assertEqual(backup_gov.read_bytes(), pre_gov_bytes)
        self.assertTrue(self.paths.memory_dir.exists())

    def test_reset_rejects_existing_backup_path(self) -> None:
        backup_to = self.tmp / "preexisting-backup"
        backup_to.mkdir()
        with self.assertRaises(GovernanceError) as cm:
            reset_memory(
                workspace_root=self.repo, workspace_base=self.workspace_base,
                backup_to=backup_to, base_dir=self.tools_dir,
                reason="Plan ARIA-V2 I-12 reset rejects pre-existing backup",
                acknowledge=True,
            )
        self.assertIn("backup_path_exists", str(cm.exception))

    def test_reset_emits_to_workspace_ledger_not_tools(self) -> None:
        backup_to = self.tmp / "backup-i35"
        reset_memory(
            workspace_root=self.repo, workspace_base=self.workspace_base,
            backup_to=backup_to, base_dir=self.tools_dir,
            reason="Plan ARIA-V2 I-35 reset emits to workspace ledger",
            acknowledge=True,
        )
        ws_rows = read_jsonl(self.paths.ledgers["governance"])
        ws_reset = [r for r in ws_rows if r.get("kind") == "memory_reset"]
        self.assertEqual(len(ws_reset), 1)
        tools_rows = read_jsonl(self.tools_dir / "governance.jsonl")
        tools_reset = [r for r in tools_rows if r.get("kind") == "memory_reset"]
        self.assertEqual(len(tools_reset), 0)

    def test_reset_row_shape(self) -> None:
        backup_to = self.tmp / "backup-i36"
        reset_memory(
            workspace_root=self.repo, workspace_base=self.workspace_base,
            backup_to=backup_to, base_dir=self.tools_dir,
            reason="Plan ARIA-V2 I-36 reset row mandatory fields",
            acknowledge=True,
        )
        ws_rows = read_jsonl(self.paths.ledgers["governance"])
        reset_row = [r for r in ws_rows if r.get("kind") == "memory_reset"][0]
        details = reset_row["details"]
        self.assertIn("actor", details)
        self.assertIn("reason", details)
        self.assertIn("pre_reset_fates_hash", details)
        self.assertIn("backup_path", details)
        self.assertEqual(details["result"], "SUCCESS")


class RebuildBlockedInFrozenProfileTests(unittest.TestCase):
    """Plan ARIA-V2 I-13 — frozen profile rejects rebuild-fates."""

    def setUp(self) -> None:
        # ARIA-HIGH-065 — this fixture sets ARIA_WORKSPACE_BASE and its
        # tearDown used to POP it, leaving the rest of the interpreter with
        # no base at all (every later fixture then wrote under ~/.aria).
        # Scope the whole environment to the test instead.
        _environment = patch.dict(os.environ)
        _environment.start()
        self.addCleanup(_environment.stop)
        self._tmpdir = tempfile.TemporaryDirectory()
        self.tmp = Path(self._tmpdir.name)
        self.repo = git_fixtures.make_repo_with_initial_commit(
            self.tmp, files={"a.txt": "alpha\n"},
            remote_url="https://github.com/test-owner/i13b.git", name="repo",
        )
        self.workspace_base = self.tmp / "ws"
        self.workspace_base.mkdir()
        os.environ["ARIA_WORKSPACE_BASE"] = str(self.workspace_base)
        migrate_workspace_v1_to_v2(
            workspace_root=self.repo, workspace_base=self.workspace_base,
            acknowledge=True, reason="Plan ARIA-V2 I-13b workspace bootstrap fixture",
        )
        self.tools_dir = self.tmp / "aria-tools"
        migrate_tools_bootstrap(
            tools_dir=self.tools_dir, workspace_root=self.repo,
            acknowledge=True, reason="Plan ARIA-V2 I-13b tools bootstrap fixture",
        )

    def tearDown(self) -> None:
        os.environ.pop("ARIA_WORKSPACE_BASE", None)
        self._tmpdir.cleanup()

    def test_frozen_profile_rejects_rebuild_fates(self) -> None:
        from aria_kernel.runtime_profile import set_profile
        set_profile("frozen", operator_approval_ref="OPR-i13b-test", base_dir=str(self.tools_dir))
        with self.assertRaises(GovernanceError) as cm:
            rebuild_fates(
                cycle_id="frozen-test", workspace_root=self.repo,
                workspace_base=self.workspace_base, base_dir=self.tools_dir,
                reason="Plan ARIA-V2 I-13b should reject under frozen",
                acknowledge=True,
            )
        msg = str(cm.exception).lower()
        self.assertTrue(
            any(token in msg for token in ("frozen", "profile", "rejected", "violation")),
            f"expected frozen-profile rejection, got: {cm.exception}",
        )


if __name__ == "__main__":
    unittest.main()
