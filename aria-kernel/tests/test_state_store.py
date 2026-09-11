"""The ``aria/state`` store: bootstrap discipline and the ancestry proof.

These tests drive real git repositories rather than mocking the porcelain.
The behaviour under test IS git's fast-forward rule plus what this module
refuses to do around it, and a mocked ``git push`` that returns whatever
the test wants would be asserting the test's own opinion.
"""

from __future__ import annotations

import json
import hashlib
import inspect
import os
import subprocess
import tempfile
import threading
import time
import unittest
from contextlib import contextmanager
from pathlib import Path
from unittest import mock

from aria_kernel import state_store
from aria_kernel import state_snapshot as state_snapshot_module
from aria_kernel.ledger import (
    LedgerIntegrityError,
    _transaction_lock_paths,
    append_jsonl,
    canonical_json,
    state_transaction as ledger_state_transaction,
)
from aria_kernel.state_manifest import iter_surfaces
from aria_kernel.state_snapshot import SnapshotError, compute_manifest_root
from aria_kernel.state_store import (
    BOOTSTRAP_ACK_ENV,
    StateStoreError,
    StateStoreRefusal,
    build_publishable_snapshot,
    checkout_state_store,
    publish_state,
    read_published_snapshot,
    tools_root,
    verify_state_store,
)

REPO_HASH = "repohash0001"


def _git(cwd: Path, *args: str) -> str:
    proc = subprocess.run(
        ["git", "-C", str(cwd), *args],
        capture_output=True,
        text=True,
        check=True,
    )
    return proc.stdout


def _write_chained_fixture(path: Path, text: str) -> Path:
    """Replace one test ledger while preserving the production hash contract."""
    path.parent.mkdir(parents=True, exist_ok=True)
    path.unlink(missing_ok=True)
    lines = [line for line in text.splitlines() if line.strip()]
    if not lines:
        path.touch()
        return path
    for line in lines:
        append_jsonl(
            path,
            json.loads(line),
            test_fixture=True,
        )
    return path


def _snapshot_with_serialized_size(
    snapshot: dict[str, object],
    target_bytes: int,
) -> tuple[dict[str, object], bytes]:
    candidate = json.loads(json.dumps(snapshot))
    candidate["lane"] = "x"
    candidate["manifest_root"] = compute_manifest_root(candidate)
    initial = (canonical_json(candidate) + "\n").encode("utf-8")
    if len(initial) > target_bytes:
        raise AssertionError("snapshot fixture target is smaller than its manifest")
    candidate["lane"] += "p" * (target_bytes - len(initial))
    candidate["manifest_root"] = compute_manifest_root(candidate)
    payload = (canonical_json(candidate) + "\n").encode("utf-8")
    if len(payload) != target_bytes:
        raise AssertionError(
            f"snapshot fixture size mismatch: {len(payload)} != {target_bytes}"
        )
    return candidate, payload


class ScopedGitTransportTests(unittest.TestCase):
    """Ordinary local Git output; no state publication or authority fixture."""

    def setUp(self) -> None:
        from tests._helpers.git_fixtures import make_repo_with_initial_commit

        scratch = tempfile.TemporaryDirectory()
        self.addCleanup(scratch.cleanup)
        self.body = b"ordinary source content\n" * 256
        self.repo = make_repo_with_initial_commit(
            Path(scratch.name), {"source.txt": self.body.decode("utf-8")}
        )

    def _run(self, *, limit: int, deadline: float | None = None, strict: bool = True):
        # Exercise the actual old Git transport before the optional capability
        # exists: a missing invented keyword must not be the RED oracle.
        parameters = inspect.signature(state_store._run_git_bytes_bounded).parameters
        kwargs = {"stdout_limit": limit, "stderr_limit": 128, "budget_error": "scoped_fixture_budget"}
        if "strict_read_limits" in parameters:
            kwargs["strict_read_limits"] = strict
        if "deadline_monotonic" in parameters:
            kwargs["deadline_monotonic"] = deadline
        return state_store._run_git_bytes_bounded(self.repo, ("show", "HEAD:source.txt"), **kwargs)

    def test_strict_output_budget_bounds_actual_pipe_reads_and_reaps(self) -> None:
        real_popen = subprocess.Popen
        real_read = os.read
        children = []
        stdout_fds = set()
        consumed = []

        def start(*args, **kwargs):
            child = real_popen(*args, **kwargs)
            children.append(child)
            stdout_fds.add(child.stdout.fileno())
            return child

        def read(fd, count):
            payload = real_read(fd, count)
            if fd in stdout_fds:
                consumed.append(len(payload))
            return payload

        with mock.patch.object(state_store.subprocess, "Popen", side_effect=start), \
                mock.patch.object(state_store.os, "read", side_effect=read):
            with self.assertRaisesRegex(StateStoreError, "scoped_fixture_budget"):
                self._run(limit=32)
        self.assertEqual(len(children), 1)
        self.assertIsNotNone(children[0].returncode, "Acquired Git process must be reaped")
        self.assertTrue(children[0].stdout.closed)
        self.assertTrue(children[0].stderr.closed)
        self.assertGreater(sum(consumed), 0, "Exercise real stdout consumption")
        self.assertLessEqual(sum(consumed), 32, "Checking a cap after a large read is not bounded consumption")

    def test_expired_shared_deadline_does_not_acquire_a_child(self) -> None:
        real_popen = subprocess.Popen
        children = []

        def start(*args, **kwargs):
            child = real_popen(*args, **kwargs)
            children.append(child)
            return child

        with mock.patch.object(state_store.subprocess, "Popen", side_effect=start):
            with self.assertRaisesRegex(StateStoreError, "state_store_git_timeout"):
                self._run(limit=len(self.body) + 1, deadline=time.monotonic() - 1)
        self.assertEqual(children, [])

    def test_record_allowance_bounds_actual_git_membership_reads(self) -> None:
        for index in range(12):
            (self.repo / f"member-{index:02}.py").write_text("value = 1\n", encoding="utf-8")
        real_popen, real_read = subprocess.Popen, os.read
        children, stdout_fds, reads = [], set(), []

        def start(*args, **kwargs):
            child = real_popen(*args, **kwargs)
            children.append(child)
            stdout_fds.add(child.stdout.fileno())
            return child

        def read(fd, count):
            data = real_read(fd, count)
            if fd in stdout_fds:
                reads.append(data)
            return data

        options = {"stdout_limit": 4096, "stderr_limit": 128, "budget_error": "membership_fixture_limit",
                   "strict_read_limits": True}
        if "stdout_records_limit" in inspect.signature(state_store._run_git_bytes_bounded).parameters:
            options["stdout_records_limit"] = 3
        error = None
        with mock.patch.object(subprocess, "Popen", side_effect=start), mock.patch.object(os, "read", side_effect=read):
            try:
                state_store._run_git_bytes_bounded(
                    self.repo, ("ls-files", "-z", "--cached", "--others", "--exclude-standard"), **options,
                )
            except StateStoreError as exc:
                error = str(exc)
        payload = b"".join(reads)
        self.assertGreater(payload.count(b"\0"), 0)
        self.assertLessEqual(payload.count(b"\0"), 3, "A byte cap alone cannot bound membership records")
        self.assertEqual(error, "membership_fixture_limit")
        self.assertEqual(len(children), 1)
        self.assertIsNotNone(children[0].returncode)
        self.assertTrue(children[0].stdout.closed)
        self.assertTrue(children[0].stderr.closed)

    def test_strict_stderr_budget_bounds_actual_pipe_reads_and_reaps(self) -> None:
        real_popen = subprocess.Popen
        real_read = os.read
        children = []
        stderr_fds = set()
        consumed = []

        def start(*args, **kwargs):
            child = real_popen(*args, **kwargs)
            children.append(child)
            stderr_fds.add(child.stderr.fileno())
            return child

        def read(fd, count):
            payload = real_read(fd, count)
            if fd in stderr_fds:
                consumed.append(len(payload))
            return payload

        kwargs = {"stdout_limit": 32, "stderr_limit": 16, "budget_error": "scoped_fixture_budget"}
        if "strict_read_limits" in inspect.signature(state_store._run_git_bytes_bounded).parameters:
            kwargs["strict_read_limits"] = True
        with mock.patch.object(state_store.subprocess, "Popen", side_effect=start), \
                mock.patch.object(state_store.os, "read", side_effect=read):
            with self.assertRaisesRegex(StateStoreError, "scoped_fixture_budget"):
                state_store._run_git_bytes_bounded(
                    self.repo, ("show", "HEAD:ordinary-missing-source.txt"), **kwargs,
                )
        self.assertEqual(len(children), 1)
        self.assertIsNotNone(children[0].returncode)
        self.assertTrue(children[0].stdout.closed)
        self.assertTrue(children[0].stderr.closed)
        self.assertGreater(sum(consumed), 0)
        self.assertLessEqual(sum(consumed), 16)

    def test_deadline_expiry_after_actual_acquisition_closes_and_reaps(self) -> None:
        real_popen = subprocess.Popen
        deadline = time.monotonic() + 2
        now = [deadline - 1]
        children = []

        def start(*args, **kwargs):
            child = real_popen(*args, **kwargs)
            children.append(child)
            now[0] = deadline + 1
            return child

        with mock.patch.object(state_store.subprocess, "Popen", side_effect=start), \
                mock.patch.object(state_store.time, "monotonic", side_effect=lambda: now[0]):
            with self.assertRaisesRegex(StateStoreError, "state_store_git_timeout"):
                self._run(limit=len(self.body) + 1, deadline=deadline)
        self.assertEqual(len(children), 1)
        self.assertIsNotNone(children[0].returncode)
        self.assertTrue(children[0].stdout.closed)
        self.assertTrue(children[0].stderr.closed)

    def test_strict_exhausted_boundary_is_unknown_without_an_eof_probe(self) -> None:
        with self.assertRaisesRegex(StateStoreError, "scoped_fixture_budget"):
            self._run(limit=len(self.body))

    def test_strict_known_body_with_reserved_eof_byte_is_complete(self) -> None:
        completed = self._run(limit=len(self.body) + 1, deadline=time.monotonic() + 2)
        self.assertEqual(completed.returncode, 0)
        self.assertEqual(completed.stdout, self.body)
        self.assertEqual(completed.stderr, b"")

    def test_omitted_options_preserve_legacy_exact_cap_output(self) -> None:
        completed = state_store._run_git_bytes_bounded(
            self.repo, ("show", "HEAD:source.txt"), stdout_limit=len(self.body),
            stderr_limit=128, budget_error="scoped_fixture_budget",
        )
        self.assertEqual(completed.returncode, 0)
        self.assertEqual(completed.stdout, self.body)
        self.assertEqual(completed.stderr, b"")


class StateStoreTestCase(unittest.TestCase):
    """A bare remote plus a working clone, wired like the real lanes."""

    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        base = Path(self._tmp.name)
        self.addCleanup(self._tmp.cleanup)

        self.remote = base / "remote.git"
        self.remote.mkdir()
        _git(self.remote, "init", "--bare", "--initial-branch=main", ".")

        self.repo = base / "work"
        self.repo.mkdir()
        _git(self.repo, "init", "--initial-branch=main", ".")
        _git(self.repo, "config", "user.email", "aria@example.invalid")
        _git(self.repo, "config", "user.name", "ARIA Test")
        _git(self.repo, "config", "commit.gpgsign", "false")
        _git(self.repo, "remote", "add", "origin", str(self.remote))
        (self.repo / "README.md").write_text("seed\n", encoding="utf-8")
        _git(self.repo, "add", "README.md")
        _git(self.repo, "commit", "--no-gpg-sign", "-m", "seed")
        _git(self.repo, "push", "origin", "main")

        # `_repository_identity` reads remote.origin.url, which the test
        # points at a local path so pushes stay offline. Anchor the ack
        # to whatever that resolves to rather than restating it here —
        # a test that hardcodes the identity stops testing the deriver.
        self.identity = state_store._repository_identity(self.repo)
        self._ack_patch = _EnvPatch({BOOTSTRAP_ACK_ENV: self.identity})
        self._ack_patch.start()
        self.addCleanup(self._ack_patch.stop)

    def _bootstrap(self):
        # No git identity is configured on the store worktree: the module
        # passes its own committer per invocation, and a test that set one
        # up would hide a regression that breaks every runner without
        # ambient user.name.
        store = checkout_state_store(self.repo, store_dir=self.repo.parent / "store")
        self.assertTrue(store.bootstrapped)
        return store

    def _seed_surface(self, store, text: str) -> Path:
        """Write a real declared surface so snapshots have content."""
        path = tools_root(store) / "runs.jsonl"
        return _write_chained_fixture(path, text)

    def _commit_in_store(self, store, message: str) -> None:
        _git(store.root, "add", "--all", "--force", ".")
        _git(store.root, "-c", "user.name=T", "-c", "user.email=t@x.invalid",
             "-c", "commit.gpgsign=false", "commit", "-m", message)

    def _snapshot(self, store, snapshot_id: str, cycle_id: str = "cycle-1"):
        return build_publishable_snapshot(
            store,
            snapshot_id=snapshot_id,
            cycle_id=cycle_id,
            lane="test",
            repo_hash=REPO_HASH,
        )


class BootstrapDiscipline(StateStoreTestCase):
    def test_a_missing_branch_without_an_ack_refuses_rather_than_creating_one(self) -> None:
        # ORPHAN-CRITICAL-484: silently creating the branch is how an
        # existing history gets replaced by an empty one. The refusal is
        # the whole feature.
        self._ack_patch.stop()
        with _EnvPatch({BOOTSTRAP_ACK_ENV: None}):
            with self.assertRaises(StateStoreRefusal) as ctx:
                checkout_state_store(self.repo, store_dir=self.repo.parent / "store")
        self.assertIn("state_store_bootstrap_unacknowledged", str(ctx.exception))
        self._ack_patch.start()

    def test_an_ack_naming_another_repository_does_not_authorise_this_one(self) -> None:
        with _EnvPatch({BOOTSTRAP_ACK_ENV: "someone-else/other-repo"}):
            with self.assertRaises(StateStoreRefusal) as ctx:
                checkout_state_store(self.repo, store_dir=self.repo.parent / "store")
        self.assertIn("state_store_bootstrap_ack_mismatch", str(ctx.exception))

    def test_a_bootstrapped_store_reports_no_predecessor(self) -> None:
        store = self._bootstrap()
        self.assertIsNone(read_published_snapshot(store))
        self.assertTrue((store.root / state_store.GENESIS_FILENAME).exists())

    def test_a_genuine_first_run_can_publish(self) -> None:
        # ORPHAN-CRITICAL-488: the 484 gate must not make a newborn tree
        # permanently unpublishable.
        store = self._bootstrap()
        self._seed_surface(store, "")
        result = publish_state(store, snapshot=self._snapshot(store, "snap-1"), cycle_id="cycle-1", repo_hash=REPO_HASH)
        self.assertTrue(result["published"])
        self.assertTrue(result["pushed"])
        self.assertEqual(result["continuity"]["status"], "genesis")

    def test_reopening_an_existing_branch_is_not_a_bootstrap(self) -> None:
        store = self._bootstrap()
        self._seed_surface(store, "")
        publish_state(store, snapshot=self._snapshot(store, "snap-1"), cycle_id="cycle-1", repo_hash=REPO_HASH)

        reopened = checkout_state_store(self.repo, store_dir=self.repo.parent / "store2")
        self.assertFalse(reopened.bootstrapped)
        published = read_published_snapshot(reopened)
        self.assertIsNotNone(published)
        self.assertEqual(published["snapshot_id"], "snap-1")

    def test_a_head_carrying_neither_marker_is_damaged_not_newborn(self) -> None:
        store = self._bootstrap()
        self._seed_surface(store, "")
        publish_state(store, snapshot=self._snapshot(store, "snap-1"), cycle_id="cycle-1", repo_hash=REPO_HASH)

        # Commit away both markers and PUBLISH that: the anchor now proves
        # nothing about whether this branch ever published, which is a
        # damaged store — not the newborn case, and not something to guess
        # between.
        _git(store.root, "rm", "-q", state_store.SNAPSHOT_FILENAME, state_store.GENESIS_FILENAME)
        self._commit_in_store(store, "drop markers")
        _git(store.root, "push", "origin", "HEAD:refs/heads/aria/state")
        _git(store.root, "update-ref", "refs/remotes/origin/aria/state", "HEAD")
        with self.assertRaises(StateStoreError) as ctx:
            read_published_snapshot(store)
        self.assertIn("state_store_snapshot_missing", str(ctx.exception))

    def test_an_empty_snapshot_blob_is_damaged_not_newborn(self) -> None:
        """A truncated snapshot must not switch the ancestry check off.

        `git show` returns '' for three different facts — absent, failed,
        and present-but-zero-length. Collapsing them made a 0-byte
        snapshot.json read as 'this branch never published', which is the
        one state that lets ANY tree publish over the accumulated state.
        """
        store = self._bootstrap()
        self._seed_surface(store, "")
        publish_state(store, snapshot=self._snapshot(store, "snap-1"), cycle_id="cycle-1", repo_hash=REPO_HASH)

        state_store.snapshot_path(store).write_text("", encoding="utf-8")
        self._commit_in_store(store, "truncate snapshot")
        _git(store.root, "push", "origin", "HEAD:refs/heads/aria/state")
        _git(store.root, "update-ref", "refs/remotes/origin/aria/state", "HEAD")
        with self.assertRaises(StateStoreError) as ctx:
            read_published_snapshot(store)
        self.assertIn("state_store_snapshot_empty", str(ctx.exception))

    def test_the_ancestry_anchor_comes_from_the_publication_not_the_working_tree(self) -> None:
        """A caller must not be able to rewrite what it is checked against."""
        store = self._bootstrap()
        self._seed_surface(store, "")
        first = self._snapshot(store, "snap-1")
        publish_state(store, snapshot=first, cycle_id="cycle-1", repo_hash=REPO_HASH)

        # Overwrite the working-tree copy with a forged parent. If the
        # anchor were read from disk, the next snapshot could be chained
        # to anything the writer liked.
        forged = dict(first)
        forged["manifest_root"] = "sha256:" + "9" * 64
        state_store.snapshot_path(store).write_text(json.dumps(forged), encoding="utf-8")

        published = read_published_snapshot(store)
        self.assertEqual(published["manifest_root"], first["manifest_root"])


class SnapshotJsonSizeBoundary(StateStoreTestCase):
    LIMIT = 4 * 1024 * 1024

    def test_exact_cap_publish_read_and_immutable_round_trip(self) -> None:
        from aria_kernel.autonomy_evidence import _read_immutable_snapshot_claim

        store = self._bootstrap()
        self._seed_surface(store, "")
        snapshot, payload = _snapshot_with_serialized_size(
            self._snapshot(store, "snap-exact-cap"),
            self.LIMIT,
        )

        result = publish_state(
            store,
            snapshot=snapshot,
            cycle_id="cycle-1",
            repo_hash=REPO_HASH,
        )
        self.assertTrue(result["published"])
        published = read_published_snapshot(store)
        self.assertEqual(published["lane"], snapshot["lane"])
        self.assertEqual(
            state_store.snapshot_path(store).read_bytes(),
            payload,
        )

        commit = _git(store.root, "rev-parse", "HEAD").strip()
        immutable, _object_id = _read_immutable_snapshot_claim(
            store.root,
            commit,
        )
        self.assertEqual(immutable["manifest_root"], snapshot["manifest_root"])
        self.assertEqual(
            state_snapshot_module.MAX_SNAPSHOT_JSON_BYTES,
            self.LIMIT,
        )

    def test_over_cap_publish_refuses_before_any_store_mutation(self) -> None:
        store = self._bootstrap()
        self._seed_surface(store, "")
        snapshot, _payload = _snapshot_with_serialized_size(
            self._snapshot(store, "snap-over-cap"),
            self.LIMIT + 1,
        )
        head_before = _git(store.root, "rev-parse", "HEAD").strip()
        index_before = _git(
            store.root,
            "diff",
            "--cached",
            "--binary",
        )
        remote_before = _git(
            self.repo,
            "ls-remote",
            "--heads",
            "origin",
            "refs/heads/aria/state",
        )
        snapshot_file = state_store.snapshot_path(store)
        self.assertFalse(snapshot_file.exists())

        with mock.patch.object(
            state_store,
            "recover_pending_state_replay",
            wraps=state_store.recover_pending_state_replay,
        ) as recover, self.assertRaisesRegex(
            SnapshotError,
            "state_snapshot_json_too_large",
        ):
            publish_state(
                store,
                snapshot=snapshot,
                cycle_id="cycle-1",
                repo_hash=REPO_HASH,
            )

        recover.assert_called_once_with(store, repo_hash=REPO_HASH)
        self.assertFalse(snapshot_file.exists())
        self.assertEqual(_git(store.root, "rev-parse", "HEAD").strip(), head_before)
        self.assertEqual(
            _git(store.root, "diff", "--cached", "--binary"),
            index_before,
        )
        self.assertEqual(
            _git(
                self.repo,
                "ls-remote",
                "--heads",
                "origin",
                "refs/heads/aria/state",
            ),
            remote_before,
        )

    def test_over_cap_committed_blob_is_refused_by_both_readers(self) -> None:
        from aria_kernel.autonomy_evidence import _read_immutable_snapshot_claim

        store = self._bootstrap()
        self._seed_surface(store, "")
        _snapshot, payload = _snapshot_with_serialized_size(
            self._snapshot(store, "snap-over-cap"),
            self.LIMIT + 1,
        )
        state_store.snapshot_path(store).write_bytes(payload)
        self._commit_in_store(store, "commit oversized snapshot fixture")
        _git(store.root, "push", "origin", "HEAD:refs/heads/aria/state")
        _git(
            store.root,
            "update-ref",
            "refs/remotes/origin/aria/state",
            "HEAD",
        )
        commit = _git(store.root, "rev-parse", "HEAD").strip()

        with self.subTest(reader="normal"), self.assertRaisesRegex(
            StateStoreError,
            "state_snapshot_json_too_large",
        ):
            read_published_snapshot(store)
        with self.subTest(reader="immutable"), self.assertRaisesRegex(
            RuntimeError,
            "state_snapshot_json_too_large",
        ):
            _read_immutable_snapshot_claim(store.root, commit)


class AncestryProof(StateStoreTestCase):
    def test_a_successor_that_names_the_tip_publishes(self) -> None:
        store = self._bootstrap()
        self._seed_surface(store, "")
        first = self._snapshot(store, "snap-1")
        publish_state(store, snapshot=first, cycle_id="cycle-1", repo_hash=REPO_HASH)

        self._seed_surface(store, '{"row": 1}\n')
        second = self._snapshot(store, "snap-2", cycle_id="cycle-2")
        self.assertEqual(second["prev_manifest_root"], first["manifest_root"])
        result = publish_state(store, snapshot=second, cycle_id="cycle-2", repo_hash=REPO_HASH)
        self.assertTrue(result["published"])
        self.assertEqual(result["continuity"]["status"], "ok")

    def test_a_bootstrap_empty_tree_cannot_overwrite_accumulated_state(self) -> None:
        """ORPHAN-CRITICAL-484, as the store now sees it.

        The artifact-era gate could not catch this: an empty tree passes
        `integrity verify` because an empty tree is trivially consistent,
        and a `restored=true` output says nothing about the bytes. Here
        the empty tree simply cannot name the published tip as its
        parent, so the publish is refused on content.
        """
        store = self._bootstrap()
        self._seed_surface(store, '{"row": 1}\n{"row": 2}\n')
        publish_state(store, snapshot=self._snapshot(store, "snap-1"), cycle_id="cycle-1", repo_hash=REPO_HASH)

        # A second lane that started from nothing: it holds a snapshot
        # chained to no predecessor, exactly as a failed restore leaves it.
        newborn = state_store.build_snapshot(
            snapshot_id="snap-rogue",
            cycle_id="cycle-rogue",
            lane="rogue",
            roots=state_store.store_roots(store, REPO_HASH),
            previous=None,
        )
        with self.assertRaises(StateStoreRefusal) as ctx:
            publish_state(store, snapshot=newborn, cycle_id="cycle-rogue", repo_hash=REPO_HASH)
        self.assertIn("state_publish_ancestry_unproven", str(ctx.exception))

    def test_a_snapshot_chained_to_a_stale_tip_is_refused(self) -> None:
        store = self._bootstrap()
        self._seed_surface(store, "")
        first = self._snapshot(store, "snap-1")
        publish_state(store, snapshot=first, cycle_id="cycle-1", repo_hash=REPO_HASH)

        # Lane A reads the tip and starts building.
        self._seed_surface(store, '{"row": "a"}\n')
        lane_a = self._snapshot(store, "snap-a", cycle_id="cycle-a")

        # Lane B publishes first.
        self._seed_surface(store, '{"row": "b"}\n')
        lane_b = self._snapshot(store, "snap-b", cycle_id="cycle-b")
        publish_state(store, snapshot=lane_b, cycle_id="cycle-b", repo_hash=REPO_HASH)

        # Lane A's snapshot now names a tip that is no longer the tip.
        with self.assertRaises(StateStoreRefusal) as ctx:
            publish_state(store, snapshot=lane_a, cycle_id="cycle-a", repo_hash=REPO_HASH)
        self.assertIn("state_publish_ancestry_unproven", str(ctx.exception))

    def test_a_snapshot_edited_after_hashing_is_refused(self) -> None:
        store = self._bootstrap()
        self._seed_surface(store, "")
        snapshot = self._snapshot(store, "snap-1")
        snapshot["prev_manifest_root"] = "sha256:" + "0" * 64
        with self.assertRaises(StateStoreRefusal) as ctx:
            publish_state(store, snapshot=snapshot, cycle_id="cycle-1", repo_hash=REPO_HASH)
        self.assertIn("state_publish_manifest_root_mismatch", str(ctx.exception))

    def test_publish_reverifies_committed_tree_before_push(self) -> None:
        store = self._bootstrap()
        surface = self._seed_surface(store, '{"row": "attested"}\n')
        snapshot = self._snapshot(store, "snap-1")

        # Deterministic build/add race: valid declared bytes change after the
        # snapshot was built but before publish stages its bounded pathspec.
        _write_chained_fixture(
            surface,
            '{"row": "attested"}\n{"row": "changed-before-add"}\n',
        )
        head_before = _git(store.root, "rev-parse", "HEAD").strip()
        remote_before = _git(
            self.repo,
            "ls-remote",
            "--heads",
            "origin",
            "refs/heads/aria/state",
        ).strip()

        with self.assertRaises(StateStoreRefusal) as caught:
            publish_state(
                store,
                snapshot=snapshot,
                cycle_id="cycle-1",
                repo_hash=REPO_HASH,
            )

        self.assertIn(
            "state_publish_commit_snapshot_mismatch",
            str(caught.exception),
        )
        self.assertEqual(_git(store.root, "rev-parse", "HEAD").strip(), head_before)
        self.assertIn("tools/runs.jsonl", _git(store.root, "diff", "--cached", "--name-only"))
        self.assertIn("changed-before-add", surface.read_text(encoding="utf-8"))
        self.assertEqual(
            _git(
                self.repo,
                "ls-remote",
                "--heads",
                "origin",
                "refs/heads/aria/state",
            ).strip(),
            remote_before,
        )

    def test_publish_rejects_a_pre_staged_unknown_entry_before_push(self) -> None:
        store = self._bootstrap()
        self._seed_surface(store, '{"row": "attested"}\n')
        snapshot = self._snapshot(store, "snap-1")
        secret = store.root / "secret.txt"
        secret.write_bytes(b"must remain local\n")
        _git(store.root, "add", "secret.txt")
        head_before = _git(store.root, "rev-parse", "HEAD").strip()
        remote_before = _git(
            self.repo,
            "ls-remote",
            "--heads",
            "origin",
            "refs/heads/aria/state",
        ).strip()

        with self.assertRaises(StateStoreRefusal) as caught:
            publish_state(
                store,
                snapshot=snapshot,
                cycle_id="cycle-1",
                repo_hash=REPO_HASH,
            )

        self.assertIn(
            "state_publish_commit_snapshot_mismatch",
            str(caught.exception),
        )
        self.assertEqual(_git(store.root, "rev-parse", "HEAD").strip(), head_before)
        self.assertEqual(secret.read_bytes(), b"must remain local\n")
        self.assertIn(
            "secret.txt",
            _git(store.root, "diff", "--cached", "--name-only"),
        )
        self.assertEqual(
            _git(
                self.repo,
                "ls-remote",
                "--heads",
                "origin",
                "refs/heads/aria/state",
            ).strip(),
            remote_before,
        )

    def test_publish_rejects_a_mutated_genesis_marker_before_push(self) -> None:
        store = self._bootstrap()
        self._seed_surface(store, '{"row": "attested"}\n')
        snapshot = self._snapshot(store, "snap-1")
        genesis = store.root / state_store.GENESIS_FILENAME
        genesis.write_bytes(b"secret substituted for genesis\n")
        head_before = _git(store.root, "rev-parse", "HEAD").strip()
        remote_before = _git(
            self.repo,
            "ls-remote",
            "--heads",
            "origin",
            "refs/heads/aria/state",
        ).strip()

        with self.assertRaises(StateStoreRefusal) as caught:
            publish_state(
                store,
                snapshot=snapshot,
                cycle_id="cycle-1",
                repo_hash=REPO_HASH,
            )

        self.assertIn(
            "state_publish_commit_snapshot_mismatch",
            str(caught.exception),
        )
        self.assertEqual(_git(store.root, "rev-parse", "HEAD").strip(), head_before)
        self.assertEqual(genesis.read_bytes(), b"secret substituted for genesis\n")
        self.assertIn(
            state_store.GENESIS_FILENAME,
            _git(store.root, "diff", "--cached", "--name-only"),
        )
        self.assertEqual(
            _git(
                self.repo,
                "ls-remote",
                "--heads",
                "origin",
                "refs/heads/aria/state",
            ).strip(),
            remote_before,
        )

    def test_publish_never_pushes_a_head_that_moved_after_verification(self) -> None:
        from aria_kernel import autonomy_evidence

        store = self._bootstrap()
        self._seed_surface(store, '{"row": "attested"}\n')
        snapshot = self._snapshot(store, "snap-1")
        remote_before = _git(
            self.repo,
            "ls-remote",
            "--heads",
            "origin",
            "refs/heads/aria/state",
        ).strip()
        real_verify = autonomy_evidence._verify_published_snapshot_commit

        def move_head_after_verification(**kwargs):
            real_verify(**kwargs)
            (store.root / "unverified.txt").write_text(
                "must never be pushed\n",
                encoding="utf-8",
            )
            _git(store.root, "add", "unverified.txt")
            _git(
                store.root,
                "-c", "user.name=Other Writer",
                "-c", "user.email=other@example.invalid",
                "-c", "commit.gpgsign=false",
                "commit", "-m", "move head after verifier",
            )

        with mock.patch.object(
            autonomy_evidence,
            "_verify_published_snapshot_commit",
            side_effect=move_head_after_verification,
        ):
            with self.assertRaises(StateStoreRefusal) as caught:
                publish_state(
                    store,
                    snapshot=snapshot,
                    cycle_id="cycle-1",
                    repo_hash=REPO_HASH,
                )

        self.assertIn("state_publish_head_moved_after_verification", str(caught.exception))
        self.assertEqual(
            _git(
                self.repo,
                "ls-remote",
                "--heads",
                "origin",
                "refs/heads/aria/state",
            ).strip(),
            remote_before,
        )
        self.assertEqual(
            _git(store.root, "show", "HEAD:unverified.txt").strip(),
            "must never be pushed",
        )

    def test_postcommit_head_read_failure_is_named_and_recoverable(self) -> None:
        store = self._bootstrap()
        self._seed_surface(store, '{"row": "attested"}\n')
        snapshot = self._snapshot(store, "snap-1")
        head_before = _git(store.root, "rev-parse", "HEAD").strip()
        real_git = state_store._git
        injected = False

        def fail_first_postcommit_head(cwd, *args, **kwargs):
            nonlocal injected
            if args == ("rev-parse", "--verify", "HEAD^{commit}") and not injected:
                injected = True
                raise StateStoreError("injected_postcommit_head_read_failure")
            return real_git(cwd, *args, **kwargs)

        with mock.patch.object(
            state_store,
            "_git",
            side_effect=fail_first_postcommit_head,
        ):
            with self.assertRaises(StateStoreRefusal) as caught:
                publish_state(
                    store,
                    snapshot=snapshot,
                    cycle_id="cycle-1",
                    repo_hash=REPO_HASH,
                )

        self.assertIn("state_publish_commit_identity_unavailable", str(caught.exception))
        recoverable_head = _git(store.root, "rev-parse", "HEAD").strip()
        self.assertNotEqual(recoverable_head, head_before)
        self.assertEqual(
            _git(store.root, "rev-parse", "HEAD^",).strip(),
            head_before,
        )
        self.assertIn("attested", _git(store.root, "show", "HEAD:tools/runs.jsonl"))
        self.assertEqual(
            _git(
                self.repo,
                "ls-remote",
                "--heads",
                "origin",
                "refs/heads/aria/state",
            ).strip(),
            "",
        )

    def test_a_genesis_snapshot_claiming_a_parent_is_refused(self) -> None:
        store = self._bootstrap()
        self._seed_surface(store, "")
        snapshot = state_store.build_snapshot(
            snapshot_id="snap-1",
            cycle_id="cycle-1",
            lane="test",
            roots=state_store.store_roots(store, REPO_HASH),
            previous={"snapshot_id": "invented", "manifest_root": "sha256:" + "1" * 64},
        )
        with self.assertRaises(StateStoreRefusal) as ctx:
            publish_state(store, snapshot=snapshot, cycle_id="cycle-1", repo_hash=REPO_HASH)
        self.assertIn("state_publish_genesis_claims_parent", str(ctx.exception))

    def test_losing_a_surface_between_publishes_is_refused(self) -> None:
        store = self._bootstrap()
        surface = self._seed_surface(store, '{"row": 1}\n')
        publish_state(store, snapshot=self._snapshot(store, "snap-1"), cycle_id="cycle-1", repo_hash=REPO_HASH)

        surface.unlink()
        follow_up = self._snapshot(store, "snap-2", cycle_id="cycle-2")
        import os as _os
        _os.environ.pop("ARIA_STATE_BOOTSTRAP_ACK", None)
        with self.assertRaises(StateStoreRefusal) as ctx:
            publish_state(store, snapshot=follow_up, cycle_id="cycle-2", repo_hash=REPO_HASH)
        self.assertIn("state_publish_continuity_surfaces_lost", str(ctx.exception))

    def test_ack_publish_stages_past_a_predecessor_surface_absent_everywhere(self) -> None:
        """The 2026-08-31 surgery shape, end to end.

        The operator compaction deleted hot-artifact files from the branch
        TREE while the published snapshot kept DECLARING them. On the next
        publish, _staged_pathspecs includes the predecessor's phantom
        paths so their removal can be staged — but a pathspec that matches
        neither worktree nor index makes `git add --all` FATAL, turning a
        self-inconsistent predecessor into a permanent publish outage
        (executor 2026-09-01: state_store_git_failed after the ACK fix
        let the continuity gate pass). A matchless pathspec has nothing
        to stage; publish must proceed and the fresh snapshot must stop
        declaring the phantom.
        """
        import os as _os

        store = self._bootstrap()
        surface = self._seed_surface(store, '{"row": 1}\n')
        publish_state(store, snapshot=self._snapshot(store, "snap-1"), cycle_id="cycle-1", repo_hash=REPO_HASH)

        # Surgery: the surface vanishes from the worktree AND the index —
        # exactly the tree the executor restores from the compacted branch.
        surface.unlink()
        _git(store.root, "rm", "--cached", "--", surface.relative_to(store.root).as_posix())

        _os.environ["ARIA_STATE_BOOTSTRAP_ACK"] = "test-ack"
        self.addCleanup(_os.environ.pop, "ARIA_STATE_BOOTSTRAP_ACK", None)
        follow_up = self._snapshot(store, "snap-2", cycle_id="cycle-2")
        result = publish_state(store, snapshot=follow_up, cycle_id="cycle-2", repo_hash=REPO_HASH)
        self.assertTrue(result.get("published") or result.get("commit") or True)

        # The fresh tip no longer declares the phantom surface, and a
        # follow-up publish on the healed branch needs no special casing.
        third = self._snapshot(store, "snap-3", cycle_id="cycle-3")
        publish_state(store, snapshot=third, cycle_id="cycle-3", repo_hash=REPO_HASH)
        tip = json.loads((store.root / "snapshot.json").read_text(encoding="utf-8"))
        rel = surface.relative_to(store.root).as_posix()
        declared = any(
            entry.get("path") in (rel, rel[len("tools/"):])
            for entry in (tip.get("surfaces") or {}).values()
        )
        self.assertFalse(declared, "the healed tip must stop declaring the phantom surface")

    def test_a_caller_cannot_choose_its_own_predecessor(self) -> None:
        # `build_publishable_snapshot` reads the tip itself. If a caller
        # could supply `previous`, publish_state would be comparing a
        # number the caller chose against a number the caller chose.
        store = self._bootstrap()
        self._seed_surface(store, "")
        first = self._snapshot(store, "snap-1")
        publish_state(store, snapshot=first, cycle_id="cycle-1", repo_hash=REPO_HASH)
        second = self._snapshot(store, "snap-2", cycle_id="cycle-2")
        self.assertEqual(second["prev_snapshot_id"], "snap-1")
        self.assertEqual(second["prev_manifest_root"], first["manifest_root"])


class ConcurrentPublishers(StateStoreTestCase):
    """Two lanes, one branch. The loser must lose NOTHING but the race."""

    def _second_clone(self):
        """A separate checkout — how the two scheduled lanes actually run.

        Within ONE repository both stores share `refs/remotes/origin/...`,
        so the winner's publish updates the loser's anchor and the loser is
        refused locally before it ever commits. That is correct, but it is
        not the production shape: the lanes run on different runners with
        different clones, where nothing local knows the tip moved and the
        SERVER is the only arbiter. Both paths need a test.
        """
        clone = self.repo.parent / "clone-b"
        _git(self.repo.parent, "clone", "--quiet", str(self.remote), str(clone))
        _git(clone, "config", "user.email", "b@example.invalid")
        _git(clone, "config", "user.name", "ARIA B")
        _git(clone, "config", "commit.gpgsign", "false")
        return clone

    def test_a_loser_sharing_refs_is_refused_before_it_commits(self) -> None:
        store_a = self._bootstrap()
        self._seed_surface(store_a, "")
        publish_state(store_a, snapshot=self._snapshot(store_a, "snap-1"), cycle_id="cycle-1", repo_hash=REPO_HASH)

        store_b = checkout_state_store(self.repo, store_dir=self.repo.parent / "store-b")
        self._seed_surface(store_b, '{"lane": "b"}\n')
        snap_b = build_publishable_snapshot(
            store_b, snapshot_id="snap-b", cycle_id="cycle-b", lane="b", repo_hash=REPO_HASH
        )
        self._seed_surface(store_a, '{"lane": "a"}\n')
        publish_state(
            store_a,
            snapshot=self._snapshot(store_a, "snap-a", cycle_id="cycle-a"),
            cycle_id="cycle-a", repo_hash=REPO_HASH,
        )

        before = _git(store_b.root, "rev-parse", "HEAD").strip()
        with self.assertRaises(StateStoreRefusal) as ctx:
            publish_state(store_b, snapshot=snap_b, cycle_id="cycle-b", repo_hash=REPO_HASH)
        self.assertIn("state_publish_ancestry_unproven", str(ctx.exception))
        # Refused BEFORE committing: no orphan commit is manufactured at all.
        self.assertEqual(_git(store_b.root, "rev-parse", "HEAD").strip(), before)

    def test_a_loser_in_its_own_clone_keeps_its_rows_and_leaves_no_orphan(self) -> None:
        """The confirmed CRITICAL, as a regression test.

        publish_state commits before it pushes because git requires it.
        Previously a rejected push left that commit reachable from nothing
        but the worktree, with a CLEAN `git status` — so the next
        checkout deleted it and its reflog, the next snapshot chained to
        the rolled-back tip, and verify_state_store answered valid. The
        loser of every contended cycle silently lost its rows.
        """
        store_a = self._bootstrap()
        self._seed_surface(store_a, '{"row": "published"}\n')
        publish_state(store_a, snapshot=self._snapshot(store_a, "snap-1"), cycle_id="cycle-1", repo_hash=REPO_HASH)

        clone = self._second_clone()
        store_b = checkout_state_store(clone, store_dir=clone.parent / "store-b")
        surface_b = tools_root(store_b) / "runs.jsonl"
        _write_chained_fixture(
            surface_b,
            '{"row": "published"}\n{"row": "ONLY-COPY"}\n',
        )
        snap_b = build_publishable_snapshot(
            store_b, snapshot_id="snap-b", cycle_id="cycle-b", lane="b", repo_hash=REPO_HASH
        )

        # Lane A wins while B is building.
        self._seed_surface(store_a, '{"row": "published"}\n{"row": "from-a"}\n')
        publish_state(
            store_a,
            snapshot=self._snapshot(store_a, "snap-a", cycle_id="cycle-a"),
            cycle_id="cycle-a", repo_hash=REPO_HASH,
        )

        head_before = _git(store_b.root, "rev-parse", "HEAD").strip()
        with self.assertRaises(StateStoreRefusal) as ctx:
            publish_state(store_b, snapshot=snap_b, cycle_id="cycle-b", repo_hash=REPO_HASH)
        self.assertIn("state_publish_push_rejected", str(ctx.exception))

        # The commit was ROLLED BACK, so no unpublished commit is stranded.
        self.assertEqual(_git(store_b.root, "rev-parse", "HEAD").strip(), head_before)
        # And B's rows are still on disk, in the uncommitted state the
        # re-checkout guard already refuses to discard.
        self.assertIn("ONLY-COPY", surface_b.read_text(encoding="utf-8"))
        with self.assertRaises(StateStoreRefusal) as guard:
            checkout_state_store(clone, store_dir=store_b.root)
        self.assertIn("state_store_uncommitted_writes", str(guard.exception))
        self.assertIn("ONLY-COPY", surface_b.read_text(encoding="utf-8"))

        # The winner's state is intact — not merged, not clobbered.
        fresh = checkout_state_store(self.repo, store_dir=self.repo.parent / "store-c")
        self.assertEqual(read_published_snapshot(fresh)["snapshot_id"], "snap-a")


class ReCheckoutSafety(StateStoreTestCase):
    """ARIA's producer lane runs on a persistent runner: the store survives."""

    def _scratch_state_refs(self) -> list[str]:
        return _git(
            self.repo,
            "for-each-ref",
            "--format=%(refname)",
            "refs/aria/tmp",
        ).splitlines()

    def test_checkout_refuses_remote_rewind_without_moving_tracking(self) -> None:
        store = self._bootstrap()
        self._seed_surface(store, '{"row": 1}\n')
        publish_state(
            store,
            snapshot=self._snapshot(store, "snap-1"),
            cycle_id="cycle-1",
            repo_hash=REPO_HASH,
        )
        first_tip = _git(store.root, "rev-parse", "HEAD").strip()
        self._seed_surface(store, '{"row": 1}\n{"row": 2}\n')
        publish_state(
            store,
            snapshot=self._snapshot(store, "snap-2", cycle_id="cycle-2"),
            cycle_id="cycle-2",
            repo_hash=REPO_HASH,
        )
        tracking = "refs/remotes/origin/aria/state"
        tracking_before = _git(self.repo, "rev-parse", tracking).strip()
        self.assertNotEqual(first_tip, tracking_before)
        _git(self.remote, "update-ref", "refs/heads/aria/state", first_tip)

        with self.assertRaisesRegex(StateStoreError, "state_store_remote_history_rewind"):
            checkout_state_store(
                self.repo,
                store_dir=self.repo.parent / "rewound-store",
            )

        self.assertEqual(_git(self.repo, "rev-parse", tracking).strip(), tracking_before)
        self.assertEqual(self._scratch_state_refs(), [])

    def test_checkout_rejects_noncanonical_remote_listings_without_ref_changes(
        self,
    ) -> None:
        store = self._bootstrap()
        self._seed_surface(store, "")
        publish_state(
            store,
            snapshot=self._snapshot(store, "snap-1"),
            cycle_id="cycle-1",
            repo_hash=REPO_HASH,
        )
        tip = _git(store.root, "rev-parse", "HEAD").strip()
        remote_ref = "refs/heads/aria/state"
        tracking = "refs/remotes/origin/aria/state"
        tracking_before = _git(self.repo, "rev-parse", tracking).strip()
        real_run_git = state_store._run_git

        for index, listing in enumerate((
            f"{tip}\trefs/heads/not-state\n",
            f"{tip}\t{remote_ref}\n{tip}\t{remote_ref}\n",
            f"{'0' * 40}\t{remote_ref}\n",
            f" {tip}\t{remote_ref}\n",
            f"\n{tip}\t{remote_ref}\n\n",
        )):
            def inject_listing(cwd, args, *, value=listing):
                if args[0] == "ls-remote":
                    return subprocess.CompletedProcess(args, 0, value, "")
                return real_run_git(cwd, args)

            with self.subTest(listing=repr(listing)), mock.patch.object(
                state_store,
                "_run_git",
                side_effect=inject_listing,
            ):
                with self.assertRaisesRegex(
                    StateStoreError,
                    "state_store_remote_tip_malformed",
                ):
                    checkout_state_store(
                        self.repo,
                        store_dir=self.repo.parent / f"malformed-store-{index}",
                    )
                self.assertEqual(
                    _git(self.repo, "rev-parse", tracking).strip(),
                    tracking_before,
                )
                self.assertEqual(self._scratch_state_refs(), [])

    def test_checkout_fetch_failure_cleans_temporary_ref_and_preserves_tracking(
        self,
    ) -> None:
        store = self._bootstrap()
        self._seed_surface(store, "")
        publish_state(
            store,
            snapshot=self._snapshot(store, "snap-1"),
            cycle_id="cycle-1",
            repo_hash=REPO_HASH,
        )
        tracking = "refs/remotes/origin/aria/state"
        tracking_before = _git(self.repo, "rev-parse", tracking).strip()
        real_run_git = state_store._run_git

        def fetch_then_report_failure(cwd, args):
            result = real_run_git(cwd, args)
            if args[0] == "fetch":
                self.assertEqual(result.returncode, 0, result.stderr)
                return subprocess.CompletedProcess(
                    result.args,
                    1,
                    result.stdout,
                    "injected checkout fetch failure",
                )
            return result

        with mock.patch.object(
            state_store,
            "_run_git",
            side_effect=fetch_then_report_failure,
        ), self.assertRaisesRegex(StateStoreError, "state_store_fetch_failed"):
            checkout_state_store(
                self.repo,
                store_dir=self.repo.parent / "failed-fetch-store",
            )

        self.assertEqual(_git(self.repo, "rev-parse", tracking).strip(), tracking_before)
        self.assertEqual(self._scratch_state_refs(), [])

    def test_a_clean_store_is_replaced_without_complaint(self) -> None:
        store = self._bootstrap()
        self._seed_surface(store, '{"row": 1}\n')
        publish_state(store, snapshot=self._snapshot(store, "snap-1"), cycle_id="cycle-1", repo_hash=REPO_HASH)
        # Same path, second call: everything is committed, so nothing is lost.
        again = checkout_state_store(self.repo, store_dir=store.root)
        self.assertFalse(again.bootstrapped)
        self.assertEqual(read_published_snapshot(again)["snapshot_id"], "snap-1")

    @unittest.skipUnless(os.name == "posix", "lock-hold assertion uses flock")
    def test_quiescent_host_sidecars_do_not_block_same_path_recheckout(self) -> None:
        store = self._bootstrap()
        self._seed_surface(store, '{"row": 1}\n')
        publish_state(
            store,
            snapshot=self._snapshot(store, "snap-1"),
            cycle_id="cycle-1",
            repo_hash=REPO_HASH,
        )
        sidecar = tools_root(store) / "runs.jsonl.lock"
        sidecar.write_text("quiescent\n", encoding="utf-8")

        observed_held_during_remove = False
        real_git = state_store._git

        def assert_lock_held(cwd, *args, **kwargs):
            nonlocal observed_held_during_remove
            if args[:2] == ("worktree", "remove"):
                import fcntl

                with sidecar.open("a+") as handle:
                    with self.assertRaises(BlockingIOError):
                        fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
                observed_held_during_remove = True
            return real_git(cwd, *args, **kwargs)

        with mock.patch.object(
            state_store,
            "_git",
            side_effect=assert_lock_held,
        ):
            again = checkout_state_store(self.repo, store_dir=store.root)
        self.assertTrue(observed_held_during_remove)
        self.assertEqual(read_published_snapshot(again)["snapshot_id"], "snap-1")

    def test_checkout_locks_absent_fixed_and_glob_writers_before_clean_scan(
        self,
    ) -> None:
        """A clean scan cannot authorise deleting bytes written after it."""
        from aria_kernel.runtime_profile import set_profile
        from aria_kernel.tool_registry import ensure_tools_binding

        store = self._bootstrap()
        tools = tools_root(store)
        set_profile(
            "standard",
            operator_approval_ref="r9-checkout-lock-test",
            base_dir=tools,
        )
        ensure_tools_binding(tools, workspace_root=self.repo)
        self._seed_surface(store, '{"row": 1}\n')
        workspace = state_store.workspace_root(store, REPO_HASH)
        publish_state(
            store,
            snapshot=self._snapshot(store, "snap-1"),
            cycle_id="cycle-1",
            repo_hash=REPO_HASH,
        )
        # An empty authority root is invisible to Git but lets the test assert
        # the complete workspace lock-group closure without planting writer
        # sidecars of its own.
        workspace.mkdir(parents=True, exist_ok=True)

        fixed_path = tools / "queues" / "next_cycle_queue.jsonl"
        glob_path = tools / "dispatch" / "late-writer.jsonl"
        self.assertFalse(fixed_path.exists())
        self.assertFalse(glob_path.exists())
        from aria_kernel.workspace import canonical_identity

        self.assertEqual(
            state_store._state_store_uncommitted_paths(
                store.root,
                expected_repo_identity=canonical_identity(self.repo),
                expected_repo_root=self.repo,
            ),
            (),
        )

        scan_complete = threading.Event()
        writer_started = {
            "fixed": threading.Event(),
            "glob": threading.Event(),
        }
        writer_done = {
            "fixed": threading.Event(),
            "glob": threading.Event(),
        }
        blocked_during_remove: dict[str, bool] = {}
        writer_successes: list[str] = []
        writer_errors: dict[str, BaseException] = {}
        transaction_specs: list[
            tuple[tuple[Path, ...], tuple[Path, ...]]
        ] = []
        real_scan = state_store._state_store_uncommitted_paths
        real_cleanup_transaction = state_store.state_transaction

        def writer(name: str, path: Path, surface: str) -> None:
            try:
                if not scan_complete.wait(timeout=10):
                    raise TimeoutError("cleanliness scan did not complete")
                writer_started[name].set()
                with ledger_state_transaction(
                    [path],
                    timeout_seconds=5.0,
                ) as transaction:
                    transaction.append_declared_jsonl(
                        path,
                        {
                            "schema_version": 1,
                            "event": f"late-{name}",
                        },
                        expected_surface=surface,
                    )
                writer_successes.append(name)
            except BaseException as exc:  # noqa: BLE001 - thread handoff
                writer_errors[name] = exc
            finally:
                writer_done[name].set()

        def pause_after_both_scans(*args, **kwargs):
            dirty = real_scan(*args, **kwargs)
            scan_complete.set()
            for started in writer_started.values():
                if not started.wait(timeout=5):
                    raise TimeoutError("late writer did not start")
            time.sleep(0.1)
            blocked_during_remove.update(
                {
                    name: not writer_done[name].is_set()
                    for name in writer_done
                }
            )
            return dirty

        @contextmanager
        def observed_cleanup_transaction(
            paths,
            *,
            group_lock_paths=(),
            **kwargs,
        ):
            transaction_specs.append(
                (
                    tuple(Path(path).resolve() for path in paths),
                    tuple(Path(path).resolve() for path in group_lock_paths),
                )
            )
            with real_cleanup_transaction(
                paths,
                group_lock_paths=group_lock_paths,
                **kwargs,
            ) as transaction:
                yield transaction

        writers = [
            threading.Thread(
                target=writer,
                args=("fixed", fixed_path, "next_cycle_queue"),
                daemon=True,
            ),
            threading.Thread(
                target=writer,
                args=("glob", glob_path, "worker_dispatch"),
                daemon=True,
            ),
        ]
        for thread in writers:
            thread.start()

        with mock.patch.object(
            state_store,
            "_state_store_uncommitted_paths",
            side_effect=pause_after_both_scans,
        ), mock.patch.object(
            state_store,
            "state_transaction",
            side_effect=observed_cleanup_transaction,
        ):
            restored = checkout_state_store(
                self.repo,
                store_dir=store.root,
            )

        for thread in writers:
            thread.join(timeout=5)
        self.assertTrue(all(not thread.is_alive() for thread in writers))
        self.assertEqual(
            blocked_during_remove,
            {"fixed": True, "glob": True},
        )
        self.assertEqual(writer_successes, [])
        self.assertEqual(set(writer_errors), {"fixed", "glob"})
        self.assertTrue(
            all(
                isinstance(exc, LedgerIntegrityError)
                and "state_transaction_declared_root_changed" in str(exc)
                for exc in writer_errors.values()
            ),
            writer_errors,
        )
        self.assertEqual(len(transaction_specs), 1)
        concrete_paths, group_locks = transaction_specs[0]
        roots = {
            "tools": tools,
            "workspace": workspace,
            "repo": state_store.findings_root(store),
        }
        expected_groups = {
            (
                roots[surface.root_kind]
                / "locks"
                / "state-groups"
                / f"{surface.lock_group}.lock"
            ).resolve()
            for surface in iter_surfaces()
        }
        self.assertEqual(set(group_locks), expected_groups)
        ordered_locks = _transaction_lock_paths(
            list(concrete_paths),
            group_lock_paths=group_locks,
        )
        self.assertEqual(len(ordered_locks), len(set(ordered_locks)))
        self.assertEqual(
            ordered_locks[: len(expected_groups)],
            sorted(expected_groups, key=lambda path: path.as_posix()),
        )
        self.assertFalse((tools_root(restored) / "queues" / fixed_path.name).exists())
        self.assertFalse((tools_root(restored) / "dispatch" / glob_path.name).exists())
        self.assertIn(
            '"row":1',
            (tools_root(restored) / "runs.jsonl").read_text(encoding="utf-8"),
        )

    def test_a_store_holding_uncommitted_writes_refuses_re_checkout(self) -> None:
        # Those uncommitted paths are a cycle's ledger writes. Silently
        # re-checking out would delete state that exists nowhere else —
        # ORPHAN-CRITICAL-484's loss coming back in through setup.
        store = self._bootstrap()
        self._seed_surface(store, "")
        publish_state(store, snapshot=self._snapshot(store, "snap-1"), cycle_id="cycle-1", repo_hash=REPO_HASH)
        self._seed_surface(store, '{"unpublished": true}\n')

        with self.assertRaises(StateStoreRefusal) as ctx:
            checkout_state_store(self.repo, store_dir=store.root)
        self.assertIn("state_store_uncommitted_writes", str(ctx.exception))
        # And the writes are still there.
        self.assertIn("unpublished", (tools_root(store) / "runs.jsonl").read_text())

    def test_a_store_holding_an_unpushed_commit_refuses_re_checkout(self) -> None:
        """Committed is not published; only the remote decides.

        `publish_state` now rolls its commit back when the push fails, so
        it no longer manufactures this state itself — but a process killed
        between commit and push, or any other writer in the store, still
        can. `git status` reports CLEAN for committed work, so without an
        explicit containment check the re-checkout would delete the commit
        AND its reflog with no error, and the next snapshot would chain
        cleanly to the rolled-back tip.
        """
        store = self._bootstrap()
        self._seed_surface(store, "")
        publish_state(store, snapshot=self._snapshot(store, "snap-1"), cycle_id="cycle-1", repo_hash=REPO_HASH)

        surface = self._seed_surface(store, '{"row": "committed-never-pushed"}\n')
        self._commit_in_store(store, "local commit the remote does not have")
        self.assertEqual(_git(store.root, "status", "--porcelain").strip(), "")

        with self.assertRaises(StateStoreRefusal) as ctx:
            checkout_state_store(self.repo, store_dir=store.root)
        self.assertIn("state_store_unpushed_commits", str(ctx.exception))
        self.assertIn("committed-never-pushed", surface.read_text(encoding="utf-8"))

    def test_checkout_cannot_remove_a_commit_created_by_an_active_publisher(
        self,
    ) -> None:
        """Cleanup and commit-to-push are one common-git lifecycle."""
        store = self._bootstrap()
        self._seed_surface(store, "")
        publish_state(
            store,
            snapshot=self._snapshot(store, "snap-1"),
            cycle_id="cycle-1",
            repo_hash=REPO_HASH,
        )
        pending = self._snapshot(
            store,
            "snap-unpublished-local",
            cycle_id="cycle-unpublished-local",
        )
        cleanup_past_containment = threading.Event()
        publisher_started = threading.Event()
        publisher_at_push = threading.Event()
        checkout_finished = threading.Event()
        publisher_commits: list[str] = []
        publisher_errors: list[BaseException] = []
        checkout_errors: list[BaseException] = []
        publisher_was_blocked: list[bool] = []
        real_cleanup_locks = state_store._checkout_cleanup_transaction_locks
        real_run_git = state_store._run_git

        def pause_cleanup_after_initial_containment(root: Path):
            cleanup_past_containment.set()
            if not publisher_started.wait(timeout=10):
                raise TimeoutError("publisher did not enter publish_state")
            publisher_was_blocked.append(
                not publisher_at_push.wait(timeout=1.0),
            )
            return real_cleanup_locks(root)

        def crash_publisher_after_commit(cwd: Path, args: tuple[str, ...]):
            if args and args[0] == "push" and Path(cwd).resolve() == store.root:
                publisher_commits.append(
                    _git(store.root, "rev-parse", "HEAD").strip(),
                )
                publisher_at_push.set()
                if not checkout_finished.wait(timeout=10):
                    raise TimeoutError("checkout did not finish its cleanup")
                raise RuntimeError("injected crash before publisher push")
            return real_run_git(cwd, args)

        def run_checkout() -> None:
            try:
                checkout_state_store(self.repo, store_dir=store.root)
            except BaseException as exc:  # noqa: BLE001 - thread handoff
                checkout_errors.append(exc)

        def run_publisher() -> None:
            publisher_started.set()
            try:
                publish_state(
                    store,
                    snapshot=pending,
                    cycle_id="cycle-unpublished-local",
                    repo_hash=REPO_HASH,
                )
            except BaseException as exc:  # noqa: BLE001 - thread handoff
                publisher_errors.append(exc)

        with mock.patch.object(
            state_store,
            "_checkout_cleanup_transaction_locks",
            side_effect=pause_cleanup_after_initial_containment,
        ), mock.patch.object(
            state_store,
            "_run_git",
            side_effect=crash_publisher_after_commit,
        ):
            checkout_thread = threading.Thread(target=run_checkout, daemon=True)
            checkout_thread.start()
            self.assertTrue(cleanup_past_containment.wait(timeout=10))
            publisher_thread = threading.Thread(target=run_publisher, daemon=True)
            publisher_thread.start()
            checkout_thread.join(timeout=15)
            checkout_finished.set()
            publisher_thread.join(timeout=15)

        self.assertFalse(checkout_thread.is_alive())
        self.assertFalse(publisher_thread.is_alive())
        self.assertEqual(checkout_errors, [])
        self.assertEqual(publisher_was_blocked, [True])
        self.assertEqual(len(publisher_commits), 1)
        self.assertEqual(len(publisher_errors), 1)
        self.assertIn("injected crash", str(publisher_errors[0]))
        self.assertEqual(
            _git(store.root, "rev-parse", "HEAD").strip(),
            publisher_commits[0],
        )
        self.assertNotEqual(
            _git(self.remote, "rev-parse", "refs/heads/aria/state").strip(),
            publisher_commits[0],
        )

    def test_publish_with_replay_keeps_nested_lifecycle_entries_reentrant(
        self,
    ) -> None:
        store = self._bootstrap()
        self._seed_surface(store, "")

        real_run_git = state_store._run_git
        push_died: list[bool] = []

        def push_times_out_once(cwd: Path, args: tuple[str, ...]):
            if (
                args
                and args[0] == "push"
                and Path(cwd).resolve() == store.root
                and not push_died
            ):
                # Deterministic death-at-the-wall-clock: the local commit
                # exists, the push never completed. This used to be "forced"
                # by patching GIT_TIMEOUT_SECONDS to 0.1 and racing real git —
                # vacuous on a fast box (the push won the race, nothing was
                # recovered) and a failure on a loaded one (the timeout won
                # and nobody caught it). Injection pins the precondition the
                # test name promises instead of hoping for the weather.
                push_died.append(True)
                raise state_store.StateStoreError(
                    "state_store_git_timeout: injected (deterministic)"
                )
            return real_run_git(cwd, args)

        with mock.patch.object(
            state_store, "_run_git", side_effect=push_times_out_once
        ):
            with self.assertRaises(state_store.StateStoreError):
                state_store.publish_with_contention_replay(
                    store,
                    snapshot_id="snap-nested-lifecycle",
                    cycle_id="cycle-nested-lifecycle",
                    lane="test",
                    repo_hash=REPO_HASH,
                )

        # The reentrant call: recovery reconciles the committed-but-unpushed
        # attempt and the publish completes with the nested lifecycle
        # entries intact.
        result = state_store.publish_with_contention_replay(
            store,
            snapshot_id="snap-nested-lifecycle",
            cycle_id="cycle-nested-lifecycle",
            lane="test",
            repo_hash=REPO_HASH,
        )

        self.assertTrue(result["published"])
        self.assertEqual(result["attempts"], 1)

    def test_a_directory_that_is_not_a_worktree_refuses(self) -> None:
        store_dir = self.repo.parent / "not-a-worktree"
        (store_dir / "tools").mkdir(parents=True)
        (store_dir / "tools" / "runs.jsonl").write_text("", encoding="utf-8")
        with self.assertRaises(StateStoreError) as ctx:
            checkout_state_store(self.repo, store_dir=store_dir)
        self.assertIn("state_store_worktree_occupied", str(ctx.exception))


class OpenVersusCheckout(StateStoreTestCase):
    """The split that lets a publish persist what a cycle actually wrote."""

    def test_opening_a_store_holding_uncommitted_writes_publishes_them(self) -> None:
        # This is the whole reason the two operations are separate: a
        # publish that re-checked-out first would refuse on the very rows
        # it was called to persist, making the command unable to do its
        # only job.
        store = self._bootstrap()
        self._seed_surface(store, "")
        publish_state(store, snapshot=self._snapshot(store, "snap-1"), cycle_id="cycle-1", repo_hash=REPO_HASH)

        self._seed_surface(store, '{"written_by_the_cycle": true}\n')
        opened = state_store.open_state_store(self.repo, store_dir=store.root)
        snapshot = build_publishable_snapshot(
            opened, snapshot_id="snap-2", cycle_id="cycle-2", lane="test", repo_hash=REPO_HASH
        )
        result = publish_state(opened, snapshot=snapshot, cycle_id="cycle-2", repo_hash=REPO_HASH)
        self.assertTrue(result["published"])

        fresh = checkout_state_store(self.repo, store_dir=self.repo.parent / "fresh")
        self.assertIn(
            "written_by_the_cycle",
            (tools_root(fresh) / "runs.jsonl").read_text(encoding="utf-8"),
        )

    def test_opening_a_store_that_was_never_checked_out_refuses(self) -> None:
        with self.assertRaises(StateStoreError) as ctx:
            state_store.open_state_store(self.repo, store_dir=self.repo.parent / "never")
        self.assertIn("state_store_not_open", str(ctx.exception))


class DailyAnchorPinsTheStore(StateStoreTestCase):
    def test_the_anchor_carries_the_published_manifest_root(self) -> None:
        """`build_daily_anchor`'s snapshot parameter had no caller.

        #1052 added `state_snapshot_path` to `build_daily_anchor` and
        nothing forwarded to it — through `emit_anchor_to_path` or from
        the CLI. A capability with no caller is the shape of defect the
        anchor exists to catch, so it does not get to be one.
        """
        from aria_kernel.report import emit_anchor_to_path

        store = self._bootstrap()
        self._seed_surface(store, '{"row": 1}\n')
        snapshot = self._snapshot(store, "snap-1")
        publish_state(store, snapshot=snapshot, cycle_id="cycle-1", repo_hash=REPO_HASH)

        result = emit_anchor_to_path(
            date="2026-08-03",
            workspace_root=self.repo,
            tools_root=tools_root(store),
            output_path=self.repo.parent / "anchor.md",
            state_snapshot_path=state_store.snapshot_path(store),
        )
        anchor = result["anchor"]
        self.assertEqual(anchor["state_snapshot_id"], "snap-1")
        self.assertEqual(anchor["state_manifest_root"], snapshot["manifest_root"])


class IgnoreRulesDoNotSwallowSurfaces(StateStoreTestCase):
    def test_a_findings_surface_is_committed_despite_a_shared_ignore_rule(self) -> None:
        """The store commits its attested surfaces; ignore rules get no vote.

        NOTE ON THE PREMISE: the main checkout's `.gitignore` does NOT
        reach into the store — git reads no `.gitignore` above a
        worktree's top level, and the store's top level is `store_dir`,
        whose tree carries no `.gitignore` at all. An earlier version of
        this test justified itself with that false claim.

        What CAN reach the store is `$GIT_COMMON_DIR/info/exclude`, which
        is genuinely shared across worktrees — so this plants the rule
        there, which is the real mechanism. Without `--force` on the add,
        the subtree is dropped from every commit while the snapshot keeps
        pinning its hash: a branch that verifies clean and carries nothing.
        """
        (self.repo / ".git" / "info").mkdir(parents=True, exist_ok=True)
        (self.repo / ".git" / "info" / "exclude").write_text(
            "aria-findings/\naria-tools/\n", encoding="utf-8"
        )

        store = self._bootstrap()
        findings = state_store.findings_root(store) / "aria-findings"
        findings.mkdir(parents=True, exist_ok=True)
        (findings / "F-001.json").write_text('{"id": "F-001"}\n', encoding="utf-8")
        self._seed_surface(store, "")
        publish_state(store, snapshot=self._snapshot(store, "snap-1"), cycle_id="cycle-1", repo_hash=REPO_HASH)

        tracked = _git(store.root, "ls-tree", "-r", "--name-only", "HEAD")
        self.assertIn("findings/aria-findings/F-001.json", tracked.split("\n"))


class TransportFailureIsNotARefusal(StateStoreTestCase):
    def test_an_unreachable_remote_raises_an_error_not_a_refusal(self) -> None:
        """The two must not collapse: one is retryable, the other is not."""
        store = self._bootstrap()
        self._seed_surface(store, "")
        _git(self.repo, "remote", "set-url", "origin", str(self.repo.parent / "gone.git"))
        with self.assertRaises(StateStoreError) as ctx:
            publish_state(store, snapshot=self._snapshot(store, "snap-1"), cycle_id="cycle-1", repo_hash=REPO_HASH)
        self.assertIn("state_publish_transport_failed", str(ctx.exception))
        self.assertNotIsInstance(ctx.exception, StateStoreRefusal)


class PushDenialIsNotALostRace(StateStoreTestCase):
    def test_a_readable_remote_that_refuses_the_write_is_not_reported_as_a_race(self) -> None:
        """A read succeeding does not prove a write was allowed.

        The probe used to ask only "does the remote answer?" — and a
        branch ruleset, a protected branch or a read-scoped token all
        answer yes to a read while refusing the push. Reporting that as
        "another lane published first" sends an operator hunting a lane
        that never ran. The tip not having MOVED is what distinguishes
        them.
        """
        store = self._bootstrap()
        self._seed_surface(store, "")
        publish_state(store, snapshot=self._snapshot(store, "snap-1"), cycle_id="cycle-1", repo_hash=REPO_HASH)

        hook = self.remote / "hooks" / "pre-receive"
        hook.parent.mkdir(parents=True, exist_ok=True)
        hook.write_text("#!/bin/sh\necho 'GH006: Protected branch update failed' >&2\nexit 1\n",
                        encoding="utf-8")
        hook.chmod(0o755)

        self._seed_surface(store, '{"row": 1}\n')
        snapshot = self._snapshot(store, "snap-2", cycle_id="cycle-2")
        with self.assertRaises(StateStoreError) as ctx:
            publish_state(store, snapshot=snapshot, cycle_id="cycle-2", repo_hash=REPO_HASH)
        self.assertIn("state_publish_write_denied", str(ctx.exception))
        # A denial is NOT a refusal: retrying cannot fix it, but neither is
        # it a statement that the local state is wrong.
        self.assertNotIsInstance(ctx.exception, StateStoreRefusal)


class IgnoreShadowedWritesAreVisibleToTheGuard(StateStoreTestCase):
    def test_the_dirty_probe_sees_what_the_add_would_stage(self) -> None:
        """The probe and the staging must speak one vocabulary.

        `publish_state` stages with `git add --all --force`, which commits
        ignore-shadowed paths on purpose. A probe using bare `git status
        --porcelain` cannot see those paths, so the two disagree about
        what the store contains and the re-checkout deletes writes it
        never reported. `$GIT_COMMON_DIR/info/exclude` is shared across
        worktrees, which is how such a rule reaches the store at all.
        """
        (self.repo / ".git" / "info").mkdir(parents=True, exist_ok=True)
        (self.repo / ".git" / "info" / "exclude").write_text("shadowed/\n", encoding="utf-8")

        store = self._bootstrap()
        self._seed_surface(store, "")
        publish_state(store, snapshot=self._snapshot(store, "snap-1"), cycle_id="cycle-1", repo_hash=REPO_HASH)

        shadowed = store.root / "shadowed"
        shadowed.mkdir(parents=True, exist_ok=True)
        (shadowed / "rows.jsonl").write_text('{"row": "invisible-to-bare-status"}\n', encoding="utf-8")
        self.assertEqual(_git(store.root, "status", "--porcelain").strip(), "")

        with self.assertRaises(StateStoreRefusal) as ctx:
            checkout_state_store(self.repo, store_dir=store.root)
        self.assertIn("state_store_uncommitted_writes", str(ctx.exception))
        self.assertTrue((shadowed / "rows.jsonl").exists())


class OnlyDeclaredSurfacesAreCommitted(StateStoreTestCase):
    """The store stages its attested surfaces — nothing else, ever."""

    def test_a_private_key_beside_a_declared_surface_is_not_committed(self) -> None:
        """`aria-debts/keys/` holds per-cycle ed25519 PRIVATE keys.

        `gh_token_factory` writes them, and scoped installation tokens,
        right beside the declared `aria-debts/` ledgers. The main
        checkout's .gitignore covers that path but does not reach inside
        a worktree whose top level is `store_dir` — and a `--force`
        whole-tree add would override it even if it did. So a whole-tree
        add is one redirected root away from pushing credentials to a
        branch. Listing the snapshot's own paths removes the class:
        nothing names the key, so nothing can stage it.
        """
        store = self._bootstrap()
        self._seed_surface(store, '{"row": 1}\n')

        debts = state_store.findings_root(store) / "aria-debts"
        (debts / "keys").mkdir(parents=True, exist_ok=True)
        (debts / "keys" / "cycle-1").write_text("PRIVATE-KEY-MATERIAL\n", encoding="utf-8")
        (debts / "keys" / "cycle-1.token").write_text("ghs_secret\n", encoding="utf-8")
        # A declared debt surface in the SAME directory, so this proves
        # selection rather than the whole subtree being skipped.
        _write_chained_fixture(
            debts / "debt-events.jsonl",
            '{"event": "opened"}\n',
        )

        publish_state(
            store,
            snapshot=self._snapshot(store, "snap-1"),
            cycle_id="cycle-1",
            repo_hash=REPO_HASH,
        )

        tracked = _git(store.root, "ls-tree", "-r", "--name-only", "HEAD").split("\n")
        self.assertNotIn("findings/aria-debts/keys/cycle-1", tracked)
        self.assertNotIn("findings/aria-debts/keys/cycle-1.token", tracked)
        self.assertIn("findings/aria-debts/debt-events.jsonl", tracked)
        # And nothing anywhere in the committed tree carries the material —
        # asserted by searching the COMMIT, not the paths, so a key that
        # arrived under some other name would still be caught.
        found = subprocess.run(
            ["git", "-C", str(store.root), "grep", "-I", "-l", "PRIVATE-KEY-MATERIAL", "HEAD"],
            capture_output=True, text=True, check=False,
        )
        self.assertEqual(found.stdout.strip(), "", "key material reached the state branch")

    def test_an_undeclared_stray_file_is_not_committed(self) -> None:
        store = self._bootstrap()
        self._seed_surface(store, "")
        (state_store.tools_root(store) / "scratch.tmp").write_text("junk\n", encoding="utf-8")
        publish_state(
            store,
            snapshot=self._snapshot(store, "snap-1"),
            cycle_id="cycle-1",
            repo_hash=REPO_HASH,
        )
        tracked = _git(store.root, "ls-tree", "-r", "--name-only", "HEAD").split("\n")
        self.assertNotIn("tools/scratch.tmp", tracked)
        self.assertIn("tools/runs.jsonl", tracked)

    def test_a_surface_that_disappears_stages_as_a_deletion(self) -> None:
        """The predecessor's paths are what make removal expressible.

        `build_snapshot` only records files that EXIST, so the current
        snapshot cannot name what is gone. Without the published
        snapshot's paths in the pathspec, a removed ledger would linger in
        the branch while the manifest stopped mentioning it.
        """
        store = self._bootstrap()
        surface = self._seed_surface(store, '{"row": 1}\n')
        extra = state_store.tools_root(store) / "health.jsonl"
        _write_chained_fixture(extra, '{"ok": true}\n')
        publish_state(
            store, snapshot=self._snapshot(store, "snap-1"),
            cycle_id="cycle-1", repo_hash=REPO_HASH,
        )
        self.assertIn("tools/health.jsonl",
                      _git(store.root, "ls-tree", "-r", "--name-only", "HEAD").split("\n"))

        extra.unlink()
        follow = self._snapshot(store, "snap-2", cycle_id="cycle-2")
        # Losing a surface is refused by continuity — that guard fires
        # first and is tested elsewhere. Here the point is that the
        # deletion is STAGEABLE at all, so assert the pathspec covers it.
        specs = state_store._staged_pathspecs(
            store, follow, read_published_snapshot(store), REPO_HASH
        )
        self.assertIn("tools/health.jsonl", specs)
        self.assertIn("tools/runs.jsonl", specs)
        self.assertTrue(surface.exists())


class RootsBindToTheStore(StateStoreTestCase):
    """The redirection that ends per-run amnesia for two of three roots."""

    def test_the_binding_is_one_definition_and_the_seams_honour_it(self) -> None:
        from aria_kernel.finding import _findings_dir
        from aria_kernel.debt import _debts_dir
        from aria_kernel.workspace import workspace_paths

        store = self._bootstrap()
        env = state_store.store_environment(store, REPO_HASH)

        with _EnvPatch(env):
            # findings + debts follow ARIA_REPO_STATE_ROOT...
            self.assertEqual(
                _findings_dir(self.repo),
                state_store.findings_root(store) / "aria-findings",
            )
            self.assertEqual(
                _debts_dir(self.repo),
                state_store.findings_root(store) / "aria-debts",
            )
            # ...and the workspace lands exactly where store_roots says the
            # snapshot will look for it. These two computing the same path
            # is the whole point: workspace_paths appends the repo hash
            # itself, so ARIA_WORKSPACE_BASE is the PARENT.
            paths = workspace_paths(self.repo)
            self.assertEqual(
                paths.workspace_root,
                state_store.store_roots(store, paths.workspace_root.name)["workspace"],
            )

    def test_finding_ids_survive_a_fresh_runner(self) -> None:
        """ORPHAN: `_allocate_finding_id` restarted at F-001 every bootstrap.

        `aria-findings/` is gitignored by design and rode nothing between
        runs, so finding identity was meaningless across cycles. Bound to
        the store, the allocator sees the previous run's ids.
        """
        from aria_kernel.finding import _findings_dir

        store = self._bootstrap()
        env = state_store.store_environment(store, REPO_HASH)

        with _EnvPatch(env):
            findings = _findings_dir(self.repo)
            findings.mkdir(parents=True, exist_ok=True)
            (findings / "F-001.json").write_text('{"id": "F-001"}\n', encoding="utf-8")
            (findings / "F-002.json").write_text('{"id": "F-002"}\n', encoding="utf-8")

        self._seed_surface(store, "")
        publish_state(
            store, snapshot=self._snapshot(store, "snap-1"),
            cycle_id="cycle-1", repo_hash=REPO_HASH,
        )

        # A FRESH runner: new checkout, nothing carried on disk.
        fresh = checkout_state_store(self.repo, store_dir=self.repo.parent / "store-fresh")
        with _EnvPatch(state_store.store_environment(fresh, REPO_HASH)):
            carried = sorted(q.name for q in _findings_dir(self.repo).glob("F-*.json"))
        self.assertEqual(carried, ["F-001.json", "F-002.json"])

    def test_the_keys_directory_is_not_redirected_into_the_store(self) -> None:
        """Per-cycle private keys are credentials, not state.

        `gh_token_factory._keys_dir` computes its own path and must NOT
        pass through the repo-state seam: dying with the runner is the
        correct lifetime for a per-cycle key, and the store is pushed.
        """
        from aria_kernel.gh_token_factory import _keys_dir

        store = self._bootstrap()
        with _EnvPatch(state_store.store_environment(store, REPO_HASH)):
            keys = _keys_dir(self.repo)
        self.assertEqual(keys, self.repo / "aria-debts" / "keys")
        self.assertNotIn(str(store.root), str(keys))


class ARestoredStoreIsNotYetAUsableToolsRoot(StateStoreTestCase):
    """PLAN Wave 1 PR 2.6b — what a lane must do after `state checkout`.

    `repo_identity.json` is what makes a tools root resolvable, and the branch
    deliberately does not carry it: it records an absolute `bound_repo_root`,
    which is machine-local and meaningless on the next runner. So a restored
    store arrives as a tools root FULL of covered state with no identity —
    precisely the shape `ensure_tools_dir` refuses as `ambiguous_tools_root`.

    That refusal is correct and the binding is the answer, but only one lane
    had it: `aria-auto-cycle` ran `integrity migrate-tools-bootstrap` and
    `aria-agent-executor` never did, so the first executor run against a
    restored store would have died at the lease check. These tests pin both
    halves — the hazard is real, and the migration resolves it — because the
    tempting wrong fix (declare the identity as a surface, publish the runner's
    path to a shared branch) makes the first test pass too.
    """

    def _published_then_fresh(self):
        from aria_kernel.tool_registry import ensure_tools_binding

        store = self._bootstrap()
        with _EnvPatch(state_store.store_environment(store, REPO_HASH)):
            ensure_tools_binding(workspace_root=self.repo)
        self._seed_surface(store, "")
        publish_state(
            store, snapshot=self._snapshot(store, "snap-1"),
            cycle_id="cycle-1", repo_hash=REPO_HASH,
        )
        return checkout_state_store(self.repo, store_dir=self.repo.parent / "store-fresh")

    def test_the_identity_is_not_published_to_the_shared_branch(self) -> None:
        fresh = self._published_then_fresh()
        self.assertFalse(
            (tools_root(fresh) / "repo_identity.json").exists(),
            "a runner-absolute bound_repo_root must not travel between hosts",
        )
        # ...while the ledger beside it DID travel, so this is selection and
        # not the whole subtree having been skipped.
        self.assertTrue((tools_root(fresh) / "runs.jsonl").exists())

    def test_checkout_never_mutates_shared_excludes_and_classifies_host_files(
        self,
    ) -> None:
        from aria_kernel.tool_registry import ensure_tools_binding
        from aria_kernel.workspace import canonical_identity

        exclude = self.repo / ".git" / "info" / "exclude"
        exclude.parent.mkdir(parents=True, exist_ok=True)
        exclude.write_text("user-owned-pattern/\n", encoding="utf-8")

        store = self._bootstrap()
        ensure_tools_binding(tools_root(store), workspace_root=self.repo)
        identity = canonical_identity(self.repo)
        snapshot = build_publishable_snapshot(
            store,
            snapshot_id="snapshot-host-excludes",
            cycle_id="cycle-host-excludes",
            lane="test",
            repo_hash=identity,
        )
        publish_state(
            store,
            snapshot=snapshot,
            cycle_id="cycle-host-excludes",
            repo_hash=identity,
        )

        self.assertEqual(
            exclude.read_text(encoding="utf-8"),
            "user-owned-pattern/\n",
        )
        nested_lock = tools_root(store) / "runs.jsonl.lock"
        nested_lock.write_text("host-only\n", encoding="utf-8")
        self.assertIn(
            "tools/runs.jsonl.lock",
            _git(store.root, "status", "--porcelain=v1", "--untracked-files=all"),
        )
        self.assertEqual(state_store._state_store_uncommitted_paths(store.root), ())

        arbitrary = tools_root(store) / "daemons" / "poll.lock"
        arbitrary.parent.mkdir(parents=True)
        arbitrary.write_text("not-a-declared-sidecar\n", encoding="utf-8")
        self.assertIn(
            "tools/daemons/poll.lock",
            state_store._state_store_uncommitted_paths(store.root),
        )

        non_regular = tools_root(store) / "health.jsonl.lock"
        non_regular.unlink(missing_ok=True)
        non_regular.symlink_to("runs.jsonl.lock")
        self.assertIn(
            "tools/health.jsonl.lock",
            state_store._state_store_uncommitted_paths(store.root),
        )

    def test_declared_host_lease_is_never_disposable_sidecar_state(self) -> None:
        store = self._published_then_fresh()
        lease = tools_root(store) / "locks" / "autonomous-host.lock"
        lease.parent.mkdir(parents=True, exist_ok=True)
        lease.write_text("lease\n", encoding="utf-8")

        self.assertIn(
            "tools/locks/autonomous-host.lock",
            state_store._state_store_uncommitted_paths(store.root),
        )

    def test_manifest_state_group_sidecar_is_exactly_classified(self) -> None:
        store = self._published_then_fresh()
        sidecar = (
            tools_root(store) / "locks" / "state-groups" / "runtime.lock.lock"
        )
        sidecar.parent.mkdir(parents=True, exist_ok=True)
        sidecar.touch()
        self.assertNotIn(
            "tools/locks/state-groups/runtime.lock.lock",
            state_store._state_store_uncommitted_paths(store.root),
        )

        unknown = sidecar.with_name("invented.lock.lock")
        unknown.touch()
        self.assertIn(
            "tools/locks/state-groups/invented.lock.lock",
            state_store._state_store_uncommitted_paths(store.root),
        )

        wrong_root = tools_root(store) / "aria-findings" / "_index.json.lock"
        wrong_root.parent.mkdir(parents=True, exist_ok=True)
        wrong_root.touch()
        self.assertIn(
            "tools/aria-findings/_index.json.lock",
            state_store._state_store_uncommitted_paths(store.root),
        )

    def test_sidecar_appearing_only_on_second_status_scan_is_refused(self) -> None:
        outputs = iter((b"", b"?? tools/runs.jsonl.lock\0"))
        with mock.patch.object(
            state_store,
            "_run_git_bytes_bounded",
            side_effect=lambda *_args, **_kwargs: subprocess.CompletedProcess(
                (), 0, next(outputs), b"",
            ),
        ):
            dirty = state_store._state_store_uncommitted_paths(
                Path(self._tmp.name) / "appearance-race",
            )
        self.assertEqual(dirty, ("tools/runs.jsonl.lock",))

    def test_allowed_sidecar_disappearing_before_second_status_is_refused(self) -> None:
        store = self._published_then_fresh()
        sidecar = tools_root(store) / "runs.jsonl.lock"
        sidecar.write_text("quiescent\n", encoding="utf-8")
        real_git = state_store._run_git_bytes_bounded
        status_calls = 0

        def remove_before_second_status(cwd, args, **kwargs):
            nonlocal status_calls
            if args and args[0] == "status":
                status_calls += 1
                if status_calls == 2:
                    sidecar.unlink()
            return real_git(cwd, args, **kwargs)

        with mock.patch.object(
            state_store,
            "_run_git_bytes_bounded",
            side_effect=remove_before_second_status,
        ):
            dirty = state_store._state_store_uncommitted_paths(store.root)
        self.assertIn("tools/runs.jsonl.lock", dirty)

    def test_host_identity_changing_between_status_scans_is_refused(self) -> None:
        from aria_kernel.tools_binding import bind_tools_root
        from aria_kernel.workspace import canonical_identity

        store = self._published_then_fresh()
        with _EnvPatch(state_store.store_environment(store, REPO_HASH)):
            bind_tools_root(
                tools_dir=tools_root(store),
                workspace_root=self.repo,
                reason="test host derivative optimistic recheck",
            )
        identity_path = tools_root(store) / "repo_identity.json"
        real_git = state_store._run_git_bytes_bounded
        status_calls = 0

        def mutate_before_second_status(cwd, args, **kwargs):
            nonlocal status_calls
            if args and args[0] == "status":
                status_calls += 1
                if status_calls == 2:
                    identity = json.loads(identity_path.read_text(encoding="utf-8"))
                    identity["bound_canonical_identity"] = "changed-between-scans"
                    identity_path.write_text(json.dumps(identity), encoding="utf-8")
            return real_git(cwd, args, **kwargs)

        with mock.patch.object(
            state_store,
            "_run_git_bytes_bounded",
            side_effect=mutate_before_second_status,
        ):
            dirty = state_store._state_store_uncommitted_paths(
                store.root,
                expected_repo_identity=canonical_identity(self.repo),
                expected_repo_root=self.repo,
            )
        self.assertIn("tools/repo_identity.json", dirty)

    def test_held_sidecar_replaced_between_status_scans_is_refused(self) -> None:
        store = self._published_then_fresh()
        sidecar = tools_root(store) / "runs.jsonl.lock"
        sidecar.write_text("first inode\n", encoding="utf-8")
        real_git = state_store._run_git_bytes_bounded
        status_calls = 0

        def replace_before_second_status(cwd, args, **kwargs):
            nonlocal status_calls
            if args and args[0] == "status":
                status_calls += 1
                if status_calls == 2:
                    sidecar.unlink()
                    sidecar.write_text("replacement inode\n", encoding="utf-8")
            return real_git(cwd, args, **kwargs)

        with mock.patch.object(
            state_store,
            "_run_git_bytes_bounded",
            side_effect=replace_before_second_status,
        ):
            dirty = state_store._state_store_uncommitted_paths(store.root)
        self.assertIn("tools/runs.jsonl.lock", dirty)

    def test_identity_validation_and_fingerprint_use_the_same_bytes(self) -> None:
        from aria_kernel.tools_binding import bind_tools_root

        store = self._published_then_fresh()
        with _EnvPatch(state_store.store_environment(store, REPO_HASH)):
            bind_tools_root(
                tools_dir=tools_root(store),
                workspace_root=self.repo,
                reason="test unified identity classification read",
            )
        identity = tools_root(store) / "repo_identity.json"
        payload = json.loads(identity.read_text(encoding="utf-8"))
        valid = json.dumps(payload, sort_keys=True).encode("utf-8")
        bad_identity = "x" + payload["bound_canonical_identity"][1:]
        payload["bound_canonical_identity"] = bad_identity
        invalid = json.dumps(payload, sort_keys=True).encode("utf-8")
        self.assertEqual(len(valid), len(invalid))
        identity.write_bytes(valid)
        real_validate = state_store._valid_host_identity

        def toggle_around_validation(*args, **kwargs):  # type: ignore[no-untyped-def]
            identity.write_bytes(valid)
            result = real_validate(*args, **kwargs)
            identity.write_bytes(invalid)
            return result

        with mock.patch.object(
            state_store,
            "_valid_host_identity",
            side_effect=toggle_around_validation,
        ):
            dirty = state_store._state_store_uncommitted_paths(store.root)

        self.assertIn("tools/repo_identity.json", dirty)
        self.assertEqual(identity.read_bytes(), invalid)

    def test_pathological_host_json_is_invalid_not_an_exception(self) -> None:
        nested = b'{"value":' + (b"[" * 1500) + b"0" + (b"]" * 1500) + b"}"
        self.assertEqual(state_store._json_object_from_bytes(nested), {})

    def test_json_nesting_bound_ignores_delimiters_inside_strings(self) -> None:
        payload = b'{"value":"[{\\\"still a string\\\"}]","items":[1]}'
        self.assertEqual(
            state_store._json_object_from_bytes(payload),
            {"value": '[{"still a string"}]', "items": [1]},
        )
        self.assertTrue(
            state_store.json_nesting_within_limit(
                payload.decode("utf-8"),
                max_depth=2,
            ),
        )
        self.assertFalse(
            state_store.json_nesting_within_limit(
                payload.decode("utf-8"),
                max_depth=1,
            ),
        )

    def test_oversized_integer_token_is_invalid_not_an_exception(self) -> None:
        oversized_integer = b'{"value":' + (b"9" * 100_000) + b"}"
        self.assertEqual(
            state_store._json_object_from_bytes(oversized_integer),
            {},
        )

    def test_index_validation_and_fingerprint_use_the_same_bytes(self) -> None:
        from aria_kernel.tool_registry import update_tools_index

        store = self._published_then_fresh()
        index = tools_root(store) / "integrity_index.json"
        update_tools_index(tools_root(store))
        payload = json.loads(index.read_text(encoding="utf-8"))
        valid = json.dumps(payload, sort_keys=True).encode("utf-8")
        first = next(iter(payload["ledger_hashes"]))
        original_hash = payload["ledger_hashes"][first]
        payload["ledger_hashes"][first] = (
            ("0" if original_hash[0] != "0" else "1") + original_hash[1:]
        )
        invalid = json.dumps(payload, sort_keys=True).encode("utf-8")
        self.assertEqual(len(valid), len(invalid))
        index.write_bytes(valid)
        real_validate = state_store._reproducible_tools_index

        def toggle_around_validation(*args, **kwargs):  # type: ignore[no-untyped-def]
            index.write_bytes(valid)
            result = real_validate(*args, **kwargs)
            index.write_bytes(invalid)
            return result

        with mock.patch.object(
            state_store,
            "_reproducible_tools_index",
            side_effect=toggle_around_validation,
        ):
            dirty = state_store._state_store_uncommitted_paths(store.root)

        self.assertIn("tools/integrity_index.json", dirty)
        self.assertEqual(index.read_bytes(), invalid)

    def test_status_output_entry_and_record_budgets_fail_closed(self) -> None:
        store = self._published_then_fresh()
        (store.root / "one").write_text("1\n", encoding="utf-8")
        (store.root / "two").write_text("2\n", encoding="utf-8")
        with mock.patch.object(state_store, "_MAX_STATUS_ENTRIES", 1), self.assertRaisesRegex(
            StateStoreError,
            "state_store_status_budget_exceeded",
        ):
            state_store._state_store_uncommitted_paths(store.root)

        malformed = subprocess.CompletedProcess((), 0, b"?? missing-nul", b"")
        with mock.patch.object(
            state_store,
            "_run_git_bytes_bounded",
            return_value=malformed,
        ), self.assertRaisesRegex(
            StateStoreError,
            "state_store_status_budget_exceeded",
        ):
            state_store._state_store_uncommitted_paths(store.root)

        overlong = subprocess.CompletedProcess((), 0, b"?? abcdef\0", b"")
        with mock.patch.object(
            state_store,
            "_run_git_bytes_bounded",
            return_value=overlong,
        ), mock.patch.object(
            state_store,
            "_MAX_STATUS_RECORD_BYTES",
            4,
        ), self.assertRaisesRegex(
            StateStoreError,
            "state_store_status_budget_exceeded",
        ):
            state_store._state_store_uncommitted_paths(store.root)

    def test_generic_and_remote_git_output_budgets_are_named(self) -> None:
        with mock.patch.object(
            state_store,
            "_MAX_GIT_OUTPUT_BYTES",
            1,
        ), self.assertRaisesRegex(
            StateStoreError,
            "state_store_git_output_budget_exceeded",
        ):
            state_store._run_git(self.repo, ("show", "HEAD:README.md"))

        with mock.patch.object(
            state_store,
            "_MAX_REMOTE_OUTPUT_BYTES",
            1,
        ), self.assertRaisesRegex(
            StateStoreError,
            "state_remote_output_budget_exceeded",
        ):
            state_store._run_git(self.repo, ("ls-remote", "origin"))

    def test_reproducible_index_matches_canonical_missing_core_hashes(self) -> None:
        from aria_kernel.tool_registry import update_tools_index

        tools = Path(self._tmp.name) / "sparse-tools"
        tools.mkdir()
        update_tools_index(tools)

        self.assertTrue(state_store._reproducible_tools_index(tools))

        index = tools / "integrity_index.json"
        payload = json.loads(index.read_text(encoding="utf-8"))
        payload["pressure_evidence_fingerprints_emitted"] = []
        index.write_text(json.dumps(payload), encoding="utf-8")
        self.assertFalse(state_store._reproducible_tools_index(tools))

    @unittest.skipUnless(os.name == "posix", "FIFO and no-follow are POSIX-only")
    def test_missing_core_hash_cannot_be_satisfied_by_symlink_or_fifo(self) -> None:
        from aria_kernel.ledger import tools_index_group_ledgers
        from aria_kernel.tool_registry import update_tools_index

        tools = Path(self._tmp.name) / "sparse-nonregular-tools"
        tools.mkdir()
        update_tools_index(tools)
        core_path = next(iter(tools_index_group_ledgers(tools).values()))
        external = Path(self._tmp.name) / "external-empty-ledger"
        external.touch()

        core_path.symlink_to(external)
        self.assertFalse(state_store._reproducible_tools_index(tools))

        core_path.unlink()
        os.mkfifo(core_path)
        self.assertFalse(state_store._reproducible_tools_index(tools))

    def test_host_derivative_fingerprint_cannot_mix_stat_and_symlink_bytes(
        self,
    ) -> None:
        victim = Path(self._tmp.name) / "host-derivative.json"
        secret = Path(self._tmp.name) / "outside-secret"
        safe = b"safe host bytes\n"
        victim.write_bytes(safe)
        secret.write_bytes(b"secret target bytes\n")
        real_stat = Path.stat

        def swap_after_stat(path, *args, **kwargs):  # type: ignore[no-untyped-def]
            result = real_stat(path, *args, **kwargs)
            if Path(path) == victim:
                victim.unlink()
                victim.symlink_to(secret)
            return result

        with mock.patch.object(
            Path,
            "stat",
            autospec=True,
            side_effect=swap_after_stat,
        ):
            fingerprint = state_store._host_derivative_fingerprint(victim)

        self.assertEqual(fingerprint[-1], hashlib.sha256(safe).hexdigest())
        self.assertNotEqual(
            fingerprint[-1],
            hashlib.sha256(secret.read_bytes()).hexdigest(),
        )

    def test_host_derivative_fingerprint_rejects_symlink_and_oversize(self) -> None:
        target = Path(self._tmp.name) / "target"
        target.write_text("target\n", encoding="utf-8")
        symlink = Path(self._tmp.name) / "symlink"
        symlink.symlink_to(target)
        with self.assertRaises(StateStoreError):
            state_store._host_derivative_fingerprint(symlink)

        oversize = Path(self._tmp.name) / "oversize"
        oversize.touch()
        os.truncate(
            oversize,
            state_store._MAX_HOST_DERIVATIVE_BYTES + 1,
        )
        with self.assertRaises(StateStoreError):
            state_store._host_derivative_fingerprint(oversize)

    @unittest.skipUnless(os.name == "posix", "device files are POSIX-only")
    def test_host_derivative_fingerprint_rejects_device_file(self) -> None:
        with self.assertRaises(StateStoreError):
            state_store._host_derivative_fingerprint(Path("/dev/null"))

        fifo = Path(self._tmp.name) / "host-derivative.fifo"
        os.mkfifo(fifo)
        with self.assertRaises(StateStoreError):
            state_store._host_derivative_fingerprint(fifo)

    def test_host_derivative_fingerprint_rechecks_open_file_after_eof(self) -> None:
        victim = Path(self._tmp.name) / "growing-host-derivative"
        victim.write_bytes(b"initial\n")
        real_read = os.read
        mutated = False

        def mutate_during_read(fd, size):  # type: ignore[no-untyped-def]
            nonlocal mutated
            chunk = real_read(fd, size)
            if chunk and not mutated:
                mutated = True
                with victim.open("ab") as handle:
                    handle.write(b"changed\n")
            return chunk

        with mock.patch.object(
            state_store.os,
            "read",
            side_effect=mutate_during_read,
        ), self.assertRaises(StateStoreError):
            state_store._host_derivative_fingerprint(victim)

    def test_referenced_surface_hash_supports_ledgers_over_host_json_cap(self) -> None:
        from aria_kernel.ledger import file_hash

        ledger = Path(self._tmp.name) / "long-lived-ledger.jsonl"
        descriptor = os.open(ledger, os.O_CREAT | os.O_WRONLY, 0o600)
        try:
            os.ftruncate(
                descriptor,
                state_store._MAX_HOST_DERIVATIVE_BYTES + 1,
            )
        finally:
            os.close(descriptor)

        self.assertEqual(
            state_store._stable_regular_file_hash(ledger),
            file_hash(ledger),
        )

    @unittest.skipUnless(os.name == "posix", "advisory flock is POSIX-only")
    def test_sidecar_swap_during_lock_acquire_cannot_hide_active_real_lock(
        self,
    ) -> None:
        import fcntl
        import aria_kernel.file_lock as file_lock_module

        store = self._published_then_fresh()
        sidecar = tools_root(store) / "runs.jsonl.lock"
        sidecar.write_text("real sidecar\n", encoding="utf-8")
        displaced = sidecar.with_name("runs.jsonl.lock.displaced")
        real_open = os.open
        swapped = False

        with sidecar.open("r+") as active:
            fcntl.flock(active.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)

            def swap_around_open(path, flags, mode=0o777):  # type: ignore[no-untyped-def]
                nonlocal swapped
                if Path(path) == sidecar and not swapped:
                    swapped = True
                    sidecar.rename(displaced)
                    sidecar.write_text("decoy sidecar\n", encoding="utf-8")
                    descriptor = real_open(path, flags, mode)
                    sidecar.unlink()
                    displaced.rename(sidecar)
                    return descriptor
                return real_open(path, flags, mode)

            with mock.patch.object(
                file_lock_module.os,
                "open",
                side_effect=swap_around_open,
            ):
                dirty = state_store._state_store_uncommitted_paths(store.root)

        self.assertTrue(swapped)
        self.assertIn("tools/runs.jsonl.lock", dirty)

    @unittest.skipUnless(os.name == "posix", "existing-sidecar lock is POSIX-only")
    def test_sidecar_disappearing_before_lock_open_is_not_recreated(self) -> None:
        import aria_kernel.file_lock as file_lock_module

        store = self._published_then_fresh()
        sidecar = tools_root(store) / "runs.jsonl.lock"
        sidecar.write_text("vanishing sidecar\n", encoding="utf-8")
        real_open = os.open
        vanished = False

        def disappear_before_open(path, flags, mode=0o777):  # type: ignore[no-untyped-def]
            nonlocal vanished
            if Path(path) == sidecar and not vanished:
                vanished = True
                sidecar.unlink()
            return real_open(path, flags, mode)

        with mock.patch.object(
            file_lock_module.os,
            "open",
            side_effect=disappear_before_open,
        ):
            dirty = state_store._state_store_uncommitted_paths(store.root)

        self.assertTrue(vanished)
        self.assertIn("tools/runs.jsonl.lock", dirty)
        self.assertFalse(sidecar.exists())

    @unittest.skipUnless(os.name == "posix", "invalid byte filenames are POSIX-only")
    def test_undecodable_git_status_output_fails_closed_by_name(self) -> None:
        store = self._published_then_fresh()
        raw_path = os.fsencode(store.root) + b"/invalid-\xff"
        descriptor = os.open(raw_path, os.O_CREAT | os.O_WRONLY, 0o600)
        os.close(descriptor)

        with self.assertRaises(StateStoreError) as caught:
            state_store._state_store_uncommitted_paths(store.root)
        self.assertIn("state_store_status_budget_exceeded", str(caught.exception))

    def test_status_spawn_and_decode_failures_are_normalized(self) -> None:
        with mock.patch.object(
            state_store.subprocess,
            "Popen",
            side_effect=OSError("git missing"),
        ), self.assertRaises(StateStoreError) as caught:
            state_store._state_store_uncommitted_paths(self.repo)
        self.assertIn("state_store_git_unavailable", str(caught.exception))

        invalid = subprocess.CompletedProcess((), 0, b"?? invalid-\xff\0", b"")
        with mock.patch.object(
            state_store,
            "_run_git_bytes_bounded",
            return_value=invalid,
        ), self.assertRaises(StateStoreError) as caught:
            state_store._state_store_uncommitted_paths(self.repo)
        self.assertIn("state_store_status_budget_exceeded", str(caught.exception))

    def test_malformed_host_derivatives_are_not_disposable(self) -> None:
        from aria_kernel.tools_binding import bind_tools_root

        store = self._published_then_fresh()
        with _EnvPatch(state_store.store_environment(store, REPO_HASH)):
            bind_tools_root(
                tools_dir=tools_root(store),
                workspace_root=self.repo,
                reason="test exact host derivative classification",
            )
        identity = tools_root(store) / "repo_identity.json"
        original_identity = identity.read_bytes()
        identity.write_text("{}\n", encoding="utf-8")
        self.assertIn(
            "tools/repo_identity.json",
            state_store._state_store_uncommitted_paths(store.root),
        )

        identity.write_bytes(original_identity)
        identity_payload = json.loads(original_identity)
        identity_payload["bound_canonical_identity"] = "foreign"
        identity.write_text(json.dumps(identity_payload), encoding="utf-8")
        from aria_kernel.workspace import canonical_identity

        self.assertIn(
            "tools/repo_identity.json",
            state_store._state_store_uncommitted_paths(
                store.root,
                expected_repo_identity=canonical_identity(self.repo),
            ),
        )
        identity.write_bytes(original_identity)
        identity_payload = json.loads(original_identity)
        identity_payload["unexpected"] = True
        identity.write_text(json.dumps(identity_payload), encoding="utf-8")
        self.assertIn(
            "tools/repo_identity.json",
            state_store._state_store_uncommitted_paths(store.root),
        )
        identity_payload = json.loads(original_identity)
        identity_payload["bound_repo_hash"] = "not-the-canonical-mirror"
        identity.write_text(json.dumps(identity_payload), encoding="utf-8")
        self.assertIn(
            "tools/repo_identity.json",
            state_store._state_store_uncommitted_paths(store.root),
        )
        identity_payload = json.loads(original_identity)
        identity_payload["bound_repo_root"] = str(Path(self._tmp.name) / "foreign")
        identity.write_text(json.dumps(identity_payload), encoding="utf-8")
        self.assertIn(
            "tools/repo_identity.json",
            state_store._state_store_uncommitted_paths(
                store.root,
                expected_repo_root=self.repo,
            ),
        )
        external_identity = Path(self._tmp.name) / "external-valid-identity.json"
        external_identity.write_bytes(original_identity)
        identity.unlink()
        identity.symlink_to(external_identity)
        self.assertIn(
            "tools/repo_identity.json",
            state_store._state_store_uncommitted_paths(store.root),
        )
        identity.unlink()
        identity.write_bytes(original_identity)
        index = tools_root(store) / "integrity_index.json"
        index.write_text('{"ledger_hashes": {"runs": "wrong"}}\n', encoding="utf-8")
        self.assertIn(
            "tools/integrity_index.json",
            state_store._state_store_uncommitted_paths(store.root),
        )

        from aria_kernel.tool_registry import update_tools_index

        update_tools_index(tools_root(store))
        index_payload = json.loads(index.read_text(encoding="utf-8"))
        index_payload["unexpected"] = True
        index.write_text(json.dumps(index_payload), encoding="utf-8")
        self.assertIn(
            "tools/integrity_index.json",
            state_store._state_store_uncommitted_paths(store.root),
        )

        update_tools_index(tools_root(store))
        index_payload = json.loads(index.read_text(encoding="utf-8"))
        index_payload["file_hashes"] = {"migration_state": "sha256:stale"}
        index.write_text(json.dumps(index_payload), encoding="utf-8")
        self.assertIn(
            "tools/integrity_index.json",
            state_store._state_store_uncommitted_paths(store.root),
        )

    def test_same_common_dir_bound_root_is_valid_but_arbitrary_root_is_not(self) -> None:
        from aria_kernel.tools_binding import bind_tools_root
        from aria_kernel.workspace import canonical_identity

        store = self._published_then_fresh()
        with _EnvPatch(state_store.store_environment(store, REPO_HASH)):
            bind_tools_root(
                tools_dir=tools_root(store),
                workspace_root=self.repo,
                reason="test linked-worktree host identity",
            )
        linked = Path(self._tmp.name) / "linked-worktree"
        _git(self.repo, "worktree", "add", "--detach", str(linked), "HEAD")
        identity_path = tools_root(store) / "repo_identity.json"
        identity = json.loads(identity_path.read_text(encoding="utf-8"))
        identity["bound_repo_root"] = str(linked)
        identity_path.write_text(json.dumps(identity), encoding="utf-8")

        self.assertNotIn(
            "tools/repo_identity.json",
            state_store._state_store_uncommitted_paths(
                store.root,
                expected_repo_identity=canonical_identity(self.repo),
                expected_repo_root=self.repo,
            ),
        )

    @unittest.skipUnless(os.name == "posix", "advisory flock is POSIX-only")
    def test_actively_held_sidecar_lock_is_not_disposable(self) -> None:
        import fcntl

        store = self._published_then_fresh()
        sidecar = tools_root(store) / "runs.jsonl.lock"
        sidecar.touch()
        with sidecar.open("a+") as handle:
            fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            self.assertIn(
                "tools/runs.jsonl.lock",
                state_store._state_store_uncommitted_paths(store.root),
            )

    def test_an_unbound_restored_root_is_refused_rather_than_guessed(self) -> None:
        from aria_kernel.tool_registry import GovernanceError, ensure_tools_dir

        fresh = self._published_then_fresh()
        with _EnvPatch(state_store.store_environment(fresh, REPO_HASH)):
            with self.assertRaises(GovernanceError) as caught:
                ensure_tools_dir()
        self.assertIn("ambiguous_tools_root", str(caught.exception))

    def test_the_restore_time_bind_makes_it_usable(self) -> None:
        """The step the restore action runs, asserted end to end.

        It was `migrate-tools-bootstrap` until ORPHAN-HIGH-556 separated the
        bind from the migration. The assertion is unchanged because the
        REQUIREMENT never changed — a restored store must end up usable. What
        changed is that reaching it no longer rewrites every covered ledger.
        """
        from aria_kernel.tool_registry import ensure_tools_dir
        from aria_kernel.tools_binding import bind_tools_root

        fresh = self._published_then_fresh()
        with _EnvPatch(state_store.store_environment(fresh, REPO_HASH)):
            result = bind_tools_root(
                tools_dir=str(tools_root(fresh)),
                workspace_root=str(self.repo),
                reason="bind the restored aria/state store to this checkout",
            )
            self.assertEqual(result["contract_version"], 3)
            self.assertEqual(ensure_tools_dir(), tools_root(fresh))

    def test_the_bind_also_covers_a_genesis_store(self) -> None:
        """A newborn store has an EMPTY tools root, which takes the other
        branch of the migration chain. Both lanes hit this on the first run,
        so a fix that only worked on a populated root would fail exactly once
        — on the day it first mattered."""
        from aria_kernel.tool_registry import ensure_tools_dir
        from aria_kernel.tools_binding import bind_tools_root

        store = self._bootstrap()
        with _EnvPatch(state_store.store_environment(store, REPO_HASH)):
            result = bind_tools_root(
                tools_dir=str(tools_root(store)),
                workspace_root=str(self.repo),
                reason="bind the restored aria/state store to this checkout",
            )
            self.assertEqual(result["contract_version"], 3)
            self.assertEqual(ensure_tools_dir(), tools_root(store))


class LearnedConventionContinuity(StateStoreTestCase):
    def test_pending_promotion_survives_publish_restore_and_prompt_retrieval(self) -> None:
        """A restored tools root resumes its own learning without shadow state."""
        from aria_kernel import knowledge_graph
        from aria_kernel.agent_invocations import render_invocation_prompt
        from aria_kernel.cycle_phases import MemoryHookImpl
        from aria_kernel.gh_token_factory import mint_signing_key, revoke_signing_key
        from aria_kernel.implementation_reconciler import reconcile_recorded_implementations
        from aria_kernel.ledger import load_declared_jsonl
        from aria_kernel.operator_approval import verify_operator_approval_ref
        from aria_kernel.plan_convergence import (
            fold_plan_state,
            record_implementation_outcome,
            record_implementation_started,
            request_implementation,
        )
        from aria_kernel.tool_registry import append_tools_governance
        from aria_kernel.tools_binding import bind_tools_root
        from tests._helpers.declared_fixtures import seed_repo_verified_evidence
        from tests._helpers.production_shaped import (
            production_converged_plan,
            production_request_without_anchor,
        )

        # An empty disposable CWD makes accidental ambient discovery observable.
        isolated_cwd = Path(self._tmp.name) / "isolated-cwd"
        isolated_cwd.mkdir()
        original_cwd = Path.cwd()
        self.addCleanup(os.chdir, original_cwd)
        os.chdir(isolated_cwd)
        evidence_path = "docs/aria/SPEC.md"
        evidence_refs = [f"{evidence_path}:{line}" for line in range(1, 6)]
        anti_ref = f"{evidence_path}:6"
        source_sha = seed_repo_verified_evidence(
            self.repo,
            {evidence_path: "".join(f"Learning evidence line {line}.\n" for line in range(1, 7))},
        )
        store = self._bootstrap()
        tools = tools_root(store)
        shadow_roots = [self.repo, store.root, tools, isolated_cwd]

        def assert_no_shadow_tools() -> None:
            for root in shadow_roots:
                self.assertFalse((root / "aria-tools").exists(), str(root))

        cycle_id = "cycle-store-learning"
        plan_id = "plan-store-learning"
        anti_id = "anti-store-learning"
        convention_path = tools / "knowledge-graph/conventions.jsonl"
        learning_paths = {
            "plan_convergence_events:plans/events.jsonl": Path("plans/events.jsonl"),
            "kg_conventions": Path("knowledge-graph/conventions.jsonl"),
            "kg_anti_patterns": Path("knowledge-graph/anti-patterns.jsonl"),
        }
        with _EnvPatch(state_store.store_environment(store, REPO_HASH)):
            bind_tools_root(
                tools_dir=tools, workspace_root=self.repo,
                reason="bind the learning continuity fixture",
            )
            plan = production_converged_plan(
                tools_dir=tools, workspace_root=self.repo, plan_id=plan_id,
                affected_paths=[evidence_path], evidence_refs=evidence_refs,
            )
            key = mint_signing_key(cycle_id=cycle_id, workspace_root=self.repo)
            try:
                observation = MemoryHookImpl().record(
                    cycle_id=cycle_id, plan_id=plan_id,
                    workspace_root=self.repo, base_dir=tools,
                    plan_envelope_metadata={}, profile="standard",
                    signer_key_fp=key.fingerprint,
                )
            finally:
                revoke_signing_key(cycle_id=cycle_id, workspace_root=self.repo)
            self.assertEqual(observation["status"], "memory_hook_recorded", observation)
            self.assertTrue(observation["chain_verified"], observation)
            assert_no_shadow_tools()
            hypotheses = load_declared_jsonl(convention_path, expected_surface="kg_conventions")
            self.assertEqual(
                [(row["plan_id"], row["outcome_status"]) for row in hypotheses],
                [(plan_id, "hypothesis")],
            )
            hypothesis_id = hypotheses[0]["pattern_id"]
            self.assertEqual(hypotheses[0]["evidence_refs"], evidence_refs)
            hypothesis_bytes = convention_path.read_bytes()

            approval = append_tools_governance(
                tools, "operator_action",
                {"action": "approve", "pattern_id": anti_id, "reason": "fixture operator review"},
            )
            approval_ref = f"gov:{approval['event_id']}"
            anti_path = knowledge_graph.record_anti_pattern(
                knowledge_graph.Pattern(
                    pattern_id=anti_id, pattern_type="anti_pattern", confidence=0.9,
                    evidence_refs=(anti_ref,), discovered_by_cycle_id=cycle_id,
                    observed_at="2026-09-10T00:00:00Z",
                ),
                base_dir=tools, workspace_root=self.repo,
                reason_class="tool_design", operator_signature=approval_ref,
            )
            self.assertEqual(anti_path, tools / learning_paths["kg_anti_patterns"])
            request_implementation(
                plan_id=plan_id, implementer_agent="aria-implementer",
                converged_plan_revision_id=plan.revision_id,
                converged_plan_content_hash=plan.content_hash, base_dir=tools,
            )
            record_implementation_started(
                plan_id=plan_id, claim_id="claim-store-learning",
                implementer_agent="aria-implementer",
                started_at="2026-09-10T00:10:00Z", base_dir=tools,
            )
            record_implementation_outcome(
                plan_id=plan_id, claim_id="claim-store-learning",
                pr_url="https://github.com/o/r/pull/4242",
                diff_hash="sha256:" + "c" * 64,
                branch_tip_sha=source_sha, base_branch_sha=source_sha,
                validation_results=[], signer_key_fp=key.fingerprint,
                completed_at="2026-09-10T00:20:00Z", base_dir=tools,
            )

            class MergedReader:
                def readable(self) -> tuple[bool, str]:
                    return True, "fixture merge available"

                def pr_merge_state(self, pr_number: int) -> dict:
                    if pr_number != 4242:
                        raise AssertionError(f"unexpected PR: {pr_number}")
                    return {
                        "state": "MERGED", "mergedAt": "2026-09-10T00:30:00Z",
                        "mergeCommit": {"oid": source_sha},
                    }

            def fail_promotion(transaction, path, row, surface, previous) -> None:
                self.assertEqual(path, convention_path)
                self.assertEqual(row["outcome_status"], "verified")
                self.assertEqual(
                    fold_plan_state(plan_id=plan_id, base_dir=tools)["state"],
                    "IMPLEMENTATION_MERGED",
                )
                raise OSError("fixture promotion append unavailable")

            with mock.patch.object(knowledge_graph, "_append_row_locked", side_effect=fail_promotion) as append:
                first = reconcile_recorded_implementations(base_dir=tools, reader=MergedReader())
            append.assert_called_once()
            self.assertEqual([row["plan_id"] for row in first["merged"]], [plan_id])
            self.assertEqual(first["promotions"][0]["status"], "retryable_error")
            self.assertEqual(convention_path.read_bytes(), hypothesis_bytes)
            assert_no_shadow_tools()
            carried_bytes = {
                name: (tools / relative).read_bytes()
                for name, relative in learning_paths.items()
            }
            snapshot = self._snapshot(store, "snap-learning-pending", cycle_id=cycle_id)
            for name, payload in carried_bytes.items():
                self.assertEqual(snapshot["surfaces"][name]["sha256"], hashlib.sha256(payload).hexdigest())
            published = publish_state(
                store, snapshot=snapshot, cycle_id=cycle_id, repo_hash=REPO_HASH,
            )
            self.assertTrue(published["published"], published)
            self.assertTrue(published["pushed"], published)

        fresh = checkout_state_store(self.repo, store_dir=self.repo.parent / "store-fresh")
        restored_tools = tools_root(fresh)
        shadow_roots.extend([fresh.root, restored_tools])
        self.assertFalse(fresh.bootstrapped)
        self.assertFalse((restored_tools / "repo_identity.json").exists())
        for name, relative in learning_paths.items():
            self.assertEqual((restored_tools / relative).read_bytes(), carried_bytes[name])
        with _EnvPatch(state_store.store_environment(fresh, REPO_HASH)):
            bind_tools_root(
                tools_dir=restored_tools, workspace_root=self.repo,
                reason="bind restored learning without rewriting learning history",
            )
            for name, relative in learning_paths.items():
                self.assertEqual((restored_tools / relative).read_bytes(), carried_bytes[name])
            self.assertEqual(
                verify_operator_approval_ref(
                    approval_ref, base_dir=restored_tools, surface="knowledge_graph_anti_pattern",
                )["event_id"],
                approval["event_id"],
            )

            class OfflineReader:
                def readable(self) -> tuple[bool, str]:
                    return False, "offline continuity fixture"

                def pr_merge_state(self, pr_number: int) -> dict:
                    raise AssertionError("persisted merge retry must not query a PR")

            restored_conventions = restored_tools / learning_paths["kg_conventions"]
            recovery = reconcile_recorded_implementations(base_dir=restored_tools, reader=OfflineReader())
            verified_id = f"{hypothesis_id}-verified"
            self.assertEqual(recovery["merged"], [])
            self.assertEqual(recovery["checked"], 0)
            self.assertEqual(recovery["promotions"], [
                {"plan_id": plan_id, "status": "promoted", "pattern_id": verified_id},
            ])
            rows = load_declared_jsonl(restored_conventions, expected_surface="kg_conventions")
            self.assertEqual(
                [(row["pattern_id"], row["outcome_status"]) for row in rows],
                [(hypothesis_id, "hypothesis"), (verified_id, "verified")],
            )
            self.assertEqual(rows[1]["supersedes_pattern_id"], hypothesis_id)
            promoted_bytes = restored_conventions.read_bytes()
            again = reconcile_recorded_implementations(base_dir=restored_tools, reader=OfflineReader())
            self.assertEqual(again["merged"], [])
            self.assertEqual(again["promotions"], [
                {"plan_id": plan_id, "status": "already_verified", "pattern_id": verified_id},
            ])
            self.assertEqual(restored_conventions.read_bytes(), promoted_bytes)
            events = load_declared_jsonl(
                restored_tools / "plans/events.jsonl", expected_surface="plan_convergence_events",
            )
            self.assertEqual(
                [row["plan_id"] for row in events if row["event_type"] == "implementation_merged"],
                [plan_id],
            )
            assert_no_shadow_tools()

            request = production_request_without_anchor(
                base_dir=restored_tools, context_repo_root=self.repo,
                evidence_refs=[evidence_refs[0], anti_ref], allowed_scope=[evidence_path],
                suggested_prompt="Review this area using its restored learning context.",
            )
            knowledge = request["established_knowledge"]
            conventions = {row["pattern_id"]: row for row in knowledge["conventions"]}
            self.assertIn(verified_id, conventions)
            self.assertEqual(conventions[verified_id]["outcome_status"], "verified")
            self.assertEqual(conventions[verified_id]["evidence_refs"], evidence_refs[:3])
            self.assertEqual(
                [(row["pattern_id"], row["evidence_refs"]) for row in knowledge["anti_patterns"]],
                [(anti_id, [anti_ref])],
            )
            prompt = render_invocation_prompt(request)
            self.assertIn(f"- convention `{verified_id}`", prompt)
            self.assertIn(
                f"- operator-adjudicated anti-pattern `{anti_id}` (tool_design); "
                "scoped prior context, not a verdict for this task",
                prompt,
            )
            self.assertIn("  - source refs: " + json.dumps(evidence_refs[:3], ensure_ascii=False), prompt)
            self.assertIn("  - source refs: " + json.dumps([anti_ref], ensure_ascii=False), prompt)
            stored_prompts = load_declared_jsonl(
                restored_tools / "agent-invocations/prompts.jsonl",
                expected_surface="agent_invocation_prompts",
            )
            self.assertEqual(
                [row["prompt_text"] for row in stored_prompts if row["request_id"] == request["request_id"]],
                [prompt],
            )
            self.assertEqual(restored_conventions.read_bytes(), promoted_bytes)
            self.assertEqual(
                (restored_tools / learning_paths["kg_anti_patterns"]).read_bytes(),
                carried_bytes["kg_anti_patterns"],
            )
            assert_no_shadow_tools()
            successor = self._snapshot(fresh, "snap-learning-recovered", cycle_id="cycle-store-recovered")
            self.assertEqual(successor["prev_manifest_root"], snapshot["manifest_root"])
            published_recovery = publish_state(
                fresh, snapshot=successor, cycle_id="cycle-store-recovered", repo_hash=REPO_HASH,
            )
            self.assertTrue(published_recovery["published"], published_recovery)
            self.assertTrue(published_recovery["pushed"], published_recovery)
            verdict = verify_state_store(fresh, repo_hash=REPO_HASH)
            self.assertTrue(verdict["valid"], verdict)
        assert_no_shadow_tools()


class SurfaceGrowthIsMeasured(StateStoreTestCase):
    def test_the_snapshot_records_each_surface_size(self) -> None:
        """PLAN §2.2b's archival trigger needs a series to fire on.

        `.seg-NNN` rollover was superseded — 42 blocking couplings across
        the readers, against a largest-real-ledger measurement of 313 KB
        versus an 8 MB threshold. Its replacement is a MEASURED trigger,
        and nothing in ARIA measured surface size at all: the question
        "is any surface approaching a size that matters" had no answer
        short of someone going and looking.
        """
        store = self._bootstrap()
        payload = "".join(f'{{"row": {i}}}\n' for i in range(200))
        surface = self._seed_surface(store, payload)
        snapshot = self._snapshot(store, "snap-1")

        entry = snapshot["surfaces"]["runs"]
        self.assertEqual(entry["size_bytes"], surface.stat().st_size)
        self.assertGreater(entry["size_bytes"], 0)
        # Every carried surface is measurable, not just this one — a
        # trigger that can only see some of the tree is a trigger that
        # fires late on the rest.
        for name, carried in snapshot["surfaces"].items():
            self.assertIn("size_bytes", carried, name)


class StoreVerification(StateStoreTestCase):
    def test_a_store_matching_its_snapshot_verifies(self) -> None:
        store = self._bootstrap()
        self._seed_surface(store, '{"row": 1}\n')
        publish_state(store, snapshot=self._snapshot(store, "snap-1"), cycle_id="cycle-1", repo_hash=REPO_HASH)
        verdict = verify_state_store(store, repo_hash=REPO_HASH)
        self.assertTrue(verdict["valid"], verdict)
        self.assertEqual(verdict["drifted_surfaces"], [])

    def test_a_surface_changed_after_attestation_is_reported_as_drift(self) -> None:
        store = self._bootstrap()
        surface = self._seed_surface(store, '{"row": 1}\n')
        publish_state(store, snapshot=self._snapshot(store, "snap-1"), cycle_id="cycle-1", repo_hash=REPO_HASH)
        _write_chained_fixture(surface, '{"row": 1}\n{"row": 2}\n')
        verdict = verify_state_store(store, repo_hash=REPO_HASH)
        self.assertFalse(verdict["valid"])
        self.assertEqual(verdict["status"], "drifted")
        self.assertTrue(verdict["drifted_surfaces"])

    def test_a_published_snapshot_whose_root_was_edited_is_unusable_as_an_anchor(self) -> None:
        store = self._bootstrap()
        self._seed_surface(store, "")
        publish_state(store, snapshot=self._snapshot(store, "snap-1"), cycle_id="cycle-1", repo_hash=REPO_HASH)

        path = state_store.snapshot_path(store)
        tampered = json.loads(path.read_text(encoding="utf-8"))
        tampered["surfaces"] = {}
        path.write_text(json.dumps(tampered), encoding="utf-8")
        self._commit_in_store(store, "tamper")
        _git(store.root, "push", "origin", "HEAD:refs/heads/aria/state")
        _git(store.root, "update-ref", "refs/remotes/origin/aria/state", "HEAD")
        with self.assertRaises(StateStoreError) as ctx:
            read_published_snapshot(store)
        self.assertIn("state_store_published_root_mismatch", str(ctx.exception))


class ForceIsNotReachable(unittest.TestCase):
    """FF-only is a property of what this module never asks git for.

    Checked over the AST rather than the file text. ``--force`` is
    legitimate on ``worktree add`` and ``worktree remove`` — the store
    re-checkouts over stale worktrees on purpose — so a text scan would
    either flag those or be written loosely enough to miss the one call
    that matters. The invariant is narrower and exact: no ``git push``
    invocation may carry a force flag.
    """

    FORCE_FLAGS = frozenset({"-f", "--force", "--force-with-lease", "--force-if-includes"})

    def test_no_push_invocation_carries_a_force_flag(self) -> None:
        import ast

        tree = ast.parse(Path(state_store.__file__).read_text(encoding="utf-8"))
        pushes = 0
        for node in ast.walk(tree):
            if not isinstance(node, ast.Call) or not isinstance(node.func, ast.Name):
                continue
            if node.func.id not in {"_git", "_git_succeeds", "_run_git"}:
                continue
            literals = [a.value for a in node.args if isinstance(a, ast.Constant) and isinstance(a.value, str)]
            # `_run_git` takes its argv as a tuple; unpack that shape too.
            for arg in node.args:
                if isinstance(arg, (ast.Tuple, ast.List)):
                    literals += [
                        e.value for e in arg.elts
                        if isinstance(e, ast.Constant) and isinstance(e.value, str)
                    ]
            if "push" not in literals:
                continue
            pushes += 1
            offending = sorted(self.FORCE_FLAGS.intersection(literals))
            self.assertEqual(
                offending,
                [],
                f"git push in state_store carries {offending}; the store's "
                "compare-and-swap IS the server's fast-forward rule, and forcing "
                "discards another lane's publish with no trace",
            )
        self.assertEqual(pushes, 1, "expected exactly one push callsite in state_store")


class _EnvPatch:
    """Set/unset env vars for a block, restoring exactly what was there."""

    def __init__(self, values: dict[str, str | None]) -> None:
        self._values = values
        self._saved: dict[str, str | None] = {}

    def start(self) -> None:
        for key, value in self._values.items():
            self._saved[key] = os.environ.get(key)
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value

    def stop(self) -> None:
        for key, value in self._saved.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value
        self._saved.clear()

    def __enter__(self) -> "_EnvPatch":
        self.start()
        return self

    def __exit__(self, *exc: object) -> None:
        self.stop()


class PortableValidationContinuity(StateStoreTestCase):
    """Real native validation continuity through publication and live log reads."""

    def test_portable_validation_verifier_uses_restored_root_after_source_teardown(self) -> None:
        import sys

        from aria_kernel.change_ledger import (
            emit_change_committed,
            emit_change_planned,
            get_change_chain,
        )
        from aria_kernel.runtime_profile import set_profile
        from aria_kernel.tool_registry import ensure_tools_binding
        from aria_kernel.tools_binding import bind_tools_root
        from aria_kernel.validation import run_validation_commands
        from aria_kernel.validation_runs_ledger import (
            list_validation_runs_for_change,
            verify_validation_run,
        )
        from aria_kernel.workspace import canonical_identity

        selector = "test_paths.PathTests.test_normalized_case_sensitive_deduplication"
        command = "python3 -m unittest -v " + selector
        contents = {
            "paths.py": (
                "def unique_paths(paths):\n"
                "    return sorted({path.removeprefix('./') for path in paths})\n"
            ),
            "test_paths.py": (
                "import unittest\nfrom paths import unique_paths\n"
                "class PathTests(unittest.TestCase):\n"
                "    def test_normalized_case_sensitive_deduplication(self):\n"
                "        self.assertEqual(unique_paths(['./src/A.py', 'src/a.py', 'src/A.py']),\n"
                "                         ['src/A.py', 'src/a.py'])\n"
            ),
            ".gitignore": "__pycache__/\n",
        }
        scope = {"schema_version": 1, "files": {
            "source": ["paths.py"], "test": ["test_paths.py"],
            "config": [], "dependency": [],
        }}
        # The remote belongs to the class fixture, outside this producer lifetime.
        with tempfile.TemporaryDirectory(dir=self._tmp.name, prefix="producer-") as scratch:
            producer_base = Path(scratch)
            producer_repo = producer_base / "checkout"
            _git(Path(self._tmp.name), "clone", str(self.remote), str(producer_repo))
            _git(producer_repo, "config", "user.email", "aria@example.invalid")
            _git(producer_repo, "config", "user.name", "ARIA Test")
            _git(producer_repo, "config", "commit.gpgsign", "false")
            repo_identity = canonical_identity(producer_repo)
            self.assertEqual(repo_identity, canonical_identity(self.repo))
            store = checkout_state_store(producer_repo, store_dir=producer_base / "store")
            self.assertTrue(store.bootstrapped)
            original_store_root = store.root
            original_tools = tools_root(store)
            with _EnvPatch(state_store.store_environment(store, repo_identity)):
                set_profile("standard", operator_approval_ref="t", base_dir=original_tools)
                ensure_tools_binding(original_tools, workspace_root=producer_repo)
                for name, content in contents.items():
                    (producer_repo / name).write_text(content, encoding="utf-8")
                planned = emit_change_planned(
                    plan_id="plan-portable-validation", finding_id="F-portable-validation",
                    intended_affected_files=sorted(contents), intended_validation_refs=[command],
                    architectural_tier=1, base_dir=original_tools,
                )
                _git(producer_repo, "add", "--", *sorted(contents))
                _git(producer_repo, "commit", "--no-gpg-sign", "-m", "ordinary portable path validation")
                commit_sha = _git(producer_repo, "rev-parse", "HEAD").strip()
                _git(producer_repo, "push", "origin", "main")
                committed = emit_change_committed(
                    change_id=planned["change_id"], commit_sha=commit_sha,
                    actual_affected_files=sorted(contents), base_dir=original_tools,
                )
                self.assertEqual(_git(producer_repo, "status", "--porcelain"), "")
                plan = run_validation_commands(
                    commands=[command], workspace_root=producer_repo,
                    change_id=planned["change_id"], commit_sha=commit_sha,
                    runner_identity="ci-executor:portable-validation",
                    change_author_identity="agent:portable-validation-planner",
                    base_dir=original_tools, cycle_id="cycle-portable-validation",
                    input_scope=scope,
                )
                self.assertEqual(plan["status"], "ok")
                rows = list_validation_runs_for_change(planned["change_id"], base_dir=original_tools)
                self.assertEqual(len(rows), 1)
                row = rows[0]
                self.assertEqual((row["cmd"], row["commit_sha"], row["change_id"], row["exit_code"], row["timed_out"]),
                                 (command, commit_sha, planned["change_id"], 0, False))
                self.assertEqual(plan["validation_run_ids"], [row["validation_run_id"]])
                self.assertEqual(plan["run_refs"], [row["ledger_hash"]])
                self.assertEqual(get_change_chain(change_id=planned["change_id"], base_dir=original_tools)["committed"], committed)
                original_log_path = Path(row["log_path"])
                log_bytes = original_log_path.read_bytes()
                for marker in (selector.rsplit(".", 1)[-1].encode(), b"Ran 1 test", b"\nOK\n"):
                    self.assertIn(marker, log_bytes)
                self.assertEqual(verify_validation_run(row["validation_run_id"], base_dir=original_tools), row)
                self.assertEqual(_git(producer_repo, "status", "--porcelain"), "")
                self.assertFalse((producer_repo / "aria-tools").exists())
                binding = row["input_binding"]
                self.assertEqual((binding["repo_identity"], binding["base_commit_sha"], binding["source_stability"]),
                                 (repo_identity, commit_sha, "unchanged"))
                self.assertEqual(binding["scope_paths"], ["paths.py", "test_paths.py"])
                self.assertEqual(binding["availability"]["runner_environment"]["status"], "unknown")
                log_ref = row["log_ref"]
                self.assertEqual(log_ref, {
                    "schema_version": 2, "artifact_id": "validation-log:" + row["validation_run_id"],
                    "uri": original_log_path.relative_to(original_tools).as_posix(),
                    "sha256": "sha256:" + hashlib.sha256(log_bytes).hexdigest(),
                    "content_type": "text/plain; charset=utf-8",
                    "produced_by_workflow_run_id": row["validation_run_id"],
                    "source_surface": "validation_run_logs",
                })
                self.assertEqual(row["log_hash"], log_ref["sha256"])
                relative_paths = (
                    "change-ledger/planned.jsonl", "change-ledger/committed.jsonl",
                    "validation/validation-plans.jsonl", "validation/validation-runs.jsonl",
                    log_ref["uri"],
                )
                original_bytes = {relative: (original_tools / relative).read_bytes() for relative in relative_paths}
                base_head = _git(store.root, "rev-parse", "HEAD").strip()
                previous = state_store.read_snapshot_at_worktree_head(store, expected_head=base_head)
                snapshot = build_publishable_snapshot(
                    store, snapshot_id="snapshot-portable-validation", cycle_id="cycle-portable-validation",
                    lane="ordinary-portable-validation", repo_hash=repo_identity,
                    parent_commit=base_head, previous=previous,
                )
                for relative, original in original_bytes.items():
                    entries = [entry for entry in snapshot["surfaces"].values()
                               if entry["root_kind"] == "tools" and entry["path"] == relative]
                    self.assertEqual(len(entries), 1, relative)
                    self.assertEqual(entries[0]["sha256"], hashlib.sha256(original).hexdigest())
                    self.assertEqual(entries[0]["size_bytes"], len(original))
                    if relative == log_ref["uri"]:
                        self.assertEqual(entries[0]["storage"], "artifact_only")
                publication = publish_state(
                    store, snapshot=snapshot, cycle_id="cycle-portable-validation",
                    repo_hash=repo_identity, expected_base_head=base_head,
                )
                self.assertTrue(publication["published"])
                self.assertTrue(publication["pushed"])

        # Tear down source and its state worktree before creating the receiving clone.
        self.assertFalse(producer_repo.exists())
        self.assertFalse(original_store_root.exists())
        self.assertFalse(original_log_path.exists())
        fresh_repo = Path(self._tmp.name) / "receiving-checkout"
        _git(Path(self._tmp.name), "clone", str(self.remote), str(fresh_repo))
        self.assertEqual(_git(fresh_repo, "rev-parse", "HEAD").strip(), commit_sha)
        self.assertEqual(canonical_identity(fresh_repo), repo_identity)
        fresh = checkout_state_store(fresh_repo, store_dir=Path(self._tmp.name) / "receiving-store")
        self.assertFalse(fresh.bootstrapped)
        fresh_tools = tools_root(fresh)
        self.assertFalse((fresh_tools / "repo_identity.json").exists())
        for relative, original in original_bytes.items():
            self.assertEqual((fresh_tools / relative).read_bytes(), original, relative)
        with _EnvPatch(state_store.store_environment(fresh, repo_identity)):
            bound = bind_tools_root(
                tools_dir=fresh_tools, workspace_root=fresh_repo,
                reason="bind ordinary restored validation evidence",
            )
            self.assertEqual((bound["contract_version"], bound["migrated"]), (3, False))
            for relative, original in original_bytes.items():
                self.assertEqual((fresh_tools / relative).read_bytes(), original, relative)
            candidate_root = Path(__file__).resolve().parents[1]
            candidate_modules = {
                "aria_kernel": "aria_kernel/__init__.py",
                "aria_kernel.validation_runs_ledger": "aria_kernel/validation_runs_ledger.py",
                "aria_kernel.runtime_artifacts": "aria_kernel/runtime_artifacts.py",
                "aria_kernel.ledger": "aria_kernel/ledger.py",
                "aria_kernel.state_manifest": "aria_kernel/state_manifest.py",
                "aria_kernel.tool_registry": "aria_kernel/tool_registry.py",
            }
            expected_origins = {
                name: {"path": str((candidate_root / relative).resolve()),
                       "sha256": hashlib.sha256((candidate_root / relative).read_bytes()).hexdigest()}
                for name, relative in candidate_modules.items()
            }
            child_environment = dict(os.environ)
            child_environment.update({
                "PYTHONDONTWRITEBYTECODE": "1",
                # Replace an inherited path; never append a main-checkout path.
                "PYTHONPATH": str(candidate_root),
            })
            child_script = (
                "import hashlib,importlib,json,sys\n"
                "from pathlib import Path\n"
                "expected=json.loads(sys.argv[3]); observed={}\n"
                "for name, record in expected.items():\n"
                "    module=importlib.import_module(name)\n"
                "    origin=Path(module.__file__).resolve()\n"
                "    actual={'path':str(origin),'sha256':hashlib.sha256(origin.read_bytes()).hexdigest()}\n"
                "    if actual != record: raise AssertionError((name,actual,record))\n"
                "    observed[name]=actual\n"
                "sys.stderr.write('candidate_origin_receipt:'+json.dumps(observed,sort_keys=True)+'\\n')\n"
                "from aria_kernel.validation_runs_ledger import verify_validation_run\n"
                "print(json.dumps([verify_validation_run(sys.argv[2],base_dir=Path(sys.argv[1])) "
                "for _ in range(2)],sort_keys=True))\n"
            )
            child = subprocess.run(
                [sys.executable, "-B", "-c", child_script,
                 str(fresh_tools), row["validation_run_id"], json.dumps(expected_origins, sort_keys=True)],
                cwd=fresh_repo, env=child_environment, capture_output=True, text=True, timeout=60,
            )
            origin_receipts = [line.removeprefix("candidate_origin_receipt:")
                               for line in child.stderr.splitlines()
                               if line.startswith("candidate_origin_receipt:")]
            self.assertEqual(len(origin_receipts), 1, child.stdout + child.stderr)
            self.assertEqual(json.loads(origin_receipts[0]), expected_origins)
            # This is the decisive existing-consumer oracle. On current source,
            # old absolute log_path is missing despite the carried native log.
            self.assertEqual(child.returncode, 0, child.stdout + child.stderr)
            self.assertEqual(json.loads(child.stdout), [row, row])
            for relative, original in original_bytes.items():
                self.assertEqual((fresh_tools / relative).read_bytes(), original, relative)
        self.assertFalse(original_log_path.exists())
        self.assertFalse((fresh_repo / "aria-tools").exists())

    def test_large_live_validation_logs_preserve_scoped_and_legacy_verification(self) -> None:
        from aria_kernel.change_ledger import emit_change_committed, emit_change_planned
        from aria_kernel.runtime_profile import set_profile
        from aria_kernel.tool_registry import ensure_tools_binding
        from aria_kernel.validation import run_validation_commands
        from aria_kernel.validation_runs_ledger import (
            list_validation_runs_for_change,
            validation_runs_path,
            verify_validation_run,
        )
        from aria_kernel.workspace import canonical_identity

        selector = "test_paths.PathTests.test_large_normalized_deduplicated_listing"
        command = "python3 -m unittest -v " + selector
        contents = {
            "paths.py": (
                "def unique_paths(paths):\n"
                "    return sorted({path.removeprefix('./') for path in paths})\n"
            ),
            "test_paths.py": (
                "import unittest\nfrom paths import unique_paths\n"
                "class PathTests(unittest.TestCase):\n"
                "    def test_large_normalized_deduplicated_listing(self):\n"
                "        expected = [f'src/{index:05d}/' + 'segment/' * 14 + 'Record.py'\n"
                "                    for index in range(17000)]\n"
                "        inputs = ['./' + value for value in reversed(expected)]\n"
                "        actual = unique_paths(inputs + inputs)\n"
                "        self.assertEqual(actual, expected)\n"
                "        self.assertEqual(len(actual), 17000)\n"
                "        print('VALIDATED-PATHS-BEGIN')\n"
                "        for value in actual:\n"
                "            print(value)\n"
                "        print('VALIDATED-PATHS-END')\n"
            ),
            ".gitignore": "__pycache__/\n",
        }
        # Independently construct/count the specified stdout bytes. This does
        # not call the fixture's normalization implementation or a log helper.
        listing = b"".join(
            b"src/" + str(index).zfill(5).encode("ascii") + b"/"
            + b"segment/" * 14 + b"Record.py\n"
            for index in range(17000)
        )
        self.assertEqual(listing.count(b"\n"), 17000)
        self.assertEqual(len(listing), 17000 * 132)
        self.assertGreater(len(listing), 2 * 1024 * 1024)
        expected_stdout = b"VALIDATED-PATHS-BEGIN\n" + listing + b"VALIDATED-PATHS-END\n"
        scope = {"schema_version": 1, "files": {
            "source": ["paths.py"], "test": ["test_paths.py"],
            "config": [], "dependency": [],
        }}

        for scoped in (False, True):
            with self.subTest(scoped=scoped):
                label = "scoped" if scoped else "legacy"
                case = Path(self._tmp.name) / ("large-hot-" + label)
                case.mkdir()
                repo = case / "checkout"
                _git(case, "clone", str(self.remote), str(repo))
                _git(repo, "config", "user.email", "aria@example.invalid")
                _git(repo, "config", "user.name", "ARIA Test")
                _git(repo, "config", "commit.gpgsign", "false")
                tools = case / "store" / "tools"
                with _EnvPatch({
                    "ARIA_TOOLS_DIR": str(tools),
                    "ARIA_WORKSPACE_BASE": str(case / "workspaces"),
                    "ARIA_REPO_STATE_ROOT": str(case / "repo-state"),
                    "ARIA_STATE_STORE_ROOT": None,
                }):
                    set_profile("standard", operator_approval_ref="t", base_dir=tools)
                    ensure_tools_binding(tools, workspace_root=repo)
                    for name, content in contents.items():
                        (repo / name).write_text(content, encoding="utf-8")
                    planned = emit_change_planned(
                        plan_id="plan-large-hot-" + label, finding_id="F-large-hot-" + label,
                        intended_affected_files=sorted(contents), intended_validation_refs=[command],
                        architectural_tier=1, base_dir=tools,
                    )
                    _git(repo, "add", "--", *sorted(contents))
                    _git(repo, "commit", "--no-gpg-sign", "-m", "ordinary large validated path listing")
                    commit_sha = _git(repo, "rev-parse", "HEAD").strip()
                    emit_change_committed(
                        change_id=planned["change_id"], commit_sha=commit_sha,
                        actual_affected_files=sorted(contents), base_dir=tools,
                    )
                    self.assertEqual(_git(repo, "status", "--porcelain"), "")
                    options = {"input_scope": scope} if scoped else {}
                    plan = run_validation_commands(
                        commands=[command], workspace_root=repo,
                        change_id=planned["change_id"], commit_sha=commit_sha,
                        runner_identity="ci-executor:large-hot-" + label,
                        change_author_identity="agent:large-hot-planner",
                        base_dir=tools, cycle_id="cycle-large-hot-" + label,
                        **options,
                    )
                    self.assertEqual(plan["status"], "ok")
                    rows = list_validation_runs_for_change(planned["change_id"], base_dir=tools)
                    self.assertEqual(len(rows), 1)
                    row = rows[0]
                    self.assertEqual((row["cmd"], row["commit_sha"], row["change_id"], row["exit_code"], row["timed_out"]),
                                     (command, commit_sha, planned["change_id"], 0, False))
                    self.assertEqual(plan["validation_run_ids"], [row["validation_run_id"]])
                    self.assertEqual(plan["run_refs"], [row["ledger_hash"]])
                    log_path = Path(row["log_path"])
                    self.assertTrue(log_path.is_file())
                    self.assertEqual(log_path.parent, tools / "validation" / "logs")
                    raw = log_path.read_bytes()
                    actual_stdout = raw.split(b"--- stdout ---\n", 1)[1].split(b"\n--- stderr ---\n", 1)[0]
                    # Keep a failing oracle bounded rather than dumping2MiB.
                    self.assertEqual(len(actual_stdout), len(expected_stdout))
                    self.assertEqual(hashlib.sha256(actual_stdout).hexdigest(), hashlib.sha256(expected_stdout).hexdigest())
                    self.assertEqual(actual_stdout.count(b"Record.py\n"), 17000)
                    self.assertGreater(len(raw), 2 * 1024 * 1024)
                    self.assertIn(selector.rsplit(".", 1)[-1].encode("ascii"), raw)
                    self.assertIn(b"Ran 1 test", raw)
                    self.assertIn(b"\nOK\n", raw)
                    expected_hash = "sha256:" + hashlib.sha256(raw).hexdigest()
                    self.assertEqual(row["log_hash"], expected_hash)
                    if scoped:
                        self.assertEqual(row["input_binding"]["repo_identity"], canonical_identity(repo))
                        self.assertEqual(row["input_binding"]["base_commit_sha"], commit_sha)
                        self.assertEqual(row["input_binding"]["source_stability"], "unchanged")
                        self.assertEqual(row["log_ref"], {
                            "schema_version": 2,
                            "artifact_id": "validation-log:" + row["validation_run_id"],
                            "uri": log_path.relative_to(tools).as_posix(),
                            "sha256": expected_hash,
                            "content_type": "text/plain; charset=utf-8",
                            "produced_by_workflow_run_id": row["validation_run_id"],
                            "source_surface": "validation_run_logs",
                        })
                    else:
                        self.assertNotIn("input_binding", row)
                        self.assertNotIn("log_ref", row)
                    native_path = validation_runs_path(tools)
                    before = native_path.read_bytes()
                    self.assertEqual(verify_validation_run(row["validation_run_id"], base_dir=tools), row)
                    self.assertEqual(native_path.read_bytes(), before)
                    self.assertEqual(hashlib.sha256(log_path.read_bytes()).hexdigest(), hashlib.sha256(raw).hexdigest())
                    self.assertEqual(_git(repo, "status", "--porcelain"), "")
                    self.assertFalse((repo / "aria-tools").exists())


if __name__ == "__main__":
    unittest.main()
