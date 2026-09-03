"""A lost publish race must resolve itself, against a real remote.

PLAN Wave 1 PR 2.6. `publish_state` is the compare-and-swap; until now the
LOSER of a race was told to "fetch and rebuild against the new tip" and left to
it, which on the scheduled lanes means the rows sit in a worktree nothing
revisits.

These tests use the same bare-remote-plus-clone harness as `test_state_store`
because the property under test is a git property: the second push is rejected
by the server, not by anything this code decides. A mocked rejection would
prove the handler runs, not that the handler runs on the thing that actually
happens.
"""

from __future__ import annotations

import errno
import hashlib
import inspect
import json
import multiprocessing
import os
import stat
import subprocess
import tempfile
import threading
import time
import unittest
from contextlib import contextmanager
from pathlib import Path
from unittest import mock

from aria_kernel import ledger as ledger_module
from aria_kernel import state_store
from aria_kernel.ledger import (
    read_jsonl,
    tools_index_group_ledgers,
    verify_index_hashes,
    verify_jsonl,
)
from aria_kernel.state_store import (
    BOOTSTRAP_ACK_ENV,
    StateStoreError,
    StateStoreRefusal,
    StatePublishOutcomeUnknown,
    checkout_state_store,
    publish_with_contention_replay,
    tools_root,
)
from aria_kernel.tools_binding import bind_tools_root

from tests._helpers.declared_fixtures import (
    append_declared_fixture,
    rewrite_declared_fixture,
)

REPO_HASH = "repohash0001"
SURFACE = "cycles"


def _git(cwd: Path, *args: str) -> str:
    return subprocess.run(
        ["git", "-C", str(cwd), *args], capture_output=True, text=True, check=True
    ).stdout


class _EnvPatch:
    def __init__(self, values: dict[str, str]) -> None:
        self._values = values
        self._saved: dict[str, str | None] = {}

    def start(self) -> None:
        import os

        for key, value in self._values.items():
            self._saved[key] = os.environ.get(key)
            os.environ[key] = value

    def stop(self) -> None:
        import os

        for key, saved in self._saved.items():
            if saved is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = saved


class PublishContentionTests(unittest.TestCase):
    """Two clones of one remote, publishing from the same tip."""

    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.base = Path(self._tmp.name)

        self.remote = self.base / "remote.git"
        self.remote.mkdir()
        _git(self.remote, "init", "--bare", "--initial-branch=main", ".")

        self.repo_a = self._clone("work-a", seed=True)
        self.identity = state_store._repository_identity(self.repo_a)
        self._ack = _EnvPatch({BOOTSTRAP_ACK_ENV: self.identity})
        self._ack.start()
        self.addCleanup(self._ack.stop)
        self.repo_b = self._clone("work-b", seed=False)

    def _clone(self, name: str, *, seed: bool) -> Path:
        repo = self.base / name
        repo.mkdir()
        _git(repo, "init", "--initial-branch=main", ".")
        _git(repo, "config", "user.email", "aria@example.invalid")
        _git(repo, "config", "user.name", "ARIA Test")
        _git(repo, "config", "commit.gpgsign", "false")
        _git(repo, "remote", "add", "origin", str(self.remote))
        if seed:
            (repo / "README.md").write_text("seed\n", encoding="utf-8")
            _git(repo, "add", "README.md")
            _git(repo, "commit", "--no-gpg-sign", "-m", "seed")
            _git(repo, "push", "origin", "main")
        else:
            _git(repo, "fetch", "origin", "main")
            _git(repo, "checkout", "-B", "main", "origin/main")
        return repo

    def _store(self, repo: Path, name: str):
        return checkout_state_store(repo, store_dir=self.base / name)

    def _append(self, store, cycle_id: str) -> None:
        """Bind the store's tools root the way a real lane must, then write.

        `ensure_tools_dir` REFUSES a tools root that holds covered state with no
        `repo_identity.json`, and a freshly checked-out store is exactly that:
        the identity file is machine-local binding state (it records an absolute
        `bound_repo_root`), so it is deliberately not a declared surface and the
        published branch does not carry it. `bind-tools-root` is the governed
        step that binds such a root — which is the same step PLAN §2.5 wanted
        deleted, and a second reason it must stay.

        It used to be spelled `migrate-tools-bootstrap`. ORPHAN-HIGH-556
        separated the two, and this helper's own first line says which one it
        always wanted.
        """
        root = tools_root(store)
        root.mkdir(parents=True, exist_ok=True)
        if not (root / "repo_identity.json").exists():
            bind_tools_root(
                tools_dir=root,
                workspace_root=store.repo_root,
                reason="bind the store checkout as this lane's tools root",
            )
        append_declared_fixture(
            root / "cycles.jsonl",
            {"schema_version": 2, "cycle_id": cycle_id, "event": "started"},
            expected_surface=SURFACE,
        )

    def _publish(self, store, snapshot_id: str, cycle_id: str, **kw):
        return publish_with_contention_replay(
            store,
            snapshot_id=snapshot_id,
            cycle_id=cycle_id,
            lane="test",
            repo_hash=REPO_HASH,
            **kw,
        )

    def _cycle_ids(self, store) -> list[str]:
        rows = read_jsonl(tools_root(store) / "cycles.jsonl")
        return [str(r["cycle_id"]) for r in rows]

    def _temporary_state_refs(self, store) -> list[str]:
        return _git(
            store.root,
            "for-each-ref",
            "--format=%(refname)",
            "refs/aria/tmp",
        ).splitlines()

    def _recovery_root(self, store) -> Path:
        common = Path(_git(store.root, "rev-parse", "--git-common-dir").strip())
        if not common.is_absolute():
            common = store.root / common
        return common.resolve() / "aria-state-recovery"

    def _create_unmanifested_recovery_package(
        self,
        store,
        transaction_name: str,
    ) -> Path:
        common_dir, store_id = state_store._recovery_store_location(store)
        recovery_root = common_dir / state_store._RECOVERY_ROOT_NAME
        recovery_root.mkdir(mode=0o700, exist_ok=True)
        recovery_root.chmod(0o700)
        store_root = recovery_root / store_id
        store_root.mkdir(mode=0o700, exist_ok=True)
        store_root.chmod(0o700)
        transaction = store_root / transaction_name
        transaction.mkdir(mode=0o700)
        return transaction

    def _fresh_store(self, store):
        return state_store.StateStore(
            root=store.root,
            branch=store.branch,
            repo_root=store.repo_root,
            remote=store.remote,
            bootstrapped=store.bootstrapped,
        )

    def _single_recovery_package(self, store) -> tuple[Path, dict[str, object]]:
        transactions = sorted(
            path
            for path in self._recovery_root(store).glob("*/*")
            if path.is_dir()
        )
        self.assertEqual(len(transactions), 1)
        manifest = json.loads(
            (transactions[0] / "manifest.json").read_text(encoding="utf-8")
        )
        return transactions[0], manifest

    def _assert_complete_recovery_package(
        self,
        transaction: Path,
        manifest: dict[str, object],
    ) -> None:
        expected = {
            "manifest.json",
            *(
                str(surface["blob"])
                for surface in manifest["surfaces"]
            ),
        }
        self.assertEqual(
            {entry.name for entry in transaction.iterdir()},
            expected,
        )
        self.assertEqual(stat.S_IMODE(transaction.stat().st_mode), 0o700)
        for name in expected:
            entry = transaction / name
            self.assertTrue(entry.is_file())
            self.assertFalse(entry.is_symlink())
            self.assertEqual(stat.S_IMODE(entry.stat().st_mode), 0o600)

    def _rewrite_recovery_phase(
        self,
        transaction: Path,
        manifest: dict[str, object],
        phase: str,
    ) -> dict[str, object]:
        updated = dict(manifest)
        updated["phase"] = phase
        package = state_store._RecoveryPackage(
            path=transaction,
            store_id=str(updated["store_id"]),
            blob_names=tuple(
                str(surface["blob"])
                for surface in updated["surfaces"]
            ),
        )
        state_store._write_recovery_manifest(package, updated)
        return updated

    def _retained_failed_recovery(self):
        store, base, local, base_head, winner = self._rebase_inputs()
        with mock.patch(
            "aria_kernel.contention_replay.replay_append_only_suffixes",
            side_effect=StateStoreError("injected retained replay failure"),
        ), self.assertRaises(StateStoreError):
            self._rebase(store, base, local, base_head, winner)
        transaction, manifest = self._single_recovery_package(store)
        return store, base_head, winner, transaction, manifest

    def _rebase_inputs(self):
        store_a = self._store(self.repo_a, "store-a")
        self._append(store_a, "shared-1")
        self._publish(store_a, "snap-base", "cycle-base")
        store_b = self._store(self.repo_b, "store-b")
        base_head = _git(store_b.root, "rev-parse", "HEAD").strip()
        base = state_store.read_snapshot_at_worktree_head(store_b)
        self._append(store_b, "lane-b-only")
        local = state_store.build_publishable_snapshot(
            store_b,
            snapshot_id="snap-b",
            cycle_id="cycle-b",
            lane="test",
            repo_hash=REPO_HASH,
        )
        self._append(store_a, "lane-a-only")
        self._publish(store_a, "snap-a", "cycle-a")
        winner = _git(self.remote, "rev-parse", "refs/heads/aria/state").strip()
        return store_b, base, local, base_head, winner

    def _unrelated_zero_ledger_rebase_inputs(self):
        store_a = self._store(self.repo_a, "store-a")
        self._append(store_a, "published-base")
        self._publish(store_a, "snap-base", "cycle-base")
        self._append(store_a, "published-winner")
        self._publish(store_a, "snap-winner", "cycle-winner")
        winner = _git(
            self.remote,
            "rev-parse",
            "refs/heads/aria/state",
        ).strip()

        store_b = self._store(self.repo_b, "store-unrelated")
        current = _git(store_b.root, "rev-parse", "HEAD").strip()
        root_commit = _git(
            store_b.root,
            "rev-list",
            "--max-parents=0",
            current,
        ).splitlines()[0]
        unrelated = _git(
            store_b.root,
            "commit-tree",
            f"{root_commit}^{{tree}}",
            "-m",
            "unrelated replay base",
        ).strip()
        _git(store_b.root, "update-ref", "HEAD", unrelated, current)
        _git(store_b.root, "reset", "--hard", unrelated)
        tracking = f"refs/remotes/{store_b.remote}/{store_b.branch}"
        _git(store_b.root, "update-ref", tracking, winner)

        base = state_store.read_snapshot_at_worktree_head(
            store_b,
            expected_head=unrelated,
        )
        self.assertIsNone(base)
        local = state_store.build_publishable_snapshot(
            store_b,
            snapshot_id="snap-unrelated",
            cycle_id="cycle-unrelated",
            lane="test",
            repo_hash=REPO_HASH,
        )
        self.assertFalse(
            any(
                entry.get("state_class") == "ledger"
                for entry in local["surfaces"].values()
            )
        )
        return store_b, base, local, unrelated, winner

    def _normal_zero_replay_inputs(
        self,
        *,
        winner_rows: list[dict[str, object]] | None = None,
    ):
        store_a = self._store(self.repo_a, "store-a")
        self._append(store_a, "shared-1")
        self._publish(store_a, "snap-base", "cycle-base")

        store_b = self._store(self.repo_b, "store-b")
        base_head = _git(store_b.root, "rev-parse", "HEAD").strip()
        base = state_store.read_snapshot_at_worktree_head(
            store_b,
            expected_head=base_head,
        )
        self._append(store_b, "lane-b-only")
        local = state_store.build_publishable_snapshot(
            store_b,
            snapshot_id="snap-loser",
            cycle_id="cycle-loser",
            lane="test",
            repo_hash=REPO_HASH,
            previous=base,
        )

        if winner_rows is None:
            self._append(store_a, "winner-only")
            self._append(store_a, "lane-b-only")
        else:
            rewrite_declared_fixture(
                tools_root(store_a) / "cycles.jsonl",
                winner_rows,
                expected_surface=SURFACE,
            )
        self._publish(store_a, "snap-winner", "cycle-winner")
        winner = _git(
            self.remote,
            "rev-parse",
            "refs/heads/aria/state",
        ).strip()
        return store_b, base, local, base_head, winner

    def _rebase(self, store, base, local, base_head, winner):
        return state_store.rebase_store_onto_remote(
            store,
            base=base,
            local=local,
            repo_hash=REPO_HASH,
            expected_winner=winner,
            expected_base=base_head,
        )

    def test_the_loser_rebuilds_onto_the_winner_and_both_rows_survive(self) -> None:
        """The property the whole PR exists for, over a real rejected push."""
        store_a = self._store(self.repo_a, "store-a")
        self._append(store_a, "shared-1")
        self._publish(store_a, "snap-base", "cycle-base")

        # Both lanes now hold the same tip.
        store_b = self._store(self.repo_b, "store-b")
        self._append(store_a, "lane-a-only")
        self._append(store_b, "lane-b-only")

        # A publishes first and wins.
        self._publish(store_a, "snap-a", "cycle-a")
        # B's push is rejected by the server, and B resolves it.
        result = self._publish(store_b, "snap-b", "cycle-b")

        self.assertTrue(result["published"])
        self.assertEqual(result["attempts"], 2)
        self.assertEqual(
            self._cycle_ids(store_b), ["shared-1", "lane-a-only", "lane-b-only"]
        )

    def test_identical_common_extension_is_not_replayed_before_unique_tail(
        self,
    ) -> None:
        """The verifier accepts a deduplicated extension beyond its old base."""
        store_a = self._store(self.repo_a, "store-a")
        self._append(store_a, "shared-1")
        self._publish(store_a, "snap-base", "cycle-base")

        store_b = self._store(self.repo_b, "store-b")
        self._append(store_a, "shared-extension")
        self._append(store_b, "shared-extension")
        self._append(store_a, "lane-a-only")
        self._append(store_b, "lane-b-only")

        self._publish(store_a, "snap-a", "cycle-a")
        result = self._publish(store_b, "snap-b", "cycle-b")

        self.assertTrue(result["published"])
        self.assertEqual(result["attempts"], 2)
        self.assertEqual(
            self._cycle_ids(store_b),
            [
                "shared-1",
                "shared-extension",
                "lane-a-only",
                "lane-b-only",
            ],
        )

    def test_fully_contained_common_extension_survives_a_longer_winner_tail(
        self,
    ) -> None:
        store_a = self._store(self.repo_a, "store-a")
        self._append(store_a, "shared-1")
        self._publish(store_a, "snap-base", "cycle-base")

        store_b = self._store(self.repo_b, "store-b")
        self._append(store_a, "shared-extension")
        self._append(store_b, "shared-extension")
        self._append(store_a, "winner-only")

        self._publish(store_a, "snap-a", "cycle-a")
        result = self._publish(store_b, "snap-b", "cycle-b")

        self.assertTrue(result["published"])
        self.assertEqual(result["attempts"], 2)
        self.assertEqual(
            self._cycle_ids(store_b),
            ["shared-1", "shared-extension", "winner-only"],
        )

    def test_two_worktrees_replay_from_their_own_head_not_shared_tracking(
        self,
    ) -> None:
        store_a = self._store(self.repo_a, "store-a")
        self._append(store_a, "shared-1")
        self._publish(store_a, "snap-base", "cycle-base")

        # These two stores deliberately share one repository and therefore
        # one refs/remotes/origin/aria/state. Their detached HEADs remain
        # independent, which is the state-store concurrency contract.
        store_b = self._store(self.repo_a, "store-b")
        self._append(store_a, "lane-a-only")
        self._append(store_b, "lane-b-only")

        self._publish(store_a, "snap-a", "cycle-a")
        result = self._publish(store_b, "snap-b", "cycle-b")

        self.assertEqual(result["attempts"], 2)
        self.assertEqual(
            self._cycle_ids(store_b),
            ["shared-1", "lane-a-only", "lane-b-only"],
        )

    def test_the_rebuilt_ledger_verifies(self) -> None:
        """A replayed row is re-chained, so the chain must still validate."""
        store_a = self._store(self.repo_a, "store-a")
        self._append(store_a, "shared-1")
        self._publish(store_a, "snap-base", "cycle-base")
        store_b = self._store(self.repo_b, "store-b")
        self._append(store_a, "lane-a-only")
        self._append(store_b, "lane-b-only")
        self._publish(store_a, "snap-a", "cycle-a")
        self._publish(store_b, "snap-b", "cycle-b")

        report = verify_jsonl(tools_root(store_b) / "cycles.jsonl")
        self.assertTrue(report["valid"], report)

    def test_a_glob_surface_survives_the_replay(self) -> None:
        """ORPHAN-HIGH-555 — glob surfaces broke every replay that carried one.

        Snapshot keys for glob surfaces are ``name:relative/path`` (the
        ``covered_tool_ledgers`` vocabulary). The replay staged each suffix at
        ``staging / f"{key}.jsonl"`` — a PATH once the key carries ``/`` — and
        re-appended with ``expected_surface=<key>``, which the declared-surface
        gate refuses. Found by running the recovery against the live branch,
        whose tree carries glob-fanned ledgers the plain-surface tests do not.
        """
        glob_rel = Path("runs") / "by-cycle" / "cyc-glob.jsonl"

        def _append_glob(store, marker: str) -> None:
            append_declared_fixture(
                tools_root(store) / glob_rel,
                {"schema_version": 2, "marker": marker},
                expected_surface="runs_by_cycle",
            )

        store_a = self._store(self.repo_a, "store-a")
        self._append(store_a, "shared-1")
        _append_glob(store_a, "shared-glob")
        self._publish(store_a, "snap-base", "cycle-base")

        store_b = self._store(self.repo_b, "store-b")
        self._append(store_a, "lane-a-only")
        self._append(store_b, "lane-b-only")
        _append_glob(store_b, "lane-b-glob")

        self._publish(store_a, "snap-a", "cycle-a")
        result = self._publish(store_b, "snap-b", "cycle-b")

        self.assertTrue(result["published"])
        rows = read_jsonl(tools_root(store_b) / glob_rel)
        self.assertEqual([r["marker"] for r in rows], ["shared-glob", "lane-b-glob"])
        report = verify_jsonl(tools_root(store_b) / glob_rel)
        self.assertTrue(report["valid"], report)

    def test_an_uncontended_publish_takes_one_attempt(self) -> None:
        """The orchestrator must not cost anything when there is no race."""
        store_a = self._store(self.repo_a, "store-a")
        self._append(store_a, "only-row")
        result = self._publish(store_a, "snap-1", "cycle-1")
        self.assertEqual(result["attempts"], 1)

    def test_head_move_after_base_read_refuses_before_mutating_the_store(self) -> None:
        store_a = self._store(self.repo_a, "store-a")
        self._append(store_a, "shared-1")
        self._publish(store_a, "snap-base", "cycle-base")
        self._append(store_a, "local-only")

        base_head = _git(store_a.root, "rev-parse", "HEAD").strip()
        racing_head = _git(
            store_a.root,
            "commit-tree",
            f"{base_head}^{{tree}}",
            "-p",
            base_head,
            "-m",
            "racing writer after snapshot base read",
        ).strip()
        surface = tools_root(store_a) / "cycles.jsonl"
        surface_before = surface.read_bytes()
        snapshot_file = store_a.root / state_store.SNAPSHOT_FILENAME
        snapshot_before = snapshot_file.read_bytes()
        staged_before = _git(
            store_a.root,
            "diff",
            "--cached",
            "--name-only",
        )
        real_read = state_store.read_snapshot_at_worktree_head
        real_run_git = state_store._run_git
        commands: list[str] = []

        def read_then_move_head(store, **kwargs):
            base = real_read(store, **kwargs)
            _git(store.root, "update-ref", "HEAD", racing_head, base_head)
            return base

        def record_commands(cwd, args):
            commands.append(args[0])
            return real_run_git(cwd, args)

        with mock.patch.object(
            state_store,
            "read_snapshot_at_worktree_head",
            side_effect=read_then_move_head,
        ), mock.patch.object(
            state_store,
            "_run_git",
            side_effect=record_commands,
        ), mock.patch.object(
            state_store,
            "rebase_store_onto_remote",
            side_effect=AssertionError("base movement must not reset or replay"),
        ), self.assertRaisesRegex(
            StateStoreRefusal,
            "state_publish_base_head_moved",
        ):
            self._publish(store_a, "snap-raced", "cycle-raced")

        self.assertEqual(_git(store_a.root, "rev-parse", "HEAD").strip(), racing_head)
        self.assertEqual(surface.read_bytes(), surface_before)
        self.assertEqual(snapshot_file.read_bytes(), snapshot_before)
        self.assertEqual(
            _git(store_a.root, "diff", "--cached", "--name-only"),
            staged_before,
        )
        self.assertNotIn("commit", commands)
        self.assertNotIn("push", commands)
        self.assertNotIn("reset", commands)

    def test_exact_worktree_snapshot_read_rechecks_head_after_the_blob_read(
        self,
    ) -> None:
        store_a = self._store(self.repo_a, "store-a")
        self._append(store_a, "shared-1")
        self._publish(store_a, "snap-base", "cycle-base")

        base_head = _git(store_a.root, "rev-parse", "HEAD").strip()
        racing_head = _git(
            store_a.root,
            "commit-tree",
            f"{base_head}^{{tree}}",
            "-p",
            base_head,
            "-m",
            "move HEAD while exact snapshot blob is being read",
        ).strip()
        snapshot_file = store_a.root / state_store.SNAPSHOT_FILENAME
        snapshot_before = snapshot_file.read_bytes()
        index_before = _git(store_a.root, "write-tree").strip()
        real_read_snapshot = state_store._read_snapshot_at

        def read_exact_then_move(store, anchor):
            self.assertEqual(anchor, base_head)
            snapshot = real_read_snapshot(store, anchor)
            _git(store.root, "update-ref", "HEAD", racing_head, base_head)
            return snapshot

        with mock.patch.object(
            state_store,
            "_read_snapshot_at",
            side_effect=read_exact_then_move,
        ), self.assertRaisesRegex(
            StateStoreRefusal,
            "state_publish_base_head_moved",
        ):
            state_store.read_snapshot_at_worktree_head(
                store_a,
                expected_head=base_head,
            )

        self.assertEqual(_git(store_a.root, "rev-parse", "HEAD").strip(), racing_head)
        self.assertEqual(snapshot_file.read_bytes(), snapshot_before)
        self.assertEqual(_git(store_a.root, "write-tree").strip(), index_before)

    def test_publish_rechecks_exact_base_immediately_before_snapshot_write(
        self,
    ) -> None:
        store_a = self._store(self.repo_a, "store-a")
        self._append(store_a, "shared-1")
        self._publish(store_a, "snap-base", "cycle-base")
        self._append(store_a, "local-only")

        base_head = _git(store_a.root, "rev-parse", "HEAD").strip()
        base = state_store.read_snapshot_at_worktree_head(
            store_a,
            expected_head=base_head,
        )
        snapshot = state_store.build_publishable_snapshot(
            store_a,
            snapshot_id="snap-raced-before-write",
            cycle_id="cycle-raced-before-write",
            lane="test",
            repo_hash=REPO_HASH,
        )
        racing_head = _git(
            store_a.root,
            "commit-tree",
            f"{base_head}^{{tree}}",
            "-p",
            base_head,
            "-m",
            "move HEAD immediately before snapshot write",
        ).strip()
        snapshot_file = store_a.root / state_store.SNAPSHOT_FILENAME
        snapshot_before = snapshot_file.read_bytes()
        cycles = tools_root(store_a) / "cycles.jsonl"
        cycles_before = cycles.read_bytes()
        index_before = _git(store_a.root, "write-tree").strip()
        staged_before = _git(store_a.root, "diff", "--cached", "--name-only")
        real_continuity = state_store.snapshot_continuity
        real_run_git = state_store._run_git
        commands: list[str] = []

        def continuity_then_move(current, previous):
            result = real_continuity(current, previous)
            _git(store_a.root, "update-ref", "HEAD", racing_head, base_head)
            return result

        def record_commands(cwd, args):
            commands.append(args[0])
            return real_run_git(cwd, args)

        with mock.patch.object(
            state_store,
            "snapshot_continuity",
            side_effect=continuity_then_move,
        ), mock.patch.object(
            state_store,
            "_run_git",
            side_effect=record_commands,
        ), mock.patch.object(
            state_store,
            "rebase_store_onto_remote",
            side_effect=AssertionError("base movement must not reset or replay"),
        ), self.assertRaisesRegex(
            StateStoreRefusal,
            "state_publish_base_head_moved",
        ):
            state_store.publish_state(
                store_a,
                snapshot=snapshot,
                cycle_id="cycle-raced-before-write",
                repo_hash=REPO_HASH,
                expected_base_head=base_head,
            )

        self.assertEqual(_git(store_a.root, "rev-parse", "HEAD").strip(), racing_head)
        self.assertEqual(snapshot_file.read_bytes(), snapshot_before)
        self.assertEqual(cycles.read_bytes(), cycles_before)
        self.assertEqual(_git(store_a.root, "write-tree").strip(), index_before)
        self.assertEqual(
            _git(store_a.root, "diff", "--cached", "--name-only"),
            staged_before,
        )
        self.assertNotIn("push", commands)
        self.assertNotIn("reset", commands)

    def test_snapshot_builder_and_cli_publish_are_explicitly_base_bound(self) -> None:
        from aria_kernel import cli as cli_module
        from aria_kernel import memory_gap as memory_gap_module

        parameters = inspect.signature(
            state_store.build_publishable_snapshot,
        ).parameters
        self.assertIn("previous", parameters)
        source = inspect.getsource(cli_module._handle_state_store_command)
        self.assertIn("base_head = _read_commit_ref", source)
        self.assertIn("expected_head=base_head", source)
        self.assertIn("previous=base", source)
        self.assertIn("expected_base_head=base_head", source)
        recovery_source = inspect.getsource(memory_gap_module.restore_and_replay)
        self.assertIn("base_head = _read_commit_ref", recovery_source)
        self.assertIn("expected_head=base_head", recovery_source)
        self.assertIn("expected_base=base_head", recovery_source)

    def test_ambiguous_push_reconciles_when_remote_tip_is_exact_commit(self) -> None:
        store_a = self._store(self.repo_a, "store-a")
        self._append(store_a, "only-row")
        real_run_git = state_store._run_git
        committed: list[str] = []
        calls: list[str] = []

        def accept_then_report_failure(cwd, args):
            calls.append(args[0])
            result = real_run_git(cwd, args)
            if args[0] != "push":
                return result
            self.assertEqual(result.returncode, 0, result.stderr)
            committed.append(args[2].split(":", 1)[0])
            return subprocess.CompletedProcess(
                result.args,
                1,
                result.stdout,
                "injected ambiguous push result",
            )

        with mock.patch.object(
            state_store,
            "_run_git",
            side_effect=accept_then_report_failure,
        ), mock.patch.object(
            state_store,
            "rebase_store_onto_remote",
            side_effect=AssertionError("accepted commit must not be replayed"),
        ):
            result = self._publish(store_a, "snap-1", "cycle-1")

        self.assertTrue(result["published"])
        self.assertEqual(result["attempts"], 1)
        self.assertEqual(_git(store_a.root, "rev-parse", "HEAD"), committed[0] + "\n")
        self.assertEqual(
            _git(self.remote, "rev-parse", "refs/heads/aria/state"),
            committed[0] + "\n",
        )
        self.assertEqual(self._cycle_ids(store_a), ["only-row"])
        self.assertEqual(calls.count("push"), 1)
        self.assertEqual(calls.count("fetch"), 1)
        self.assertEqual(self._temporary_state_refs(store_a), [])

    def test_exact_probe_then_remote_disappearance_is_unknown_and_recoverable(
        self,
    ) -> None:
        store_a = self._store(self.repo_a, "store-a")
        self._append(store_a, "only-row")
        real_run_git = state_store._run_git
        committed: list[str] = []
        removed = False

        def accept_probe_then_remove(cwd, args):
            nonlocal removed
            result = real_run_git(cwd, args)
            if args[0] == "push":
                self.assertEqual(result.returncode, 0, result.stderr)
                committed.append(args[2].split(":", 1)[0])
                return subprocess.CompletedProcess(
                    result.args,
                    1,
                    result.stdout,
                    "injected ambiguous push result",
                )
            if args[0] == "ls-remote" and not removed:
                self.assertEqual(result.returncode, 0, result.stderr)
                _git(
                    self.remote,
                    "update-ref",
                    "-d",
                    "refs/heads/aria/state",
                )
                removed = True
            return result

        with mock.patch.object(
            state_store,
            "_run_git",
            side_effect=accept_probe_then_remove,
        ), self.assertRaisesRegex(StateStoreError, "state_publish_outcome_unknown"):
            self._publish(store_a, "snap-1", "cycle-1")

        self.assertTrue(committed)
        self.assertEqual(_git(store_a.root, "rev-parse", "HEAD").strip(), committed[0])
        self.assertEqual(self._cycle_ids(store_a), ["only-row"])
        self.assertEqual(
            _git(
                store_a.root,
                "for-each-ref",
                "--format=%(refname)",
                "refs/aria/tmp",
            ).splitlines(),
            [],
        )

    def test_ambiguous_push_reconciles_when_remote_descends_from_commit(self) -> None:
        store_a = self._store(self.repo_a, "store-a")
        self._append(store_a, "only-row")
        real_run_git = state_store._run_git
        committed: list[str] = []
        descendant: list[str] = []
        calls: list[str] = []

        def accept_then_advance_and_report_failure(cwd, args):
            calls.append(args[0])
            result = real_run_git(cwd, args)
            if args[0] != "push":
                return result
            self.assertEqual(result.returncode, 0, result.stderr)
            committed.append(args[2].split(":", 1)[0])
            _git(self.repo_b, "fetch", "origin", "aria/state")
            _git(self.repo_b, "checkout", "--detach", "FETCH_HEAD")
            _git(self.repo_b, "commit", "--allow-empty", "-m", "remote descendant")
            descendant.append(_git(self.repo_b, "rev-parse", "HEAD").strip())
            _git(
                self.repo_b,
                "push",
                "origin",
                f"{descendant[0]}:refs/heads/aria/state",
            )
            return subprocess.CompletedProcess(
                result.args,
                1,
                result.stdout,
                "injected ambiguous push result",
            )

        with mock.patch.object(
            state_store,
            "_run_git",
            side_effect=accept_then_advance_and_report_failure,
        ), mock.patch.object(
            state_store,
            "rebase_store_onto_remote",
            side_effect=AssertionError("contained commit must not be replayed"),
        ):
            result = self._publish(store_a, "snap-1", "cycle-1")

        self.assertTrue(result["published"])
        self.assertEqual(result["attempts"], 1)
        self.assertEqual(
            _git(store_a.root, "rev-parse", "HEAD"),
            descendant[0] + "\n",
        )
        self.assertEqual(
            _git(
                store_a.root,
                "rev-parse",
                "refs/remotes/origin/aria/state",
            ),
            descendant[0] + "\n",
        )
        self.assertEqual(
            _git(self.remote, "rev-parse", "refs/heads/aria/state"),
            descendant[0] + "\n",
        )
        self.assertEqual(self._cycle_ids(store_a), ["only-row"])
        self.assertEqual(calls.count("push"), 1)
        self.assertEqual(self._temporary_state_refs(store_a), [])
        self.assertTrue(
            state_store.verify_state_store(store_a, repo_hash=REPO_HASH)["valid"],
        )
        verify_index_hashes(
            tools_root(store_a) / "integrity_index.json",
            tools_index_group_ledgers(tools_root(store_a)),
        )

    def _assert_invalid_descendant_reconciliation_is_unknown(self, kind: str) -> None:
        store_a = self._store(self.repo_a, "store-a")
        self._append(store_a, "only-row")
        real_run_git = state_store._run_git
        committed: list[str] = []
        invalid_descendant: list[str] = []
        reset_calls: list[tuple[str, ...]] = []

        def accept_then_publish_invalid_descendant(cwd, args):
            if cwd == store_a.root and args[0] == "reset":
                reset_calls.append(args)
            result = real_run_git(cwd, args)
            if cwd != store_a.root or args[0] != "push":
                return result
            self.assertEqual(result.returncode, 0, result.stderr)
            commit = args[2].split(":", 1)[0]
            committed.append(commit)
            _git(self.repo_b, "fetch", "origin", "aria/state")
            _git(self.repo_b, "checkout", "--detach", "FETCH_HEAD")
            if kind == "multiple_parents":
                parent = _git(self.repo_b, "rev-parse", f"{commit}^").strip()
                descendant = _git(
                    self.repo_b,
                    "commit-tree",
                    f"{commit}^{{tree}}",
                    "-p",
                    commit,
                    "-p",
                    parent,
                    "-m",
                    "invalid two-parent state descendant",
                ).strip()
            elif kind == "malformed_tree":
                (self.repo_b / "unclaimed-state-entry.txt").write_text(
                    "not declared by snapshot.json\n",
                    encoding="utf-8",
                )
                _git(self.repo_b, "add", "unclaimed-state-entry.txt")
                _git(
                    self.repo_b,
                    "commit",
                    "--no-gpg-sign",
                    "-m",
                    "invalid state descendant tree",
                )
                descendant = _git(self.repo_b, "rev-parse", "HEAD").strip()
            else:  # pragma: no cover - fixture guard
                self.fail(f"unknown invalid descendant fixture: {kind}")
            invalid_descendant.append(descendant)
            _git(
                self.repo_b,
                "push",
                "origin",
                f"{descendant}:refs/heads/aria/state",
            )
            return subprocess.CompletedProcess(
                result.args,
                1,
                result.stdout,
                "injected ambiguous result after invalid descendant",
            )

        with mock.patch.object(
            state_store,
            "_run_git",
            side_effect=accept_then_publish_invalid_descendant,
        ), mock.patch.object(
            state_store,
            "rebase_store_onto_remote",
            side_effect=AssertionError("invalid descendant must not be replayed"),
        ), self.assertRaisesRegex(
            StateStoreError,
            "state_publish_outcome_unknown",
        ):
            self._publish(store_a, f"snap-{kind}", f"cycle-{kind}")

        self.assertTrue(committed)
        self.assertTrue(invalid_descendant)
        self.assertEqual(_git(store_a.root, "rev-parse", "HEAD").strip(), committed[0])
        self.assertEqual(
            _git(self.remote, "rev-parse", "refs/heads/aria/state").strip(),
            invalid_descendant[0],
        )
        self.assertEqual(reset_calls, [])
        self.assertEqual(self._cycle_ids(store_a), ["only-row"])
        self.assertEqual(self._temporary_state_refs(store_a), [])

    def test_multi_parent_remote_descendant_is_never_adopted(self) -> None:
        self._assert_invalid_descendant_reconciliation_is_unknown(
            "multiple_parents",
        )

    def test_malformed_tree_remote_descendant_is_never_adopted(self) -> None:
        self._assert_invalid_descendant_reconciliation_is_unknown(
            "malformed_tree",
        )

    def test_malformed_remote_probe_fails_closed_without_reset_or_replay(self) -> None:
        store_a = self._store(self.repo_a, "store-a")
        self._append(store_a, "only-row")
        real_run_git = state_store._run_git
        committed: list[str] = []

        def ambiguous_with_malformed_probe(cwd, args):
            if args[0] == "push":
                committed.append(args[2].split(":", 1)[0])
                return subprocess.CompletedProcess(args, 1, "", "ambiguous push")
            if args[0] == "ls-remote":
                return subprocess.CompletedProcess(
                    args,
                    0,
                    "not-a-commit\trefs/heads/aria/state\n",
                    "",
                )
            return real_run_git(cwd, args)

        with mock.patch.object(
            state_store,
            "_run_git",
            side_effect=ambiguous_with_malformed_probe,
        ), mock.patch.object(
            state_store,
            "rebase_store_onto_remote",
            side_effect=AssertionError("unknown outcome must not replay"),
        ), self.assertRaisesRegex(StateStoreError, "state_publish_outcome_unknown"):
            self._publish(store_a, "snap-1", "cycle-1")

        self.assertEqual(_git(store_a.root, "rev-parse", "HEAD"), committed[0] + "\n")
        self.assertEqual(self._cycle_ids(store_a), ["only-row"])

    def test_reconciliation_fetch_failure_fails_closed_without_false_success(
        self,
    ) -> None:
        store_a = self._store(self.repo_a, "store-a")
        self._append(store_a, "only-row")
        real_run_git = state_store._run_git
        committed: list[str] = []
        calls: list[str] = []

        def ambiguous_with_failed_fetch(cwd, args):
            calls.append(args[0])
            if args[0] == "push":
                committed.append(args[2].split(":", 1)[0])
                return subprocess.CompletedProcess(args, 1, "", "ambiguous push")
            if args[0] == "ls-remote":
                return subprocess.CompletedProcess(
                    args,
                    0,
                    f"{'f' * 40}\trefs/heads/aria/state\n",
                    "",
                )
            if args[0] == "fetch":
                return subprocess.CompletedProcess(args, 1, "", "fetch failed")
            return real_run_git(cwd, args)

        with mock.patch.object(
            state_store,
            "_run_git",
            side_effect=ambiguous_with_failed_fetch,
        ), mock.patch.object(
            state_store,
            "rebase_store_onto_remote",
            side_effect=AssertionError("unknown outcome must not replay"),
        ), self.assertRaisesRegex(StateStoreError, "state_publish_outcome_unknown"):
            self._publish(store_a, "snap-1", "cycle-1")

        self.assertEqual(_git(store_a.root, "rev-parse", "HEAD"), committed[0] + "\n")
        self.assertEqual(self._cycle_ids(store_a), ["only-row"])
        self.assertEqual(calls.count("push"), 1)
        self.assertEqual(calls.count("fetch"), 1)
        self.assertEqual(self._temporary_state_refs(store_a), [])

    def test_two_parent_delayed_acceptance_fails_closed_without_replay(self) -> None:
        store_a = self._store(self.repo_a, "store-a")
        self._append(store_a, "shared-1")
        self._publish(store_a, "snap-base", "cycle-base")
        store_b = self._store(self.repo_b, "store-b")
        self._append(store_a, "lane-a-only")
        self._append(store_b, "lane-b-only")
        self._publish(store_a, "snap-a", "cycle-a")

        real_run_git = state_store._run_git
        real_rebase = state_store.rebase_store_onto_remote
        loser: list[str] = []
        state_pushes: list[str] = []
        resets: list[tuple[str, ...]] = []

        def capture_loser(cwd, args):
            if cwd == store_b.root and args[0] == "reset":
                resets.append(args)
            if cwd == store_b.root and args[0] == "push":
                state_pushes.append(args[2].split(":", 1)[0])
                if not loser:
                    loser.append(state_pushes[-1])
            return real_run_git(cwd, args)

        def accept_loser_before_replay(store, **kwargs):
            self.assertTrue(loser)
            late_store = self._store(self.repo_b, "late-store")
            self._append(late_store, "lane-b-only")
            self._publish(late_store, "snap-late", "cycle-late")
            canonical = _git(
                self.remote,
                "rev-parse",
                "refs/heads/aria/state",
            ).strip()
            winner = kwargs["expected_winner"]
            merged = _git(
                self.repo_b,
                "commit-tree",
                f"{canonical}^{{tree}}",
                "-p",
                canonical,
                "-p",
                loser[0],
                "-m",
                "late server acceptance",
            ).strip()
            _git(
                self.repo_b,
                "push",
                "origin",
                f"{merged}:refs/heads/aria/state",
            )
            self.assertEqual(
                _git(self.repo_b, "merge-base", "--is-ancestor", winner, merged),
                "",
            )
            return real_rebase(store, **kwargs)

        base_head = _git(store_b.root, "rev-parse", "HEAD").strip()
        cycles_before = (tools_root(store_b) / "cycles.jsonl").read_bytes()
        with mock.patch.object(
            state_store,
            "_run_git",
            side_effect=capture_loser,
        ), mock.patch.object(
            state_store,
            "rebase_store_onto_remote",
            side_effect=accept_loser_before_replay,
        ), mock.patch(
            "aria_kernel.contention_replay.replay_append_only_suffixes",
        ) as replay, self.assertRaisesRegex(
            StateStoreError,
            "state_publish_outcome_unknown: replay target's immutable snapshot",
        ):
            self._publish(store_b, "snap-b", "cycle-b")

        self.assertEqual(len(state_pushes), 1)
        self.assertEqual(resets, [])
        replay.assert_not_called()
        self.assertEqual(_git(store_b.root, "rev-parse", "HEAD").strip(), base_head)
        self.assertEqual(
            (tools_root(store_b) / "cycles.jsonl").read_bytes(),
            cycles_before,
        )
        self.assertEqual(
            self._cycle_ids(store_b),
            ["shared-1", "lane-b-only"],
        )
        self.assertEqual(
            _git(store_b.root, "write-tree").strip(),
            _git(store_b.root, "rev-parse", f"{loser[0]}^{{tree}}").strip(),
        )
        transaction, manifest = self._single_recovery_package(store_b)
        self.assertEqual(manifest["phase"], "failed_before_reset")
        self._assert_complete_recovery_package(transaction, manifest)

    def test_tracking_descendant_of_observed_remote_is_not_accepted(self) -> None:
        store_a = self._store(self.repo_a, "store-a")
        self._append(store_a, "only-row")
        real_run_git = state_store._run_git
        tracking = "refs/remotes/origin/aria/state"
        ahead: list[str] = []

        def accept_then_put_tracking_ahead(cwd, args):
            result = real_run_git(cwd, args)
            if args[0] != "push":
                return result
            self.assertEqual(result.returncode, 0, result.stderr)
            committed = args[2].split(":", 1)[0]
            descendant = _git(
                store_a.root,
                "commit-tree",
                f"{committed}^{{tree}}",
                "-p",
                committed,
                "-m",
                "local tracking only",
            ).strip()
            _git(store_a.root, "update-ref", tracking, descendant)
            ahead.append(descendant)
            return subprocess.CompletedProcess(
                result.args,
                1,
                result.stdout,
                "injected ambiguous push result",
            )

        with mock.patch.object(
            state_store,
            "_run_git",
            side_effect=accept_then_put_tracking_ahead,
        ), self.assertRaisesRegex(
            StateStoreError,
            "state_publish_outcome_unknown",
        ):
            self._publish(store_a, "snap-1", "cycle-1")

        self.assertEqual(_git(store_a.root, "rev-parse", tracking).strip(), ahead[0])

    def test_descendant_reconciliation_refreshes_store_before_next_publish(
        self,
    ) -> None:
        store_a = self._store(self.repo_a, "store-a")
        self._append(store_a, "only-row")
        real_run_git = state_store._run_git
        injected = False

        def accept_then_advance_remote(cwd, args):
            nonlocal injected
            result = real_run_git(cwd, args)
            if cwd != store_a.root or args[0] != "push" or injected:
                return result
            self.assertEqual(result.returncode, 0, result.stderr)
            injected = True
            remote_store = self._store(self.repo_b, "remote-descendant-store")
            self._append(remote_store, "remote-descendant-row")
            self._publish(remote_store, "snap-remote", "cycle-remote")
            return subprocess.CompletedProcess(
                result.args,
                1,
                result.stdout,
                "injected ambiguous push result",
            )

        with mock.patch.object(
            state_store,
            "_run_git",
            side_effect=accept_then_advance_remote,
        ):
            result = self._publish(store_a, "snap-1", "cycle-1")

        tracking = "refs/remotes/origin/aria/state"
        remote_tip = _git(
            self.remote,
            "rev-parse",
            "refs/heads/aria/state",
        ).strip()
        self.assertEqual(result["push_outcome"], "reconciled")
        self.assertEqual(_git(store_a.root, "rev-parse", "HEAD").strip(), remote_tip)
        self.assertEqual(_git(store_a.root, "rev-parse", tracking).strip(), remote_tip)
        self.assertEqual(
            _git(self.remote, "rev-parse", "refs/heads/aria/state").strip(),
            remote_tip,
        )
        self.assertEqual(
            self._cycle_ids(store_a),
            ["only-row", "remote-descendant-row"],
        )
        self.assertEqual(
            state_store.read_snapshot_at_worktree_head(store_a)["snapshot_id"],
            "snap-remote",
        )
        self.assertTrue(
            state_store.verify_state_store(store_a, repo_hash=REPO_HASH)["valid"],
        )
        verify_index_hashes(
            tools_root(store_a) / "integrity_index.json",
            tools_index_group_ledgers(tools_root(store_a)),
        )
        self.assertEqual(self._temporary_state_refs(store_a), [])

        self._append(store_a, "local-next-row")
        republished = self._publish(store_a, "snap-next", "cycle-next")

        self.assertTrue(republished["published"])
        self.assertEqual(
            self._cycle_ids(store_a),
            ["only-row", "remote-descendant-row", "local-next-row"],
        )
        self.assertEqual(
            _git(store_a.root, "rev-parse", "HEAD").strip(),
            _git(self.remote, "rev-parse", "refs/heads/aria/state").strip(),
        )

    def test_contention_rollback_cas_preserves_a_racing_head(self) -> None:
        store_a = self._store(self.repo_a, "store-a")
        base_head = _git(store_a.root, "rev-parse", "HEAD").strip()
        owned = _git(
            store_a.root,
            "commit-tree",
            f"{base_head}^{{tree}}",
            "-p",
            base_head,
            "-m",
            "owned publish commit",
        ).strip()
        racing = _git(
            store_a.root,
            "commit-tree",
            f"{owned}^{{tree}}",
            "-p",
            owned,
            "-m",
            "racing writer",
        ).strip()
        _git(store_a.root, "update-ref", "HEAD", owned, base_head)
        index_marker = store_a.root / "index-only-marker.txt"
        index_marker.write_text("preserve staged index bytes\n", encoding="utf-8")
        _git(store_a.root, "add", "index-only-marker.txt")
        index_before = _git(store_a.root, "write-tree").strip()
        real_run_git = state_store._run_git
        raced = False

        def move_head_before_cas(root, args):
            nonlocal raced
            if (
                root == store_a.root
                and args[:2] == ("update-ref", "HEAD")
                and not raced
            ):
                _git(store_a.root, "update-ref", "HEAD", racing, owned)
                raced = True
            return real_run_git(root, args)

        with mock.patch.object(
            state_store,
            "_run_git",
            side_effect=move_head_before_cas,
        ), self.assertRaisesRegex(
            StateStoreError,
            "state_publish_outcome_unknown",
        ):
            state_store._soft_reset_owned_commit(
                store_a,
                committed_head=owned,
                base_head=base_head,
            )

        self.assertEqual(_git(store_a.root, "rev-parse", "HEAD").strip(), racing)
        self.assertEqual(_git(store_a.root, "write-tree").strip(), index_before)

    def test_verifier_rollback_cas_preserves_a_racing_head(self) -> None:
        store_a = self._store(self.repo_a, "store-a")
        self._append(store_a, "only-row")
        snapshot = state_store.build_publishable_snapshot(
            store_a,
            snapshot_id="snap-1",
            cycle_id="cycle-1",
            lane="test",
            repo_hash=REPO_HASH,
        )
        real_run_git = state_store._run_git
        committed: list[str] = []
        racing_head: list[str] = []

        def reject_snapshot(**kwargs):
            committed.append(kwargs["state_commit"])
            raise RuntimeError("injected verifier rejection")

        def move_head_before_cas(cwd, args):
            if (
                args[:2] == ("update-ref", "HEAD")
                and committed
                and not racing_head
            ):
                other = _git(
                    store_a.root,
                    "commit-tree",
                    f"{committed[0]}^{{tree}}",
                    "-p",
                    committed[0],
                    "-m",
                    "racing writer",
                ).strip()
                _git(store_a.root, "update-ref", "HEAD", other, committed[0])
                racing_head.append(other)
            return real_run_git(cwd, args)

        with mock.patch(
            "aria_kernel.autonomy_evidence._verify_published_snapshot_commit",
            side_effect=reject_snapshot,
        ), mock.patch.object(
            state_store,
            "_run_git",
            side_effect=move_head_before_cas,
        ), self.assertRaisesRegex(
            StateStoreError,
            "state_publish_outcome_unknown",
        ):
            state_store.publish_state(
                store_a,
                snapshot=snapshot,
                cycle_id="cycle-1",
                repo_hash=REPO_HASH,
            )

        self.assertEqual(
            _git(store_a.root, "rev-parse", "HEAD").strip(),
            racing_head[0],
        )

    def test_verifier_rollback_cas_failure_preserves_owned_commit(self) -> None:
        store_a = self._store(self.repo_a, "store-a")
        self._append(store_a, "only-row")
        snapshot = state_store.build_publishable_snapshot(
            store_a,
            snapshot_id="snap-1",
            cycle_id="cycle-1",
            lane="test",
            repo_hash=REPO_HASH,
        )
        real_run_git = state_store._run_git
        committed: list[str] = []

        def reject_snapshot(**kwargs):
            committed.append(kwargs["state_commit"])
            raise RuntimeError("injected verifier rejection")

        def fail_head_cas(cwd, args):
            if args[:2] == ("update-ref", "HEAD"):
                return subprocess.CompletedProcess(args, 1, "", "injected CAS failure")
            return real_run_git(cwd, args)

        with mock.patch(
            "aria_kernel.autonomy_evidence._verify_published_snapshot_commit",
            side_effect=reject_snapshot,
        ), mock.patch.object(
            state_store,
            "_run_git",
            side_effect=fail_head_cas,
        ), self.assertRaisesRegex(
            StateStoreError,
            "state_publish_outcome_unknown",
        ):
            state_store.publish_state(
                store_a,
                snapshot=snapshot,
                cycle_id="cycle-1",
                repo_hash=REPO_HASH,
            )

        self.assertEqual(
            _git(store_a.root, "rev-parse", "HEAD").strip(),
            committed[0],
        )

    def test_replay_temp_staging_is_cleaned_after_success(self) -> None:
        store_a = self._store(self.repo_a, "store-a")
        self._append(store_a, "shared-1")
        self._publish(store_a, "snap-base", "cycle-base")
        store_b = self._store(self.repo_b, "store-b")
        self._append(store_a, "lane-a-only")
        self._append(store_b, "lane-b-only")
        self._publish(store_a, "snap-a", "cycle-a")
        recovery_root = self._recovery_root(store_b)

        self._publish(store_b, "snap-b", "cycle-b")

        self.assertTrue(recovery_root.is_dir())
        self.assertEqual(
            [path for path in recovery_root.glob("*/*") if path.is_dir()],
            [],
        )

    def test_replay_lock_acquisition_failure_has_zero_side_effects(self) -> None:
        store, base, local, base_head, winner = self._rebase_inputs()
        resets: list[tuple[str, ...]] = []
        real_run_git = state_store._run_git

        def record_reset(cwd, args):
            if cwd == store.root and args[0] == "reset":
                resets.append(args)
            return real_run_git(cwd, args)

        with mock.patch.object(
            state_store,
            "state_transaction",
            side_effect=TimeoutError("injected replay lock contention"),
            create=True,
        ) as transaction, mock.patch.object(
            state_store,
            "_stage_replay_surface",
            wraps=state_store._stage_replay_surface,
        ) as stage, mock.patch.object(
            state_store,
            "_fetch_remote_branch_tip",
            wraps=state_store._fetch_remote_branch_tip,
        ) as fetch, mock.patch.object(
            state_store,
            "_run_git",
            side_effect=record_reset,
        ):
            error: BaseException | None = None
            try:
                self._rebase(store, base, local, base_head, winner)
            except BaseException as exc:  # noqa: BLE001 - assertion captures type
                error = exc

        self.assertEqual(
            (
                type(error),
                transaction.call_count,
                stage.call_count,
                fetch.call_count,
                resets,
            ),
            (TimeoutError, 1, 0, 0, []),
        )

    def test_replay_refuses_a_canonical_base_not_bound_to_the_base_commit(
        self,
    ) -> None:
        from aria_kernel.state_snapshot import compute_manifest_root

        store, base, local, base_head, winner = self._rebase_inputs()
        wrong_base = json.loads(json.dumps(base))
        cycles = wrong_base["surfaces"]["cycles"]
        cycles["row_count"] = 0
        cycles["tail_ledger_hash"] = None
        cycles["size_bytes"] = 0
        cycles["sha256"] = state_store.hashlib.sha256(b"").hexdigest()
        wrong_base["manifest_root"] = compute_manifest_root(wrong_base)
        state_store.validate_snapshot_manifest(
            wrong_base,
            expected_root_kinds=state_store.store_roots(store, REPO_HASH),
        )
        resets: list[tuple[str, ...]] = []
        real_run_git = state_store._run_git

        def record_reset(cwd, args):
            if cwd == store.root and args[0] == "reset":
                resets.append(args)
            return real_run_git(cwd, args)

        with mock.patch.object(
            state_store,
            "_create_recovery_package",
            wraps=state_store._create_recovery_package,
        ) as create, mock.patch.object(
            state_store,
            "_fetch_remote_branch_tip",
            wraps=state_store._fetch_remote_branch_tip,
        ) as fetch, mock.patch.object(
            state_store,
            "_run_git",
            side_effect=record_reset,
        ), self.assertRaisesRegex(
            StateStoreRefusal,
            "replay_base_snapshot_mismatch",
        ):
            state_store.rebase_store_onto_remote(
                store,
                base=wrong_base,
                local=local,
                repo_hash=REPO_HASH,
                expected_winner=winner,
                expected_base=base_head,
            )

        self.assertEqual(create.call_count, 0)
        self.assertEqual(fetch.call_count, 0)
        self.assertEqual(resets, [])

    def test_replay_refuses_a_false_genesis_base(self) -> None:
        store, _base, local, base_head, winner = self._rebase_inputs()

        with mock.patch.object(
            state_store,
            "_create_recovery_package",
            wraps=state_store._create_recovery_package,
        ) as create, mock.patch.object(
            state_store,
            "_fetch_remote_branch_tip",
            wraps=state_store._fetch_remote_branch_tip,
        ) as fetch, self.assertRaisesRegex(
            StateStoreRefusal,
            "replay_base_snapshot_mismatch",
        ):
            state_store.rebase_store_onto_remote(
                store,
                base=None,
                local=local,
                repo_hash=REPO_HASH,
                expected_winner=winner,
                expected_base=base_head,
            )

        self.assertEqual(create.call_count, 0)
        self.assertEqual(fetch.call_count, 0)

    def test_replay_refuses_head_movement_during_exact_base_binding(self) -> None:
        store, base, local, base_head, winner = self._rebase_inputs()
        racing_head = _git(
            store.root,
            "commit-tree",
            f"{base_head}^{{tree}}",
            "-p",
            base_head,
            "-m",
            "move HEAD during replay base binding",
        ).strip()
        real_read_snapshot = state_store._read_snapshot_at
        moved = False

        def read_base_then_move(current_store, anchor):
            nonlocal moved
            snapshot = real_read_snapshot(current_store, anchor)
            if anchor == base_head and not moved:
                moved = True
                _git(store.root, "update-ref", "HEAD", racing_head, base_head)
            return snapshot

        with mock.patch.object(
            state_store,
            "_read_snapshot_at",
            side_effect=read_base_then_move,
        ), mock.patch.object(
            state_store,
            "_create_recovery_package",
            wraps=state_store._create_recovery_package,
        ) as create, mock.patch.object(
            state_store,
            "_fetch_remote_branch_tip",
            wraps=state_store._fetch_remote_branch_tip,
        ) as fetch, self.assertRaisesRegex(
            StateStoreRefusal,
            "replay_base_head_moved",
        ):
            self._rebase(store, base, local, base_head, winner)

        self.assertTrue(moved)
        self.assertEqual(create.call_count, 0)
        self.assertEqual(fetch.call_count, 0)
        self.assertEqual(_git(store.root, "rev-parse", "HEAD").strip(), racing_head)

    def test_rebase_readmits_recovery_package_after_acquiring_state_locks(
        self,
    ) -> None:
        store, base, local, base_head, winner = self._rebase_inputs()
        waiting_for_lock = threading.Event()
        release_lock = threading.Event()
        errors: list[BaseException] = []
        real_transaction = state_store.state_transaction

        @contextmanager
        def delayed_transaction(*args, **kwargs):
            waiting_for_lock.set()
            if not release_lock.wait(timeout=10):
                raise RuntimeError("test did not release state transaction")
            with real_transaction(*args, **kwargs) as transaction:
                yield transaction

        def run_rebase() -> None:
            try:
                self._rebase(store, base, local, base_head, winner)
            except BaseException as exc:  # noqa: BLE001 - thread handoff
                errors.append(exc)

        with mock.patch.object(
            state_store,
            "state_transaction",
            new=delayed_transaction,
        ), mock.patch.object(
            state_store,
            "_discover_recovery_package_path",
            wraps=state_store._discover_recovery_package_path,
        ) as discover, mock.patch.object(
            state_store,
            "_fetch_remote_branch_tip",
            wraps=state_store._fetch_remote_branch_tip,
        ) as fetch:
            replay_thread = threading.Thread(target=run_rebase, daemon=True)
            replay_thread.start()
            self.assertTrue(waiting_for_lock.wait(timeout=10))
            appeared = self._create_unmanifested_recovery_package(
                store,
                "0" * 32,
            )
            release_lock.set()
            replay_thread.join(timeout=15)

        self.assertFalse(replay_thread.is_alive())
        self.assertEqual(len(errors), 1)
        self.assertIsInstance(errors[0], StateStoreError)
        self.assertRegex(
            str(errors[0]),
            "state_recovery_package_already_exists",
        )
        self.assertEqual(discover.call_count, 2)
        self.assertEqual(fetch.call_count, 0)
        self.assertEqual(
            [
                path
                for path in self._recovery_root(store).glob("*/*")
                if path.is_dir()
            ],
            [appeared],
        )

    def test_recovery_package_creation_refuses_an_existing_package(self) -> None:
        store = self._store(self.repo_a, "store-package-admission")
        first = state_store._create_recovery_package(store, blob_names=())

        with self.assertRaisesRegex(
            StateStoreError,
            "state_recovery_package_already_exists",
        ):
            state_store._create_recovery_package(store, blob_names=())

        self.assertEqual(
            [
                path
                for path in self._recovery_root(store).glob("*/*")
                if path.is_dir()
            ],
            [first.path],
        )

    def test_recovery_rediscovery_inside_lock_rejects_a_second_package(
        self,
    ) -> None:
        store, _base_head, _winner, transaction, _manifest = (
            self._retained_failed_recovery()
        )
        waiting_for_lock = threading.Event()
        release_lock = threading.Event()
        errors: list[BaseException] = []
        results: list[dict[str, object]] = []
        real_transaction = state_store.state_transaction

        @contextmanager
        def delayed_transaction(*args, **kwargs):
            waiting_for_lock.set()
            if not release_lock.wait(timeout=10):
                raise RuntimeError("test did not release state transaction")
            with real_transaction(*args, **kwargs) as held:
                yield held

        def run_recovery() -> None:
            try:
                results.append(
                    state_store.recover_pending_state_replay(
                        self._fresh_store(store),
                        repo_hash=REPO_HASH,
                    )
                )
            except BaseException as exc:  # noqa: BLE001 - thread handoff
                errors.append(exc)

        with mock.patch.object(
            state_store,
            "state_transaction",
            new=delayed_transaction,
        ), mock.patch.object(
            state_store,
            "_discover_recovery_package_path",
            wraps=state_store._discover_recovery_package_path,
        ) as discover:
            recovery_thread = threading.Thread(target=run_recovery, daemon=True)
            recovery_thread.start()
            self.assertTrue(waiting_for_lock.wait(timeout=10))
            second_name = "0" * 32 if transaction.name != "0" * 32 else "1" * 32
            second = self._create_unmanifested_recovery_package(
                store,
                second_name,
            )
            release_lock.set()
            recovery_thread.join(timeout=15)

        self.assertFalse(recovery_thread.is_alive())
        self.assertEqual(results, [])
        self.assertEqual(len(errors), 1)
        self.assertIsInstance(errors[0], StateStoreError)
        self.assertRegex(str(errors[0]), "state_recovery_multiple_packages")
        self.assertEqual(discover.call_count, 2)
        self.assertTrue(transaction.exists())
        self.assertTrue(second.exists())

    def test_replay_blocks_concurrent_writers_and_preserves_new_surfaces(
        self,
    ) -> None:
        store, base, local, base_head, winner = self._rebase_inputs()
        root = tools_root(store)
        staged = threading.Event()
        release = threading.Event()
        replay_done = threading.Event()
        real_fetch = state_store._fetch_remote_branch_tip
        errors: list[BaseException] = []

        def pause_after_staging(current_store):
            staged.set()
            if not release.wait(timeout=10):
                raise RuntimeError("test did not release replay fetch")
            return real_fetch(current_store)

        def run_replay() -> None:
            try:
                self._rebase(store, base, local, base_head, winner)
            except BaseException as exc:  # noqa: BLE001 - thread handoff
                errors.append(exc)
            finally:
                replay_done.set()

        writer_specs = (
            (
                "existing",
                lambda: self._append(store, "after-staging"),
            ),
            (
                "absent-exact",
                lambda: append_declared_fixture(
                    root / "queues" / "next_cycle_queue.jsonl",
                    {"schema_version": 1, "event": "after-staging"},
                    expected_surface="next_cycle_queue",
                ),
            ),
            (
                "absent-wildcard",
                lambda: append_declared_fixture(
                    root / "dispatch" / "concurrent.jsonl",
                    {"schema_version": 1, "event": "after-staging"},
                    expected_surface="worker_dispatch",
                ),
            ),
        )
        writer_done = {name: threading.Event() for name, _writer in writer_specs}

        def run_writer(name, writer) -> None:
            try:
                writer()
            except BaseException as exc:  # noqa: BLE001 - thread handoff
                errors.append(exc)
            finally:
                writer_done[name].set()

        with mock.patch.object(
            state_store,
            "_fetch_remote_branch_tip",
            side_effect=pause_after_staging,
        ):
            replay_thread = threading.Thread(target=run_replay, daemon=True)
            replay_thread.start()
            self.assertTrue(staged.wait(timeout=10))
            writer_threads = [
                threading.Thread(
                    target=run_writer,
                    args=(name, writer),
                    daemon=True,
                )
                for name, writer in writer_specs
            ]
            for writer_thread in writer_threads:
                writer_thread.start()
            time.sleep(0.25)
            blocked = {
                name: not writer_done[name].is_set()
                for name, _writer in writer_specs
            }
            release.set()
            replay_thread.join(timeout=15)
            for writer_thread in writer_threads:
                writer_thread.join(timeout=15)

        self.assertTrue(replay_done.is_set())
        self.assertEqual(errors, [])
        self.assertEqual(blocked, {name: True for name, _writer in writer_specs})
        self.assertEqual(
            self._cycle_ids(store),
            ["shared-1", "lane-a-only", "lane-b-only", "after-staging"],
        )
        self.assertEqual(
            read_jsonl(root / "queues" / "next_cycle_queue.jsonl")[-1]["event"],
            "after-staging",
        )
        self.assertEqual(
            read_jsonl(root / "dispatch" / "concurrent.jsonl")[-1]["event"],
            "after-staging",
        )

    def test_replay_failure_releases_writer_after_exact_restore(self) -> None:
        store, base, local, base_head, winner = self._rebase_inputs()
        staged = threading.Event()
        release = threading.Event()
        writer_done = threading.Event()
        real_fetch = state_store._fetch_remote_branch_tip
        replay_errors: list[BaseException] = []
        writer_errors: list[BaseException] = []

        def pause_after_staging(current_store):
            staged.set()
            if not release.wait(timeout=10):
                raise RuntimeError("test did not release replay fetch")
            return real_fetch(current_store)

        def run_replay() -> None:
            try:
                self._rebase(store, base, local, base_head, winner)
            except BaseException as exc:  # noqa: BLE001 - thread handoff
                replay_errors.append(exc)

        def run_writer() -> None:
            try:
                self._append(store, "after-failed-replay")
            except BaseException as exc:  # noqa: BLE001 - thread handoff
                writer_errors.append(exc)
            finally:
                writer_done.set()

        with mock.patch.object(
            state_store,
            "_fetch_remote_branch_tip",
            side_effect=pause_after_staging,
        ), mock.patch(
            "aria_kernel.contention_replay.replay_append_only_suffixes",
            side_effect=StateStoreError("injected replay failure"),
        ):
            replay_thread = threading.Thread(target=run_replay, daemon=True)
            replay_thread.start()
            self.assertTrue(staged.wait(timeout=10))
            writer_thread = threading.Thread(target=run_writer, daemon=True)
            writer_thread.start()
            time.sleep(0.25)
            blocked = not writer_done.is_set()
            release.set()
            replay_thread.join(timeout=15)
            writer_thread.join(timeout=15)

        self.assertTrue(blocked)
        self.assertEqual(writer_errors, [])
        self.assertEqual(len(replay_errors), 1)
        self.assertIsInstance(replay_errors[0], StateStoreError)
        self.assertEqual(
            self._cycle_ids(store),
            ["shared-1", "lane-b-only", "after-failed-replay"],
        )

    def test_recovery_manifest_is_durable_before_reset_and_retained_on_failure(
        self,
    ) -> None:
        store, base, local, base_head, winner = self._rebase_inputs()
        recovery_root = self._recovery_root(store)
        real_fsync = os.fsync
        real_run_git = state_store._run_git
        fsynced: set[tuple[int, int]] = set()
        reset_observations: list[dict[str, object]] = []

        def record_fsync(descriptor):
            opened = os.fstat(descriptor)
            fsynced.add((opened.st_dev, opened.st_ino))
            return real_fsync(descriptor)

        def record_reset(cwd, args):
            if cwd == store.root and args[0] == "reset":
                transactions = sorted(
                    path
                    for path in recovery_root.glob("*/*")
                    if path.is_dir()
                )
                observation: dict[str, object] = {
                    "transaction_count": len(transactions),
                    "durable": False,
                }
                if len(transactions) == 1:
                    transaction = transactions[0]
                    manifest_path = transaction / "manifest.json"
                    blobs = sorted(transaction.glob("surface-*.bin"))
                    candidates = [
                        transaction.parent,
                        transaction,
                        manifest_path,
                        *blobs,
                    ]
                    observation["durable"] = bool(blobs) and all(
                        path.exists()
                        and (path.stat().st_dev, path.stat().st_ino) in fsynced
                        for path in candidates
                    )
                    if manifest_path.exists():
                        observation["manifest"] = json.loads(
                            manifest_path.read_text(encoding="utf-8")
                        )
                reset_observations.append(observation)
            return real_run_git(cwd, args)

        with mock.patch.object(
            state_store.os,
            "fsync",
            side_effect=record_fsync,
        ), mock.patch.object(
            state_store,
            "_run_git",
            side_effect=record_reset,
        ), mock.patch(
            "aria_kernel.contention_replay.replay_append_only_suffixes",
            side_effect=StateStoreError("injected replay failure"),
        ), self.assertRaises(StateStoreError):
            self._rebase(store, base, local, base_head, winner)

        self.assertEqual(len(reset_observations), 1)
        self.assertEqual(reset_observations[0]["transaction_count"], 1)
        self.assertIs(reset_observations[0]["durable"], True)
        manifest = reset_observations[0]["manifest"]
        self.assertEqual(
            {
                "$schema": manifest["$schema"],
                "schema_version": manifest["schema_version"],
                "branch": manifest["branch"],
                "repo_hash": manifest["repo_hash"],
                "base_commit": manifest["base_commit"],
                "winner_commit": manifest["winner_commit"],
                "loser_commit": manifest["loser_commit"],
                "resolution": manifest["resolution"],
                "phase": manifest["phase"],
            },
            {
                "$schema": "aria/state-recovery/v1",
                "schema_version": 1,
                "branch": store.branch,
                "repo_hash": REPO_HASH,
                "base_commit": base_head,
                "winner_commit": winner,
                "loser_commit": None,
                "resolution": "replay_suffix",
                "phase": "destructive_started",
            },
        )
        self.assertRegex(manifest["store_id"], r"^[0-9a-f]{64}$")
        self.assertEqual(
            manifest["repo_identity"],
            state_store._repository_identity(store.repo_root),
        )
        self.assertTrue(manifest["surfaces"])
        required_surface_fields = {
            "ordinal",
            "surface_key",
            "root_kind",
            "path",
            "blob",
            "size_bytes",
            "sha256",
            "row_count",
            "tail_ledger_hash",
        }
        for surface in manifest["surfaces"]:
            self.assertEqual(set(surface), required_surface_fields)
            self.assertFalse(Path(surface["path"]).is_absolute())
            self.assertEqual(
                surface["blob"],
                f"surface-{surface['ordinal']:04d}.bin",
            )

        retained = sorted(
            path for path in recovery_root.glob("*/*") if path.is_dir()
        )
        self.assertEqual(len(retained), 1)
        retained_manifest = json.loads(
            (retained[0] / "manifest.json").read_text(encoding="utf-8")
        )
        self.assertEqual(retained_manifest["phase"], "restored_after_failure")
        self.assertEqual(stat.S_IMODE(recovery_root.stat().st_mode), 0o700)
        self.assertEqual(stat.S_IMODE(retained[0].stat().st_mode), 0o700)
        self.assertEqual(
            stat.S_IMODE((retained[0] / "manifest.json").stat().st_mode),
            0o600,
        )

    def test_success_removes_only_the_recovery_transaction(self) -> None:
        store, base, local, base_head, winner = self._rebase_inputs()
        recovery_root = self._recovery_root(store)

        replayed = self._rebase(store, base, local, base_head, winner)

        self.assertEqual(replayed["cycles"], 1)
        self.assertTrue(recovery_root.is_dir())
        self.assertEqual(stat.S_IMODE(recovery_root.stat().st_mode), 0o700)
        self.assertEqual(
            [path for path in recovery_root.glob("*/*") if path.is_dir()],
            [],
        )

    def test_cleanup_crash_at_rename_unlink_or_rmdir_never_rediscover_active(
        self,
    ) -> None:
        """A partial delete is a tombstone, never a broken active package."""
        operations = ("rename", "unlink", "rmdir")

        for operation in operations:
            with self.subTest(operation=operation):
                store = self._store(
                    self.repo_a,
                    f"store-cleanup-crash-{operation}",
                )
                package = state_store._create_recovery_package(
                    store,
                    blob_names=("surface-0000.bin",),
                )
                (package.path / "manifest.json").write_bytes(b"{}\n")
                (package.path / "surface-0000.bin").write_bytes(b"preserved\n")
                for entry in package.path.iterdir():
                    entry.chmod(0o600)
                real_operation = getattr(os, operation)
                crashed = False

                def crash_after_effect(*args, **kwargs):
                    nonlocal crashed
                    result = real_operation(*args, **kwargs)
                    if not crashed:
                        crashed = True
                        raise RuntimeError(f"injected crash after {operation}")
                    return result

                with mock.patch.object(
                    os,
                    operation,
                    side_effect=crash_after_effect,
                ), self.assertRaisesRegex(RuntimeError, f"after {operation}"):
                    state_store._remove_recovery_package(package)

                self.assertIsNone(
                    state_store._discover_recovery_package_path(store),
                )
                self.assertEqual(list(package.path.parent.iterdir()), [])
                replacement = state_store._create_recovery_package(
                    store,
                    blob_names=(),
                )
                (replacement.path / "manifest.json").write_bytes(b"{}\n")
                (replacement.path / "manifest.json").chmod(0o600)
                state_store._remove_recovery_package(replacement)

    def test_discovery_refuses_a_hostile_tombstone_entry(self) -> None:
        store = self._store(self.repo_a, "store-hostile-tombstone")
        package = state_store._create_recovery_package(
            store,
            blob_names=("surface-0000.bin",),
        )
        manifest = package.path / "manifest.json"
        manifest.write_bytes(b"{}\n")
        manifest.chmod(0o600)
        surface = package.path / "surface-0000.bin"
        surface.write_bytes(b"preserved\n")
        surface.chmod(0o600)
        tombstone = package.path.with_name(
            state_store._RECOVERY_TOMBSTONE_PREFIX + package.path.name,
        )
        package.path.rename(tombstone)
        external = self.base / "hostile-tombstone-target.json"
        external.write_bytes(b"must remain unchanged\n")
        manifest = tombstone / "manifest.json"
        manifest.unlink()
        manifest.symlink_to(external)

        with self.assertRaisesRegex(
            StatePublishOutcomeUnknown,
            "recovery tombstone entry is not a private regular file",
        ):
            state_store._discover_recovery_package_path(store)

        self.assertEqual(external.read_bytes(), b"must remain unchanged\n")
        self.assertTrue(tombstone.is_dir())
        self.assertTrue(manifest.is_symlink())

    def test_public_entrypoints_discover_recovery_before_tree_or_snapshot_use(
        self,
    ) -> None:
        store = self._store(self.repo_a, "store-a")
        entrypoints = {
            "rebase": lambda: state_store.rebase_store_onto_remote(
                store,
                base=None,
                local={},
                repo_hash=REPO_HASH,
            ),
            "publish": lambda: state_store.publish_state(
                store,
                snapshot={},
                cycle_id="must-not-publish",
                repo_hash=REPO_HASH,
            ),
            "snapshot": lambda: state_store.build_publishable_snapshot(
                store,
                snapshot_id="must-not-build",
                cycle_id="must-not-build",
                lane="test",
                repo_hash=REPO_HASH,
                previous={},
            ),
            "publish-with-replay": lambda: state_store.publish_with_contention_replay(
                store,
                snapshot_id="must-not-build",
                cycle_id="must-not-publish",
                lane="test",
                repo_hash=REPO_HASH,
                max_attempts=1,
            ),
        }

        for name, invoke in entrypoints.items():
            with self.subTest(entrypoint=name):
                events: list[str] = []

                def refuse_recovery(*_args, **_kwargs):
                    events.append("recovery")
                    raise StateStoreRefusal(
                        "state_recovery_retry_required: injected pending package"
                    )

                def premature_tree_use(*_args, **_kwargs):
                    events.append("tree")
                    raise AssertionError("tree used before recovery discovery")

                with mock.patch.object(
                    state_store,
                    "recover_pending_state_replay",
                    side_effect=refuse_recovery,
                ) as recover, mock.patch.object(
                    state_store,
                    "_read_commit_ref",
                    side_effect=premature_tree_use,
                ), mock.patch.object(
                    state_store,
                    "validate_snapshot_manifest",
                    side_effect=premature_tree_use,
                ), mock.patch.object(
                    state_store,
                    "build_snapshot",
                    side_effect=premature_tree_use,
                ):
                    with self.assertRaisesRegex(
                        StateStoreRefusal,
                        "state_recovery_retry_required",
                    ):
                        invoke()

                recover.assert_called_once_with(store, repo_hash=REPO_HASH)
                self.assertEqual(events, ["recovery"])

    def test_public_entrypoints_stop_after_tree_changing_recovery(self) -> None:
        store, base, local, base_head, winner = self._rebase_inputs()
        with mock.patch(
            "aria_kernel.contention_replay.replay_append_only_suffixes",
            side_effect=StateStoreError("injected retained replay failure"),
        ), self.assertRaises(StateStoreError):
            self._rebase(store, base, local, base_head, winner)
        transaction, manifest = self._single_recovery_package(store)
        original_cycles = (tools_root(store) / "cycles.jsonl").read_bytes()

        entrypoints = {
            "rebase": lambda fresh: state_store.rebase_store_onto_remote(
                fresh,
                base=base,
                local=local,
                repo_hash=REPO_HASH,
                expected_winner=winner,
                expected_base=base_head,
            ),
            "publish": lambda fresh: state_store.publish_state(
                fresh,
                snapshot=local,
                cycle_id="must-not-publish",
                repo_hash=REPO_HASH,
                expected_base_head=base_head,
            ),
            "snapshot": lambda fresh: state_store.build_publishable_snapshot(
                fresh,
                snapshot_id="must-not-build",
                cycle_id="must-not-build",
                lane="test",
                repo_hash=REPO_HASH,
                previous=base,
            ),
        }

        for name, invoke in entrypoints.items():
            with self.subTest(entrypoint=name):
                manifest = self._rewrite_recovery_phase(
                    transaction,
                    manifest,
                    "destructive_started",
                )
                _git(store.root, "reset", "--hard", winner)
                self.assertNotEqual(
                    (tools_root(store) / "cycles.jsonl").read_bytes(),
                    original_cycles,
                )

                with mock.patch.object(
                    state_store,
                    "_rebase_store_onto_remote_locked",
                    wraps=state_store._rebase_store_onto_remote_locked,
                ) as locked_rebase, mock.patch.object(
                    state_store,
                    "_git_commit",
                    wraps=state_store._git_commit,
                ) as commit, mock.patch.object(
                    state_store,
                    "build_snapshot",
                    wraps=state_store.build_snapshot,
                ) as build:
                    with self.assertRaisesRegex(
                        StateStoreRefusal,
                        "state_recovery_retry_required",
                    ):
                        invoke(self._fresh_store(store))

                self.assertEqual(
                    (tools_root(store) / "cycles.jsonl").read_bytes(),
                    original_cycles,
                )
                if name == "rebase":
                    self.assertEqual(locked_rebase.call_count, 0)
                elif name == "publish":
                    self.assertEqual(commit.call_count, 0)
                else:
                    self.assertNotIn(
                        "must-not-build",
                        [
                            call.kwargs.get("snapshot_id")
                            for call in build.call_args_list
                        ],
                    )

    def test_fresh_store_cleans_prepared_recovery_package(self) -> None:
        store, _base_head, _winner, transaction, manifest = (
            self._retained_failed_recovery()
        )
        self._rewrite_recovery_phase(transaction, manifest, "prepared")

        result = state_store.recover_pending_state_replay(
            self._fresh_store(store),
            repo_hash=REPO_HASH,
        )

        self.assertEqual(result["status"], "prepared_cleaned")
        self.assertFalse(transaction.exists())

    @unittest.skipUnless(os.name == "posix", "SIGKILL continuity requires fork")
    def test_manifest_temp_crash_boundaries_preserve_the_prior_phase(self) -> None:
        boundaries = ("after_create", "after_fsync", "before_replace")

        for boundary in boundaries:
            with self.subTest(boundary=boundary):
                store = self._store(
                    self.repo_a,
                    f"store-manifest-temp-{boundary}",
                )
                head = _git(store.root, "rev-parse", "HEAD").strip()
                package = state_store._create_recovery_package(
                    store,
                    blob_names=(),
                )
                manifest = state_store._new_recovery_manifest(
                    store,
                    package=package,
                    repo_hash=REPO_HASH,
                    base_commit=head,
                    winner_commit=head,
                    loser_commit=None,
                    surfaces=[],
                )
                manifest = state_store._set_recovery_phase(
                    package,
                    manifest,
                    "prepared",
                )
                update = dict(manifest, phase="destructive_started")

                def crash_writer() -> None:
                    if boundary == "after_create":
                        with mock.patch.object(
                            state_store,
                            "_write_all",
                            side_effect=lambda *_args, **_kwargs: os._exit(71),
                        ):
                            state_store._write_recovery_manifest(package, update)
                    elif boundary == "after_fsync":
                        real_fsync = os.fsync

                        def crash_after_fsync(descriptor: int) -> None:
                            real_fsync(descriptor)
                            os._exit(72)

                        with mock.patch.object(
                            state_store.os,
                            "fsync",
                            side_effect=crash_after_fsync,
                        ):
                            state_store._write_recovery_manifest(package, update)
                    else:
                        with mock.patch.object(
                            state_store.os,
                            "replace",
                            side_effect=lambda *_args, **_kwargs: os._exit(73),
                        ):
                            state_store._write_recovery_manifest(package, update)
                    os._exit(74)

                child = multiprocessing.get_context("fork").Process(
                    target=crash_writer,
                )
                child.start()
                child.join(timeout=10)
                self.assertFalse(child.is_alive())
                self.assertIn(child.exitcode, {71, 72, 73})
                self.assertEqual(
                    json.loads(
                        (package.path / "manifest.json").read_text(
                            encoding="utf-8",
                        ),
                    )["phase"],
                    "prepared",
                )
                temps = sorted(package.path.glob(".manifest.json.*.tmp"))
                self.assertEqual(len(temps), 1)

                result = state_store.recover_pending_state_replay(
                    self._fresh_store(store),
                    repo_hash=REPO_HASH,
                )

                self.assertEqual(result["status"], "prepared_cleaned")
                self.assertFalse(package.path.exists())

    def test_manifest_temp_cleanup_refuses_hostile_entries_without_following(
        self,
    ) -> None:
        store = self._store(self.repo_a, "store-hostile-manifest-temps")
        head = _git(store.root, "rev-parse", "HEAD").strip()
        package = state_store._create_recovery_package(store, blob_names=())
        manifest = state_store._new_recovery_manifest(
            store,
            package=package,
            repo_hash=REPO_HASH,
            base_commit=head,
            winner_commit=head,
            loser_commit=None,
            surfaces=[],
        )
        state_store._set_recovery_phase(package, manifest, "prepared")
        external = self.base / "manifest-temp-external.bin"
        external.write_bytes(b"external-target-must-not-change\n")
        external_before = external.read_bytes()
        exact_name = ".manifest.json." + "a" * 32 + ".tmp"

        def clear_hostiles() -> None:
            for entry in package.path.iterdir():
                if entry.name == "manifest.json":
                    continue
                if entry.is_dir() and not entry.is_symlink():
                    entry.rmdir()
                else:
                    entry.unlink()

        cases = ("symlink", "mode", "type", "size", "name", "excess")
        for case in cases:
            with self.subTest(case=case):
                clear_hostiles()
                if case == "symlink":
                    (package.path / exact_name).symlink_to(external)
                elif case == "mode":
                    candidate = package.path / exact_name
                    candidate.write_bytes(b"partial")
                    candidate.chmod(0o644)
                elif case == "type":
                    (package.path / exact_name).mkdir(mode=0o700)
                elif case == "size":
                    candidate = package.path / exact_name
                    with candidate.open("wb") as handle:
                        handle.truncate(
                            state_store._MAX_RECOVERY_MANIFEST_BYTES + 1,
                        )
                    candidate.chmod(0o600)
                elif case == "name":
                    candidate = package.path / ".manifest.json.not-hex.tmp"
                    candidate.write_bytes(b"partial")
                    candidate.chmod(0o600)
                else:
                    for index in range(
                        state_store._MAX_RECOVERY_MANIFEST_TEMPS + 1,
                    ):
                        candidate = package.path / (
                            f".manifest.json.{index:032x}.tmp"
                        )
                        candidate.write_bytes(b"partial")
                        candidate.chmod(0o600)

                with self.assertRaisesRegex(
                    StateStoreError,
                    "state_recovery_manifest_temp_",
                ):
                    state_store.recover_pending_state_replay(
                        self._fresh_store(store),
                        repo_hash=REPO_HASH,
                    )
                self.assertEqual(external.read_bytes(), external_before)
                self.assertTrue(package.path.exists())

        clear_hostiles()
        state_store._remove_recovery_package(package)

    def test_manifest_temp_cleanup_refuses_non_private_package_before_unlink(
        self,
    ) -> None:
        store = self._store(self.repo_a, "store-public-manifest-temp")
        head = _git(store.root, "rev-parse", "HEAD").strip()
        package = state_store._create_recovery_package(store, blob_names=())
        manifest = state_store._new_recovery_manifest(
            store,
            package=package,
            repo_hash=REPO_HASH,
            base_commit=head,
            winner_commit=head,
            loser_commit=None,
            surfaces=[],
        )
        state_store._set_recovery_phase(package, manifest, "prepared")
        stranded = package.path / (".manifest.json." + "b" * 32 + ".tmp")
        stranded.write_bytes(b"partial")
        stranded.chmod(0o600)
        package.path.chmod(0o755)

        try:
            with self.assertRaisesRegex(
                StateStoreError,
                "state_recovery_package_not_private_directory",
            ):
                state_store.recover_pending_state_replay(
                    self._fresh_store(store),
                    repo_hash=None,
                )
            self.assertTrue(stranded.exists())
            self.assertEqual(stranded.read_bytes(), b"partial")
        finally:
            package.path.chmod(0o700)
            stranded.unlink(missing_ok=True)
            state_store._remove_recovery_package(package)

    def test_manifest_temp_cleanup_validates_all_candidates_before_unlink(
        self,
    ) -> None:
        store = self._store(self.repo_a, "store-mixed-manifest-temps")
        head = _git(store.root, "rev-parse", "HEAD").strip()
        package = state_store._create_recovery_package(store, blob_names=())
        manifest = state_store._new_recovery_manifest(
            store,
            package=package,
            repo_hash=REPO_HASH,
            base_commit=head,
            winner_commit=head,
            loser_commit=None,
            surfaces=[],
        )
        state_store._set_recovery_phase(package, manifest, "prepared")
        valid = package.path / (".manifest.json." + "a" * 32 + ".tmp")
        invalid = package.path / (".manifest.json." + "b" * 32 + ".tmp")
        valid.write_bytes(b"valid-stranded-temp")
        valid.chmod(0o600)
        invalid.write_bytes(b"hostile-mode")
        invalid.chmod(0o644)

        try:
            with self.assertRaisesRegex(
                StateStoreError,
                "state_recovery_manifest_temp_mode_invalid",
            ):
                state_store.recover_pending_state_replay(
                    self._fresh_store(store),
                    repo_hash=None,
                )
            self.assertTrue(valid.exists())
            self.assertEqual(valid.read_bytes(), b"valid-stranded-temp")
            self.assertTrue(invalid.exists())
        finally:
            valid.unlink(missing_ok=True)
            invalid.unlink(missing_ok=True)
            state_store._remove_recovery_package(package)

    def test_fresh_store_cleans_every_pre_destructive_staging_crash(
        self,
    ) -> None:
        store, _base_head, _winner, transaction, manifest = (
            self._retained_failed_recovery()
        )
        manifest = self._rewrite_recovery_phase(transaction, manifest, "staging")
        manifest_bytes = (state_store.canonical_json(manifest) + "\n").encode()
        blob_names = [str(surface["blob"]) for surface in manifest["surfaces"]]
        blob_payloads = {
            name: (transaction / name).read_bytes()
            for name in blob_names
        }
        head_before = _git(store.root, "rev-parse", "HEAD").strip()
        cycles = tools_root(store) / "cycles.jsonl"
        cycles_before = cycles.read_bytes()
        resets: list[tuple[str, ...]] = []
        real_run_git = state_store._run_git

        def restore_package(entries: dict[str, bytes]) -> None:
            transaction.mkdir(mode=0o700, exist_ok=True)
            transaction.chmod(0o700)
            for entry in transaction.iterdir():
                entry.unlink()
            manifest_path = transaction / "manifest.json"
            manifest_path.write_bytes(manifest_bytes)
            manifest_path.chmod(0o600)
            for name, payload in entries.items():
                path = transaction / name
                path.write_bytes(payload)
                path.chmod(0o600)

        def record_reset(cwd, args):
            if cwd == store.root and args[0] == "reset":
                resets.append(args)
            return real_run_git(cwd, args)

        cases: list[tuple[str, dict[str, bytes]]] = [("before-first-copy", {})]
        for ordinal, name in enumerate(blob_names):
            entries = {
                earlier: blob_payloads[earlier]
                for earlier in blob_names[:ordinal]
            }
            payload = blob_payloads[name]
            entries[name] = payload[: max(1, len(payload) // 2)]
            cases.append((f"during-{name}", entries))
        cases.append(("fully-staged-before-barrier", dict(blob_payloads)))

        for crash_point, entries in cases:
            with self.subTest(crash_point=crash_point):
                restore_package(entries)
                with mock.patch.object(
                    state_store,
                    "_run_git",
                    side_effect=record_reset,
                ):
                    result = state_store.recover_pending_state_replay(
                        self._fresh_store(store),
                        repo_hash=REPO_HASH,
                    )
                self.assertEqual(result["status"], "staging_cleaned")
                self.assertFalse(transaction.exists())
                self.assertEqual(
                    _git(store.root, "rev-parse", "HEAD").strip(),
                    head_before,
                )
                self.assertEqual(cycles.read_bytes(), cycles_before)

        self.assertEqual(resets, [])

    def test_staging_cleanup_retains_untrusted_or_corrupt_packages(self) -> None:
        store, _base_head, _winner, transaction, manifest = (
            self._retained_failed_recovery()
        )
        manifest = self._rewrite_recovery_phase(transaction, manifest, "staging")
        valid_manifest = (state_store.canonical_json(manifest) + "\n").encode()
        blob_names = [str(surface["blob"]) for surface in manifest["surfaces"]]
        blob_payloads = {
            name: (transaction / name).read_bytes()
            for name in blob_names
        }
        external = self.base / "staging-external.bin"
        external.write_bytes(blob_payloads[blob_names[0]])

        def restore_valid_package() -> None:
            transaction.mkdir(mode=0o700, exist_ok=True)
            transaction.chmod(0o700)
            for entry in transaction.iterdir():
                entry.unlink()
            manifest_path = transaction / "manifest.json"
            manifest_path.write_bytes(valid_manifest)
            manifest_path.chmod(0o600)
            for name, payload in blob_payloads.items():
                path = transaction / name
                path.write_bytes(payload)
                path.chmod(0o600)

        cases = (
            "corrupt-manifest",
            "foreign-manifest",
            "unexpected-entry",
            "symlink-blob",
            "full-size-hash-mismatch",
        )
        for case in cases:
            with self.subTest(case=case):
                restore_valid_package()
                manifest_path = transaction / "manifest.json"
                first_blob = transaction / blob_names[0]
                if case == "corrupt-manifest":
                    manifest_path.write_bytes(b"{not-json\n")
                elif case == "foreign-manifest":
                    foreign = dict(manifest)
                    foreign["repo_hash"] = "foreign-repository"
                    manifest_path.write_bytes(
                        (state_store.canonical_json(foreign) + "\n").encode()
                    )
                elif case == "unexpected-entry":
                    unexpected = transaction / "unexpected.bin"
                    unexpected.write_bytes(b"unexpected")
                    unexpected.chmod(0o600)
                elif case == "symlink-blob":
                    first_blob.unlink()
                    first_blob.symlink_to(external)
                else:
                    payload = bytearray(first_blob.read_bytes())
                    payload[0] ^= 1
                    first_blob.write_bytes(payload)

                with self.assertRaisesRegex(StateStoreError, "state_recovery_"):
                    state_store.recover_pending_state_replay(
                        self._fresh_store(store),
                        repo_hash=REPO_HASH,
                    )
                self.assertTrue(transaction.exists())

    def test_fresh_store_restores_destructive_started_then_requires_retry(
        self,
    ) -> None:
        store, _base_head, winner, transaction, manifest = (
            self._retained_failed_recovery()
        )
        original_cycles = (tools_root(store) / "cycles.jsonl").read_bytes()
        self._rewrite_recovery_phase(transaction, manifest, "destructive_started")
        _git(store.root, "reset", "--hard", winner)
        self.assertNotEqual(
            (tools_root(store) / "cycles.jsonl").read_bytes(),
            original_cycles,
        )

        with self.assertRaisesRegex(
            StateStoreRefusal,
            "state_recovery_retry_required",
        ):
            state_store.recover_pending_state_replay(
                self._fresh_store(store),
                repo_hash=REPO_HASH,
            )

        self.assertEqual(
            (tools_root(store) / "cycles.jsonl").read_bytes(),
            original_cycles,
        )
        self.assertTrue(transaction.exists())
        recovered = json.loads(
            (transaction / "manifest.json").read_text(encoding="utf-8")
        )
        self.assertEqual(recovered["phase"], "restored_after_failure")

    def test_fresh_store_cleans_verified_recovery_after_crash(self) -> None:
        store, base, local, base_head, winner = self._rebase_inputs()
        with mock.patch.object(
            state_store,
            "_remove_recovery_package",
            side_effect=StatePublishOutcomeUnknown("injected crash before cleanup"),
        ), self.assertRaises(StatePublishOutcomeUnknown):
            self._rebase(store, base, local, base_head, winner)
        transaction, manifest = self._single_recovery_package(store)
        self.assertEqual(manifest["phase"], "verified")

        result = state_store.recover_pending_state_replay(
            self._fresh_store(store),
            repo_hash=REPO_HASH,
        )

        self.assertEqual(result["status"], "verified_cleaned")
        self.assertFalse(transaction.exists())
        self.assertEqual(
            self._cycle_ids(store),
            ["shared-1", "lane-a-only", "lane-b-only"],
        )

    def test_fresh_store_never_restores_old_blob_over_accepted_loser(self) -> None:
        store, base, local, base_head, loser_head, winner = (
            self._accepted_loser_descendant_inputs()
        )
        with mock.patch.object(
            state_store,
            "_remove_recovery_package",
            side_effect=StatePublishOutcomeUnknown("injected crash before cleanup"),
        ), self.assertRaises(StatePublishOutcomeUnknown):
            state_store.rebase_store_onto_remote(
                store,
                base=base,
                local=local,
                repo_hash=REPO_HASH,
                expected_winner=loser_head,
                expected_loser=loser_head,
                expected_base=base_head,
            )
        transaction, manifest = self._single_recovery_package(store)
        self._rewrite_recovery_phase(transaction, manifest, "accepted_loser")

        with mock.patch.object(
            state_store,
            "_restore_preserved_replay_surfaces",
            wraps=state_store._restore_preserved_replay_surfaces,
        ) as restore:
            result = state_store.recover_pending_state_replay(
                self._fresh_store(store),
                repo_hash=REPO_HASH,
            )

        self.assertEqual(result["status"], "accepted_loser_cleaned")
        self.assertEqual(restore.call_count, 0)
        self.assertFalse(transaction.exists())
        self.assertEqual(_git(store.root, "rev-parse", "HEAD").strip(), winner)
        self.assertEqual(
            self._cycle_ids(store),
            ["shared-1", "lane-b-only", "later-verified-row"],
        )

    def test_recovery_discovery_rejects_invalid_manifests_and_retains_bytes(
        self,
    ) -> None:
        store, _base_head, _winner, transaction, manifest = (
            self._retained_failed_recovery()
        )
        manifest_path = transaction / "manifest.json"
        original_manifest = manifest_path.read_bytes()
        original_blobs = {
            path.name: path.read_bytes()
            for path in transaction.glob("surface-*.bin")
        }
        external = self.base / "external-recovery-manifest.json"
        external.write_bytes(original_manifest)

        def restore_manifest() -> None:
            if manifest_path.is_symlink() or manifest_path.exists():
                manifest_path.unlink()
            manifest_path.write_bytes(original_manifest)
            manifest_path.chmod(0o600)

        cases = ("corrupt", "foreign", "oversize", "symlink", "multiple")
        for case in cases:
            with self.subTest(case=case):
                restore_manifest()
                second: Path | None = None
                if case == "corrupt":
                    manifest_path.write_bytes(b"{not-json\n")
                elif case == "foreign":
                    foreign = dict(manifest)
                    foreign["repo_hash"] = "foreign-repository"
                    manifest_path.write_text(
                        state_store.canonical_json(foreign) + "\n",
                        encoding="utf-8",
                    )
                elif case == "oversize":
                    manifest_path.write_bytes(
                        b"x" * (state_store._MAX_RECOVERY_MANIFEST_BYTES + 1)
                    )
                elif case == "symlink":
                    manifest_path.unlink()
                    manifest_path.symlink_to(external)
                else:
                    second = transaction.parent / "second-transaction"
                    second.mkdir(mode=0o700)
                    (second / "manifest.json").write_bytes(original_manifest)
                    for name, payload in original_blobs.items():
                        (second / name).write_bytes(payload)

                try:
                    with self.assertRaisesRegex(
                        StateStoreError,
                        "state_recovery_",
                    ):
                        state_store.recover_pending_state_replay(
                            self._fresh_store(store),
                            repo_hash=REPO_HASH,
                        )
                    self.assertTrue(transaction.exists())
                    self.assertEqual(
                        {
                            path.name: path.read_bytes()
                            for path in transaction.glob("surface-*.bin")
                        },
                        original_blobs,
                    )
                finally:
                    if second is not None:
                        for path in second.iterdir():
                            path.unlink()
                        second.rmdir()
        restore_manifest()

    def test_recovery_manifest_surfaces_require_exact_declared_owners(
        self,
    ) -> None:
        store, _base_head, _winner, transaction, manifest = (
            self._retained_failed_recovery()
        )
        original = json.loads(json.dumps(manifest))
        package = state_store._RecoveryPackage(
            path=transaction,
            store_id=str(manifest["store_id"]),
            blob_names=tuple(
                str(surface["blob"])
                for surface in manifest["surfaces"]
            ),
        )
        index_ordinal = next(
            ordinal
            for ordinal, surface in enumerate(manifest["surfaces"])
            if surface["row_count"] is None
        )

        def mutate(case: str) -> dict[str, object]:
            changed = json.loads(json.dumps(original))
            surfaces = changed["surfaces"]
            first = surfaces[0]
            if case == "undeclared-path":
                first["path"] = "undeclared/recovery.jsonl"
            elif case == "duplicate-root-path":
                second = surfaces[1]
                second["surface_key"] = first["surface_key"]
                second["root_kind"] = first["root_kind"]
                second["path"] = first["path"]
            elif case == "fixed-glob-key-mismatch":
                first["surface_key"] = f"worker_dispatch:{first['path']}"
            elif case == "ledger-class-mismatch":
                first["row_count"] = None
                first["tail_ledger_hash"] = None
            elif case == "ledger-tail-mismatch":
                first["row_count"] = 0
                first["tail_ledger_hash"] = "sha256:" + ("f" * 64)
            else:
                surfaces[index_ordinal]["row_count"] = 0
            return changed

        cases = (
            "undeclared-path",
            "duplicate-root-path",
            "fixed-glob-key-mismatch",
            "ledger-class-mismatch",
            "ledger-tail-mismatch",
            "index-class-mismatch",
        )
        for case in cases:
            with self.subTest(case=case):
                state_store._write_recovery_manifest(package, mutate(case))
                with mock.patch.object(
                    state_store,
                    "state_transaction",
                    side_effect=AssertionError(
                        "surface admission must precede lock acquisition"
                    ),
                ) as state_txn, mock.patch.object(
                    state_store,
                    "_restore_preserved_replay_surfaces",
                    side_effect=AssertionError(
                        "unowned surface must never reach restore"
                    ),
                ) as restore, self.assertRaisesRegex(
                    StateStoreError,
                    "state_recovery_manifest_surface_admission_invalid",
                ):
                    state_store.recover_pending_state_replay(
                        self._fresh_store(store),
                        repo_hash=REPO_HASH,
                    )
                state_txn.assert_not_called()
                restore.assert_not_called()
                self.assertTrue(transaction.exists())

        state_store._write_recovery_manifest(package, original)

    def test_replay_head_move_after_target_verification_never_resets_or_replays(
        self,
    ) -> None:
        store, base, local, base_head, winner = self._rebase_inputs()
        source = tools_root(store) / "cycles.jsonl"
        source_bytes = source.read_bytes()
        resets: list[tuple[str, ...]] = []
        moved = False
        real_run_git = state_store._run_git
        real_advance_tracking = state_store._advance_tracking_ref_cas

        def move_head_after_tracking(*args, **kwargs):
            nonlocal moved
            result = real_advance_tracking(*args, **kwargs)
            if not moved:
                _git(store.root, "update-ref", "HEAD", winner, base_head)
                moved = True
            return result

        def record_reset(cwd, args):
            if cwd == store.root and args[:2] == ("reset", "--hard"):
                resets.append(args)
            return real_run_git(cwd, args)

        with mock.patch.object(
            state_store,
            "_advance_tracking_ref_cas",
            side_effect=move_head_after_tracking,
        ), mock.patch.object(
            state_store,
            "_run_git",
            side_effect=record_reset,
        ), mock.patch(
            "aria_kernel.contention_replay.replay_append_only_suffixes",
            side_effect=AssertionError("HEAD race must not reach replay"),
        ) as replay, self.assertRaisesRegex(
            StateStoreRefusal,
            "replay_base_head_moved",
        ):
            self._rebase(store, base, local, base_head, winner)

        self.assertTrue(moved)
        self.assertEqual(resets, [])
        replay.assert_not_called()
        self.assertEqual(source.read_bytes(), source_bytes)
        transaction, manifest = self._single_recovery_package(store)
        self.assertTrue(transaction.exists())
        self.assertEqual(manifest["phase"], "failed_before_reset")

    def test_replay_refuses_verified_tip_unrelated_to_exact_base_before_reset(
        self,
    ) -> None:
        store, base, local, base_head, winner = (
            self._unrelated_zero_ledger_rebase_inputs()
        )
        tracking = f"refs/remotes/{store.remote}/{store.branch}"
        self.assertEqual(_git(store.root, "rev-parse", tracking).strip(), winner)
        resets: list[tuple[str, ...]] = []
        real_run_git = state_store._run_git

        def record_reset(cwd, args):
            if cwd == store.root and args[:2] == ("reset", "--hard"):
                resets.append(args)
            return real_run_git(cwd, args)

        with mock.patch.object(
            state_store,
            "_run_git",
            side_effect=record_reset,
        ), mock.patch(
            "aria_kernel.contention_replay.replay_append_only_suffixes",
            side_effect=AssertionError("unrelated replay base must not reach replay"),
        ) as replay, self.assertRaisesRegex(
            StateStoreRefusal,
            "replay_target_not_descendant_of_base",
        ):
            state_store.rebase_store_onto_remote(
                store,
                base=base,
                local=local,
                repo_hash=REPO_HASH,
                expected_base=base_head,
            )

        self.assertEqual(resets, [])
        replay.assert_not_called()
        self.assertEqual(_git(store.root, "rev-parse", "HEAD").strip(), base_head)
        self.assertEqual(
            self._single_recovery_package(store)[1]["phase"],
            "failed_before_reset",
        )

    def test_replay_ancestry_unavailable_fails_closed_before_reset(self) -> None:
        store, base, local, base_head, _winner = (
            self._unrelated_zero_ledger_rebase_inputs()
        )
        resets: list[tuple[str, ...]] = []
        real_run_git = state_store._run_git

        def record_reset(cwd, args):
            if cwd == store.root and args[:2] == ("reset", "--hard"):
                resets.append(args)
            return real_run_git(cwd, args)

        with mock.patch.object(
            state_store,
            "_strict_is_ancestor",
            side_effect=StatePublishOutcomeUnknown("injected ancestry outage"),
        ), mock.patch.object(
            state_store,
            "_run_git",
            side_effect=record_reset,
        ), mock.patch(
            "aria_kernel.contention_replay.replay_append_only_suffixes",
            side_effect=AssertionError("unproved ancestry must not reach replay"),
        ) as replay, self.assertRaisesRegex(
            StatePublishOutcomeUnknown,
            "replay_target_ancestry_unavailable",
        ):
            state_store.rebase_store_onto_remote(
                store,
                base=base,
                local=local,
                repo_hash=REPO_HASH,
                expected_base=base_head,
            )

        self.assertEqual(resets, [])
        replay.assert_not_called()
        self.assertEqual(_git(store.root, "rev-parse", "HEAD").strip(), base_head)
        self.assertEqual(
            self._single_recovery_package(store)[1]["phase"],
            "failed_before_reset",
        )

    def test_replay_refuses_symlink_source_before_destructive_reset(self) -> None:
        store, base, local, base_head, winner = self._rebase_inputs()
        source = tools_root(store) / "cycles.jsonl"
        external = self.base / "external-cycles.jsonl"
        external.write_bytes(source.read_bytes())
        source.unlink()
        source.symlink_to(external)
        resets: list[tuple[str, ...]] = []
        real_run_git = state_store._run_git

        def record_reset(cwd, args):
            if cwd == store.root and args[0] == "reset":
                resets.append(args)
            return real_run_git(cwd, args)

        with mock.patch.object(
            state_store,
            "_run_git",
            side_effect=record_reset,
        ), self.assertRaisesRegex(StateStoreError, "replay_source_not_regular"):
            self._rebase(store, base, local, base_head, winner)

        self.assertEqual(resets, [])

    def test_replay_refuses_fifo_source_before_destructive_reset(self) -> None:
        store, base, local, base_head, winner = self._rebase_inputs()
        source = tools_root(store) / "cycles.jsonl"
        payload = source.read_bytes()
        source.unlink()
        os.mkfifo(source, 0o600)
        resets: list[tuple[str, ...]] = []
        real_run_git = state_store._run_git

        def feed_fifo() -> None:
            for _attempt in range(100):
                try:
                    descriptor = os.open(source, os.O_WRONLY | os.O_NONBLOCK)
                except OSError as exc:
                    if exc.errno != errno.ENXIO:
                        return
                    time.sleep(0.01)
                    continue
                try:
                    os.write(descriptor, payload)
                finally:
                    os.close(descriptor)
                return

        def record_reset(cwd, args):
            if cwd == store.root and args[0] == "reset":
                resets.append(args)
            return real_run_git(cwd, args)

        feeder = threading.Thread(target=feed_fifo, daemon=True)
        feeder.start()
        try:
            with mock.patch.object(
                state_store,
                "_run_git",
                side_effect=record_reset,
            ), self.assertRaisesRegex(StateStoreError, "replay_source_not_regular"):
                self._rebase(store, base, local, base_head, winner)
        finally:
            feeder.join(timeout=2)

        self.assertEqual(resets, [])

    def test_replay_refuses_declared_oversize_before_destructive_reset(self) -> None:
        store, base, local, base_head, winner = self._rebase_inputs()
        source = tools_root(store) / "cycles.jsonl"
        resets: list[tuple[str, ...]] = []
        real_run_git = state_store._run_git

        def record_reset(cwd, args):
            if cwd == store.root and args[0] == "reset":
                resets.append(args)
            return real_run_git(cwd, args)

        with mock.patch.object(
            state_store,
            "_MAX_REFERENCED_SURFACE_BYTES",
            source.stat().st_size - 1,
        ), mock.patch.object(
            state_store,
            "_run_git",
            side_effect=record_reset,
        ), self.assertRaisesRegex(StateStoreError, "replay_source_too_large"):
            self._rebase(store, base, local, base_head, winner)

        self.assertEqual(resets, [])

    def test_replay_refuses_source_change_during_copy_before_reset(self) -> None:
        store, base, local, base_head, winner = self._rebase_inputs()
        source = tools_root(store) / "cycles.jsonl"
        original = source.read_bytes()
        source_identity = (source.stat().st_dev, source.stat().st_ino)
        real_os_read = os.read
        resets: list[tuple[str, ...]] = []
        real_run_git = state_store._run_git
        changed = False

        def change_after_source_read(descriptor, size):
            nonlocal changed
            chunk = real_os_read(descriptor, size)
            opened = os.fstat(descriptor)
            if (
                chunk
                and not changed
                and (opened.st_dev, opened.st_ino) == source_identity
            ):
                changed = True
                source.write_bytes(original + b" ")
            return chunk

        def record_reset(cwd, args):
            if cwd == store.root and args[0] == "reset":
                resets.append(args)
            return real_run_git(cwd, args)

        with mock.patch(
            "aria_kernel.state_snapshot.os.read",
            side_effect=change_after_source_read,
        ), mock.patch.object(
            state_store,
            "_run_git",
            side_effect=record_reset,
        ), self.assertRaisesRegex(StateStoreError, "replay_source_changed"):
            self._rebase(store, base, local, base_head, winner)

        self.assertTrue(changed)
        self.assertEqual(resets, [])

    def test_replay_refuses_source_size_mismatch_before_reset(self) -> None:
        store, base, local, base_head, winner = self._rebase_inputs()
        source = tools_root(store) / "cycles.jsonl"
        source.write_bytes(source.read_bytes() + b" ")
        resets: list[tuple[str, ...]] = []
        real_run_git = state_store._run_git

        def record_reset(cwd, args):
            if cwd == store.root and args[0] == "reset":
                resets.append(args)
            return real_run_git(cwd, args)

        with mock.patch.object(
            state_store,
            "_run_git",
            side_effect=record_reset,
        ), self.assertRaisesRegex(StateStoreError, "replay_source_size_mismatch"):
            self._rebase(store, base, local, base_head, winner)

        self.assertEqual(resets, [])

    def test_replay_refuses_source_hash_mismatch_before_reset(self) -> None:
        store, base, local, base_head, winner = self._rebase_inputs()
        source = tools_root(store) / "cycles.jsonl"
        original = source.read_bytes()
        mutated = original.replace(b"lane-b-only", b"lane-b-evil", 1)
        self.assertEqual(len(mutated), len(original))
        self.assertNotEqual(mutated, original)
        source.write_bytes(mutated)
        resets: list[tuple[str, ...]] = []
        real_run_git = state_store._run_git

        def record_reset(cwd, args):
            if cwd == store.root and args[0] == "reset":
                resets.append(args)
            return real_run_git(cwd, args)

        with mock.patch.object(
            state_store,
            "_run_git",
            side_effect=record_reset,
        ), self.assertRaisesRegex(StateStoreError, "replay_source_hash_mismatch"):
            self._rebase(store, base, local, base_head, winner)

        self.assertEqual(resets, [])

    def test_replay_staging_is_exclusive_nofollow_and_durable_before_reset(
        self,
    ) -> None:
        store, base, local, base_head, winner = self._rebase_inputs()
        real_open = os.open
        real_fsync = os.fsync
        real_run_git = state_store._run_git
        created: list[tuple[int, int, int]] = []
        staged_identities: set[tuple[int, int]] = set()
        staging_directory: list[tuple[int, int]] = []
        durability: list[tuple[str, tuple[int, int]]] = []

        def record_open(path, flags, mode=0o777, *, dir_fd=None):
            descriptor = real_open(path, flags, mode, dir_fd=dir_fd)
            opened = os.fstat(descriptor)
            identity = (opened.st_dev, opened.st_ino)
            name = Path(path).name
            if name.startswith("surface-") and flags & os.O_CREAT:
                created.append(
                    (flags, mode, stat.S_IMODE(opened.st_mode)),
                )
                staged_identities.add(identity)
            if (
                stat.S_ISDIR(opened.st_mode)
                and len(name) == 32
                and all(character in "0123456789abcdef" for character in name)
            ):
                staging_directory[:] = [identity]
            return descriptor

        def record_fsync(descriptor):
            opened = os.fstat(descriptor)
            identity = (opened.st_dev, opened.st_ino)
            if identity in staged_identities:
                durability.append(("file", identity))
            elif staging_directory == [identity]:
                durability.append(("directory", identity))
            return real_fsync(descriptor)

        def require_durability_before_reset(cwd, args):
            if cwd == store.root and args[0] == "reset":
                file_events = {
                    identity for kind, identity in durability if kind == "file"
                }
                self.assertEqual(file_events, staged_identities)
                directory_positions = [
                    index
                    for index, (kind, _identity) in enumerate(durability)
                    if kind == "directory"
                ]
                self.assertTrue(directory_positions)
                self.assertGreater(
                    directory_positions[-1],
                    max(
                        index
                        for index, (kind, _identity) in enumerate(durability)
                        if kind == "file"
                    ),
                )
            return real_run_git(cwd, args)

        with mock.patch(
            "aria_kernel.state_snapshot._require_nofollow_dirfd_support",
        ), mock.patch.object(
            state_store.os,
            "open",
            side_effect=record_open,
        ), mock.patch.object(
            state_store.os,
            "fsync",
            side_effect=record_fsync,
        ), mock.patch.object(
            state_store,
            "_run_git",
            side_effect=require_durability_before_reset,
        ):
            replayed = self._rebase(store, base, local, base_head, winner)

        self.assertEqual(replayed["cycles"], 1)
        self.assertTrue(created)
        for flags, requested_mode, observed_mode in created:
            self.assertTrue(flags & os.O_EXCL)
            self.assertTrue(flags & os.O_NOFOLLOW)
            self.assertEqual(requested_mode, 0o600)
            self.assertEqual(observed_mode, 0o600)

    def test_replay_refuses_validly_rechained_staging_drift_before_reset(
        self,
    ) -> None:
        store, base, local, base_head, winner = self._rebase_inputs()
        real_fetch = state_store._fetch_remote_branch_tip
        real_run_git = state_store._run_git
        resets: list[tuple[str, ...]] = []
        mutated: list[Path] = []

        def mutate_staging_then_fetch(current_store):
            recovery_root = self._recovery_root(store)
            candidates = [
                path
                for path in recovery_root.glob("*/*/surface-*.bin")
                if b"lane-b-only" in path.read_bytes()
            ]
            self.assertEqual(len(candidates), 1)
            staged = candidates[0]
            payloads: list[dict[str, object]] = []
            for row in read_jsonl(staged):
                payload = {
                    key: value
                    for key, value in row.items()
                    if key not in {"ledger_hash", "previous_ledger_hash"}
                }
                if payload.get("cycle_id") == "lane-b-only":
                    payload["event"] = "altered"
                payloads.append(payload)
            previous: str | None = None
            rechained: list[dict[str, object]] = []
            for payload in payloads:
                stored = {**payload, "previous_ledger_hash": previous}
                stored["ledger_hash"] = ledger_module._record_hash(stored, previous)
                previous = str(stored["ledger_hash"])
                rechained.append(stored)
            staged.write_text(
                "".join(
                    ledger_module.canonical_json(row) + "\n"
                    for row in rechained
                ),
                encoding="utf-8",
            )
            self.assertTrue(verify_jsonl(staged)["valid"])
            mutated.append(staged)
            return real_fetch(current_store)

        def record_reset(cwd, args):
            if cwd == store.root and args[0] == "reset":
                resets.append(args)
            return real_run_git(cwd, args)

        with mock.patch.object(
            state_store,
            "_fetch_remote_branch_tip",
            side_effect=mutate_staging_then_fetch,
        ), mock.patch.object(
            state_store,
            "_run_git",
            side_effect=record_reset,
        ), self.assertRaisesRegex(
            StateStoreError,
            "replay_staging_verification_failed",
        ):
            self._rebase(store, base, local, base_head, winner)

        self.assertEqual(len(mutated), 1)
        self.assertEqual(resets, [])

    def test_replay_materialization_budget_counts_both_sides_before_reset(self) -> None:
        store, base, local, base_head, winner = self._rebase_inputs()
        real_run_git = state_store._run_git
        resets: list[tuple[str, ...]] = []
        loser_size = int(local["surfaces"][SURFACE]["size_bytes"])

        def record_reset(cwd, args):
            if cwd == store.root and args[0] == "reset":
                resets.append(args)
            return real_run_git(cwd, args)

        with mock.patch.object(
            state_store,
            "_MAX_REPLAY_MATERIALIZATION_BYTES",
            loser_size * state_store._REPLAY_MATERIALIZATION_MULTIPLIER,
        ), mock.patch.object(
            state_store,
            "_run_git",
            side_effect=record_reset,
        ), self.assertRaisesRegex(
            StateStoreError,
            "replay_materialization_budget_exceeded",
        ):
            self._rebase(store, base, local, base_head, winner)

        self.assertEqual(resets, [])

    def test_staged_replay_summary_binds_instance_and_attested_digest(self) -> None:
        root = self.base / "staged-summary"
        root.mkdir()
        staged = root / "surface-0000.bin"
        august = "cost-attribution/2026-08.jsonl"
        september = "cost-attribution/2026-09.jsonl"
        payload = {"schema_version": 1, "event": "cost_observed"}
        envelope = ledger_module._make_replay_transport_row(
            payload,
            expected_surface="cost_attribution",
            surface_instance=august,
            producer_event_id=ledger_module._record_hash(payload, None),
            producer_previous_ledger_hash=None,
            replay_transaction_id="staged-summary-binding",
        )
        stored = {**envelope, "previous_ledger_hash": None}
        stored["ledger_hash"] = ledger_module._record_hash(stored, None)
        content = (ledger_module.canonical_json(stored) + "\n").encode("utf-8")
        staged.write_bytes(content)

        with self.assertRaisesRegex(
            ledger_module.LedgerIntegrityError,
            "replay_transport_surface_instance_mismatch",
        ):
            state_store._replay_payload_summary(
                root,
                staged.name,
                expected_surface="cost_attribution",
                expected_surface_instance=september,
                expected_size=len(content),
                expected_sha256=hashlib.sha256(content).hexdigest(),
                start_row=0,
            )

        with self.assertRaisesRegex(
            StateStoreError,
            "replay_staging_verification_failed",
        ):
            state_store._replay_payload_summary(
                root,
                staged.name,
                expected_surface="cost_attribution",
                expected_surface_instance=august,
                expected_size=len(content),
                expected_sha256="0" * 64,
                start_row=0,
            )

    def test_replay_failure_restores_exact_bytes_atomically_before_cleanup(
        self,
    ) -> None:
        store, base, local, base_head, winner = self._rebase_inputs()
        cycles = tools_root(store) / "cycles.jsonl"
        index = tools_root(store) / "integrity_index.json"
        original = {cycles: cycles.read_bytes(), index: index.read_bytes()}
        real_fsync = os.fsync
        real_replace = os.replace
        real_run_git = state_store._run_git
        events: list[str] = []

        def record_fsync(descriptor):
            kind = "directory" if stat.S_ISDIR(os.fstat(descriptor).st_mode) else "file"
            events.append(f"fsync_{kind}")
            return real_fsync(descriptor)

        def record_replace(source, destination, **kwargs):
            if kwargs:
                events.append("replace")
                self.assertIsNotNone(kwargs.get("src_dir_fd"))
                self.assertIsNotNone(kwargs.get("dst_dir_fd"))
            return real_replace(source, destination, **kwargs)

        def record_reset(cwd, args):
            if cwd == store.root and args[0] == "reset":
                events.append("reset")
            return real_run_git(cwd, args)

        with mock.patch.object(
            state_store.os,
            "fsync",
            side_effect=record_fsync,
        ), mock.patch.object(
            state_store.os,
            "replace",
            side_effect=record_replace,
        ), mock.patch.object(
            state_store,
            "_run_git",
            side_effect=record_reset,
        ), mock.patch(
            "aria_kernel.contention_replay.replay_append_only_suffixes",
            side_effect=StateStoreError("injected replay failure"),
        ), self.assertRaisesRegex(StateStoreError, "injected replay failure"):
            self._rebase(store, base, local, base_head, winner)

        self.assertEqual({path: path.read_bytes() for path in original}, original)
        verify_index_hashes(index, tools_index_group_ledgers(tools_root(store)))
        after_reset = events[events.index("reset") + 1 :]
        self.assertIn("replace", after_reset)
        first_replace = after_reset.index("replace")
        self.assertIn("fsync_file", after_reset[:first_replace])
        self.assertIn("fsync_directory", after_reset[first_replace + 1 :])

    def test_replay_restore_rejects_destination_symlink_and_retains_staging(
        self,
    ) -> None:
        store, base, local, base_head, winner = self._rebase_inputs()
        cycles = tools_root(store) / "cycles.jsonl"
        external = self.base / "restore-external.txt"
        external.write_text("must remain unchanged\n", encoding="utf-8")
        external_before = external.read_bytes()
        def replace_destination_with_symlink(
            *,
            surfaces,
            transaction=None,
            replay_transaction_id=None,
        ):
            cycles.unlink()
            cycles.symlink_to(external)
            raise StateStoreError("injected replay failure")

        with mock.patch(
            "aria_kernel.contention_replay.replay_append_only_suffixes",
            side_effect=replace_destination_with_symlink,
        ), self.assertRaisesRegex(
            StateStoreError,
            "recovery bytes remain at",
        ):
            self._rebase(store, base, local, base_head, winner)

        self.assertEqual(external.read_bytes(), external_before)
        recovery, manifest = self._single_recovery_package(store)
        self.assertEqual(manifest["phase"], "restore_failed")
        self._assert_complete_recovery_package(recovery, manifest)

    def test_replay_restore_rejects_corrupt_staging_and_retains_it(self) -> None:
        store, base, local, base_head, winner = self._rebase_inputs()
        recovery_root = self._recovery_root(store)

        def corrupt_staged_loser(
            *,
            surfaces,
            transaction=None,
            replay_transaction_id=None,
        ):
            staged = [
                path
                for path in recovery_root.glob("*/*/surface-*.bin")
                if b"lane-b-only" in path.read_bytes()
            ]
            self.assertEqual(len(staged), 1)
            staged[0].write_bytes(b"tampered recovery bytes\n")
            raise StateStoreError("injected replay failure")

        with mock.patch(
            "aria_kernel.contention_replay.replay_append_only_suffixes",
            side_effect=corrupt_staged_loser,
        ), self.assertRaisesRegex(
            StateStoreError,
            "recovery bytes remain at",
        ):
            self._rebase(store, base, local, base_head, winner)

        recovery, manifest = self._single_recovery_package(store)
        self.assertEqual(manifest["phase"], "restore_failed")
        self._assert_complete_recovery_package(recovery, manifest)
        self.assertEqual(
            list(store.root.rglob(".aria-replay-restore-*.tmp")),
            [],
        )

    def test_replay_incoherent_index_is_rejected_with_staging_retained(
        self,
    ) -> None:
        from aria_kernel.contention_replay import replay_append_only_suffixes

        store, base, local, base_head, winner = self._rebase_inputs()
        def replay_then_corrupt_index(
            *,
            surfaces,
            transaction=None,
            replay_transaction_id=None,
        ):
            result = replay_append_only_suffixes(
                surfaces=surfaces,
                transaction=transaction,
                replay_transaction_id=replay_transaction_id,
            )
            (tools_root(store) / "integrity_index.json").write_text(
                '{"ledger_hashes": {}, "schema_version": 2}\n',
                encoding="utf-8",
            )
            return result

        with mock.patch(
            "aria_kernel.contention_replay.replay_append_only_suffixes",
            side_effect=replay_then_corrupt_index,
        ), self.assertRaisesRegex(
            StateStoreError,
            "replay_verification_failed",
        ):
            self._rebase(store, base, local, base_head, winner)

        recovery, manifest = self._single_recovery_package(store)
        self.assertEqual(manifest["phase"], "restored_after_failure")
        self._assert_complete_recovery_package(recovery, manifest)

    def test_replay_noop_cannot_discard_loser_suffix(self) -> None:
        from aria_kernel.contention_replay import ReplayResult
        from aria_kernel.tool_registry import update_tools_index

        store, base, local, base_head, winner = self._rebase_inputs()
        def no_replay(
            *,
            surfaces,
            transaction=None,
            replay_transaction_id=None,
        ):
            update_tools_index(tools_root(store), transaction=transaction)
            return ReplayResult(replayed_rows=0, per_surface={})

        with mock.patch(
            "aria_kernel.contention_replay.replay_append_only_suffixes",
            side_effect=no_replay,
        ), self.assertRaisesRegex(
            StateStoreError,
            "replay_verification_failed",
        ):
            self._rebase(store, base, local, base_head, winner)

        recovery, manifest = self._single_recovery_package(store)
        self.assertEqual(manifest["phase"], "restored_after_failure")
        self._assert_complete_recovery_package(recovery, manifest)

    def test_identical_unmarked_loser_suffix_is_an_independent_append(
        self,
    ) -> None:
        store, base, local, base_head, winner = self._normal_zero_replay_inputs()

        replayed = self._rebase(store, base, local, base_head, winner)

        self.assertEqual(replayed[SURFACE], 1)
        self.assertEqual(
            self._cycle_ids(store),
            ["shared-1", "winner-only", "lane-b-only", "lane-b-only"],
        )
        self.assertEqual(self._cycle_ids(store).count("lane-b-only"), 2)

    def test_normal_zero_replay_rejects_base_boundary_suffix_with_later_rows(
        self,
    ) -> None:
        from aria_kernel.contention_replay import replay_append_only_suffixes

        store, base, local, base_head, winner = self._normal_zero_replay_inputs(
            winner_rows=[
                {
                    "schema_version": 2,
                    "cycle_id": "shared-1",
                    "event": "started",
                },
                {
                    "schema_version": 2,
                    "cycle_id": "lane-b-only",
                    "event": "started",
                },
                {
                    "schema_version": 2,
                    "cycle_id": "descendant-only",
                    "event": "started",
                },
            ],
        )

        def replay_every_surface_but_cycles(
            *,
            surfaces,
            transaction=None,
            replay_transaction_id=None,
        ):
            return replay_append_only_suffixes(
                surfaces={
                    name: spec
                    for name, spec in surfaces.items()
                    if name != SURFACE
                },
                transaction=transaction,
                replay_transaction_id=replay_transaction_id,
            )

        with mock.patch(
            "aria_kernel.contention_replay.replay_append_only_suffixes",
            side_effect=replay_every_surface_but_cycles,
        ), self.assertRaisesRegex(StateStoreError, "replay_verification_failed"):
            self._rebase(store, base, local, base_head, winner)

    def test_normal_zero_replay_rejects_rechained_base_prefix(self) -> None:
        from aria_kernel.contention_replay import replay_append_only_suffixes

        store, base, local, base_head, winner = self._normal_zero_replay_inputs(
            winner_rows=[
                {
                    "schema_version": 2,
                    "cycle_id": "mutated-shared-prefix",
                    "event": "started",
                },
                {
                    "schema_version": 2,
                    "cycle_id": "winner-only",
                    "event": "started",
                },
                {
                    "schema_version": 2,
                    "cycle_id": "lane-b-only",
                    "event": "started",
                },
            ],
        )

        def replay_every_surface_but_cycles(
            *,
            surfaces,
            transaction=None,
            replay_transaction_id=None,
        ):
            return replay_append_only_suffixes(
                surfaces={
                    name: spec
                    for name, spec in surfaces.items()
                    if name != SURFACE
                },
                transaction=transaction,
                replay_transaction_id=replay_transaction_id,
            )

        with mock.patch(
            "aria_kernel.contention_replay.replay_append_only_suffixes",
            side_effect=replay_every_surface_but_cycles,
        ), self.assertRaisesRegex(StateStoreError, "replay_verification_failed"):
            self._rebase(store, base, local, base_head, winner)

    def test_duplicate_unmarked_winner_payloads_do_not_erase_loser_event(
        self,
    ) -> None:
        store, base, local, base_head, winner = self._normal_zero_replay_inputs(
            winner_rows=[
                {
                    "schema_version": 2,
                    "cycle_id": cycle_id,
                    "event": "started",
                }
                for cycle_id in (
                    "shared-1",
                    "winner-only",
                    "lane-b-only",
                    "lane-b-only",
                )
            ],
        )

        replayed = self._rebase(store, base, local, base_head, winner)

        self.assertEqual(replayed[SURFACE], 1)
        self.assertEqual(
            self._cycle_ids(store),
            [
                "shared-1",
                "winner-only",
                "lane-b-only",
                "lane-b-only",
                "lane-b-only",
            ],
        )
        self.assertEqual(self._cycle_ids(store).count("lane-b-only"), 3)

    def test_normal_zero_replay_rejects_mutated_loser_suffix(self) -> None:
        from aria_kernel.contention_replay import replay_append_only_suffixes

        store, base, local, base_head, winner = self._normal_zero_replay_inputs(
            winner_rows=[
                {
                    "schema_version": 2,
                    "cycle_id": "shared-1",
                    "event": "started",
                },
                {
                    "schema_version": 2,
                    "cycle_id": "winner-only",
                    "event": "started",
                },
                {
                    "schema_version": 2,
                    "cycle_id": "lane-b-only",
                    "event": "mutated",
                },
            ],
        )

        def replay_every_surface_but_cycles(
            *,
            surfaces,
            transaction=None,
            replay_transaction_id=None,
        ):
            return replay_append_only_suffixes(
                surfaces={
                    name: spec
                    for name, spec in surfaces.items()
                    if name != SURFACE
                },
                transaction=transaction,
                replay_transaction_id=replay_transaction_id,
            )

        with mock.patch(
            "aria_kernel.contention_replay.replay_append_only_suffixes",
            side_effect=replay_every_surface_but_cycles,
        ), self.assertRaisesRegex(StateStoreError, "replay_verification_failed"):
            self._rebase(store, base, local, base_head, winner)

    def test_replay_rejects_validly_rechained_winner_prefix_mutation(self) -> None:
        from aria_kernel.contention_replay import replay_append_only_suffixes
        from aria_kernel.tool_registry import update_tools_index

        store, base, local, base_head, winner = self._rebase_inputs()
        cycles = tools_root(store) / "cycles.jsonl"
        def replay_then_rewrite_prefix(
            *,
            surfaces,
            transaction=None,
            replay_transaction_id=None,
        ):
            result = replay_append_only_suffixes(
                surfaces=surfaces,
                transaction=transaction,
                replay_transaction_id=replay_transaction_id,
            )
            rows = read_jsonl(cycles)
            rewritten: list[dict[str, object]] = []
            changed = False
            for row in rows:
                payload = {
                    key: value
                    for key, value in row.items()
                    if key not in {"ledger_hash", "previous_ledger_hash"}
                }
                if payload.get("cycle_id") == "lane-a-only":
                    payload["event"] = "tampered-winner-prefix"
                    changed = True
                rewritten.append(payload)
            self.assertTrue(changed)
            self.assertIsNotNone(transaction)
            transaction.rewrite_declared_jsonl(
                cycles,
                rewritten,
                expected_surface=SURFACE,
                migration_id="test-fixture-rewrite",
                bypass_profile_gate=True,
            )
            update_tools_index(tools_root(store), transaction=transaction)
            return result

        with mock.patch(
            "aria_kernel.contention_replay.replay_append_only_suffixes",
            side_effect=replay_then_rewrite_prefix,
        ), self.assertRaisesRegex(
            StateStoreError,
            "replay_verification_failed",
        ):
            self._rebase(store, base, local, base_head, winner)

        recovery, manifest = self._single_recovery_package(store)
        self.assertEqual(manifest["phase"], "restored_after_failure")
        self._assert_complete_recovery_package(recovery, manifest)

    def _accepted_loser_descendant_inputs(
        self,
        *,
        rechained_rows: list[dict[str, object]] | None = None,
        duplicate_loser_after_later: bool = False,
    ):
        store_a = self._store(self.repo_a, "store-a")
        self._append(store_a, "shared-1")
        self._publish(store_a, "snap-base", "cycle-base")

        store_b = self._store(self.repo_b, "store-b")
        base_head = _git(store_b.root, "rev-parse", "HEAD").strip()
        base = state_store.read_snapshot_at_worktree_head(
            store_b,
            expected_head=base_head,
        )
        self._append(store_b, "lane-b-only")
        local = state_store.build_publishable_snapshot(
            store_b,
            snapshot_id="snap-loser",
            cycle_id="cycle-loser",
            lane="test",
            repo_hash=REPO_HASH,
            previous=base,
        )
        state_store.publish_state(
            store_b,
            snapshot=local,
            cycle_id="cycle-loser",
            repo_hash=REPO_HASH,
            expected_base_head=base_head,
        )
        loser_head = _git(store_b.root, "rev-parse", "HEAD").strip()

        descendant = self._store(self.repo_a, "descendant-store")
        if rechained_rows is None:
            self._append(descendant, "later-verified-row")
            if duplicate_loser_after_later:
                self._append(descendant, "lane-b-only")
        else:
            descendant_tools = tools_root(descendant)
            descendant_tools.mkdir(parents=True, exist_ok=True)
            if not (descendant_tools / "repo_identity.json").exists():
                bind_tools_root(
                    tools_dir=descendant_tools,
                    workspace_root=descendant.repo_root,
                    reason="bind descendant rewrite fixture to its store",
                )
            rewrite_declared_fixture(
                descendant_tools / "cycles.jsonl",
                rechained_rows,
                expected_surface=SURFACE,
            )
        self._publish(descendant, "snap-descendant", "cycle-descendant")
        winner = _git(
            self.remote,
            "rev-parse",
            "refs/heads/aria/state",
        ).strip()

        # Recreate the recoverable post-push shape: HEAD at the exact base,
        # with the loser's complete tree still staged and present on disk.
        _git(store_b.root, "reset", "--soft", base_head)
        self.assertEqual(
            _git(store_b.root, "rev-parse", "HEAD").strip(),
            base_head,
        )
        self.assertEqual(
            _git(store_b.root, "write-tree").strip(),
            _git(store_b.root, "rev-parse", f"{loser_head}^{{tree}}").strip(),
        )
        return store_b, base, local, base_head, loser_head, winner

    def _accepted_loser_recovery_inputs(self):
        store, base, local, base_head, loser_head, winner = (
            self._accepted_loser_descendant_inputs()
        )
        tracking = f"refs/remotes/{store.remote}/{store.branch}"
        tracking_before = _git(store.root, "rev-parse", tracking).strip()
        with mock.patch.object(
            state_store,
            "_remove_recovery_package",
            side_effect=StatePublishOutcomeUnknown(
                "injected crash before accepted-loser cleanup"
            ),
        ), self.assertRaises(StatePublishOutcomeUnknown):
            state_store.rebase_store_onto_remote(
                store,
                base=base,
                local=local,
                repo_hash=REPO_HASH,
                expected_winner=loser_head,
                expected_loser=loser_head,
                expected_base=base_head,
            )
        transaction, manifest = self._single_recovery_package(store)
        return (
            store,
            base,
            local,
            base_head,
            loser_head,
            winner,
            tracking,
            tracking_before,
            transaction,
            manifest,
        )

    def test_accepted_loser_persists_every_adoption_boundary(self) -> None:
        store, base, local, base_head, loser_head, _winner = (
            self._accepted_loser_descendant_inputs()
        )
        with mock.patch.object(
            state_store,
            "_set_recovery_phase",
            wraps=state_store._set_recovery_phase,
        ) as set_phase:
            state_store.rebase_store_onto_remote(
                store,
                base=base,
                local=local,
                repo_hash=REPO_HASH,
                expected_winner=loser_head,
                expected_loser=loser_head,
                expected_base=base_head,
            )

        self.assertEqual(
            [call.args[2] for call in set_phase.call_args_list],
            [
                "prepared",
                "adopt_pending",
                "adopt_loser_complete",
                "adopt_remote_complete",
                "accepted_loser",
                "verified",
            ],
        )

    def test_recovery_resumes_after_the_loser_head_was_adopted(self) -> None:
        (
            store,
            _base,
            _local,
            _base_head,
            loser_head,
            winner,
            tracking,
            tracking_before,
            transaction,
            manifest,
        ) = self._accepted_loser_recovery_inputs()
        _git(store.root, "reset", "--hard", loser_head)
        loser_index = tools_root(store) / "integrity_index.json"
        if not state_store._git_succeeds(
            store.root,
            "cat-file",
            "-e",
            f"{loser_head}:tools/integrity_index.json",
        ):
            loser_index.unlink(missing_ok=True)
        _git(store.root, "update-ref", tracking, tracking_before)
        self._rewrite_recovery_phase(
            transaction,
            manifest,
            "adopt_loser_complete",
        )

        result = state_store.recover_pending_state_replay(
            self._fresh_store(store),
            repo_hash=REPO_HASH,
        )

        self.assertEqual(result["status"], "accepted_loser_cleaned")
        self.assertFalse(transaction.exists())
        self.assertEqual(_git(store.root, "rev-parse", "HEAD").strip(), winner)
        self.assertEqual(_git(store.root, "rev-parse", tracking).strip(), winner)

    def test_recovery_resumes_after_remote_fast_forward_before_tracking(
        self,
    ) -> None:
        (
            store,
            _base,
            _local,
            _base_head,
            _loser_head,
            winner,
            tracking,
            tracking_before,
            transaction,
            manifest,
        ) = self._accepted_loser_recovery_inputs()
        _git(store.root, "update-ref", tracking, tracking_before)
        self._rewrite_recovery_phase(
            transaction,
            manifest,
            "adopt_remote_complete",
        )

        result = state_store.recover_pending_state_replay(
            self._fresh_store(store),
            repo_hash=REPO_HASH,
        )

        self.assertEqual(result["status"], "accepted_loser_cleaned")
        self.assertFalse(transaction.exists())
        self.assertEqual(_git(store.root, "rev-parse", "HEAD").strip(), winner)
        self.assertEqual(_git(store.root, "rev-parse", tracking).strip(), winner)

    def test_recovery_reconciles_remote_advance_after_tracking_before_cleanup(
        self,
    ) -> None:
        (
            store,
            _base,
            _local,
            _base_head,
            _loser_head,
            _winner,
            tracking,
            _tracking_before,
            transaction,
            manifest,
        ) = self._accepted_loser_recovery_inputs()
        self._rewrite_recovery_phase(transaction, manifest, "accepted_loser")
        later = self._store(self.repo_a, "post-adoption-crash-store")
        self._append(later, "after-adoption-crash")
        self._publish(later, "snap-after-adoption", "cycle-after-adoption")
        remote_tip = _git(
            self.remote,
            "rev-parse",
            "refs/heads/aria/state",
        ).strip()

        result = state_store.recover_pending_state_replay(
            self._fresh_store(store),
            repo_hash=REPO_HASH,
        )

        self.assertEqual(result["status"], "accepted_loser_cleaned")
        self.assertFalse(transaction.exists())
        self.assertEqual(_git(store.root, "rev-parse", "HEAD").strip(), remote_tip)
        self.assertEqual(_git(store.root, "rev-parse", tracking).strip(), remote_tip)
        self.assertEqual(
            self._cycle_ids(store),
            [
                "shared-1",
                "lane-b-only",
                "later-verified-row",
                "after-adoption-crash",
            ],
        )

    def test_accepted_loser_suffix_at_base_boundary_allows_later_rows(self) -> None:
        store, base, local, base_head, loser_head, winner = (
            self._accepted_loser_descendant_inputs()
        )

        replayed = state_store.rebase_store_onto_remote(
            store,
            base=base,
            local=local,
            repo_hash=REPO_HASH,
            expected_winner=loser_head,
            expected_loser=loser_head,
            expected_base=base_head,
        )

        self.assertEqual(replayed, {})
        self.assertEqual(
            self._cycle_ids(store),
            ["shared-1", "lane-b-only", "later-verified-row"],
        )
        self.assertEqual(self._cycle_ids(store).count("lane-b-only"), 1)
        self.assertEqual(_git(store.root, "rev-parse", "HEAD").strip(), winner)

    def test_accepted_loser_streams_without_replay_materialization_budget(self) -> None:
        store, base, local, base_head, loser_head, winner = (
            self._accepted_loser_descendant_inputs()
        )

        with mock.patch.object(
            state_store,
            "_MAX_REPLAY_MATERIALIZATION_BYTES",
            1,
        ):
            replayed = state_store.rebase_store_onto_remote(
                store,
                base=base,
                local=local,
                repo_hash=REPO_HASH,
                expected_winner=loser_head,
                expected_loser=loser_head,
                expected_base=base_head,
            )

        self.assertEqual(replayed, {})
        self.assertEqual(_git(store.root, "rev-parse", "HEAD").strip(), winner)

    def test_accepted_loser_rejects_rechained_prefix_with_same_tail_payload(
        self,
    ) -> None:
        store, base, local, base_head, loser_head, _winner = (
            self._accepted_loser_descendant_inputs(
                rechained_rows=[
                    {
                        "schema_version": 2,
                        "cycle_id": "mutated-shared-prefix",
                        "event": "started",
                    },
                    {
                        "schema_version": 2,
                        "cycle_id": "lane-b-only",
                        "event": "started",
                    },
                ],
            )
        )

        with self.assertRaisesRegex(
            StateStoreError,
            "replay_verification_failed",
        ):
            state_store.rebase_store_onto_remote(
                store,
                base=base,
                local=local,
                repo_hash=REPO_HASH,
                expected_winner=loser_head,
                expected_loser=loser_head,
                expected_base=base_head,
            )

    def test_accepted_loser_rejects_a_second_copy_of_the_exact_suffix(self) -> None:
        store, base, local, base_head, loser_head, _winner = (
            self._accepted_loser_descendant_inputs(
                duplicate_loser_after_later=True,
            )
        )

        with self.assertRaisesRegex(StateStoreError, "replay_verification_failed"):
            state_store.rebase_store_onto_remote(
                store,
                base=base,
                local=local,
                repo_hash=REPO_HASH,
                expected_winner=loser_head,
                expected_loser=loser_head,
                expected_base=base_head,
            )

    def test_accepted_loser_rejects_mutated_suffix_payload(self) -> None:
        store, base, local, base_head, loser_head, _winner = (
            self._accepted_loser_descendant_inputs(
                rechained_rows=[
                    {
                        "schema_version": 2,
                        "cycle_id": "shared-1",
                        "event": "started",
                    },
                    {
                        "schema_version": 2,
                        "cycle_id": "lane-b-only",
                        "event": "mutated-after-publication",
                    },
                ],
            )
        )

        with self.assertRaisesRegex(StateStoreError, "replay_verification_failed"):
            state_store.rebase_store_onto_remote(
                store,
                base=base,
                local=local,
                repo_hash=REPO_HASH,
                expected_winner=loser_head,
                expected_loser=loser_head,
                expected_base=base_head,
            )

    def test_accepted_loser_rejects_deleted_suffix_payload(self) -> None:
        store, base, local, base_head, loser_head, _winner = (
            self._accepted_loser_descendant_inputs(
                rechained_rows=[{
                    "schema_version": 2,
                    "cycle_id": "shared-1",
                    "event": "started",
                }],
            )
        )

        with self.assertRaisesRegex(StateStoreError, "replay_verification_failed"):
            state_store.rebase_store_onto_remote(
                store,
                base=base,
                local=local,
                repo_hash=REPO_HASH,
                expected_winner=loser_head,
                expected_loser=loser_head,
                expected_base=base_head,
            )

    def test_replay_failure_restores_loser_rows_and_retains_recovery_package(
        self,
    ) -> None:
        store_a = self._store(self.repo_a, "store-a")
        self._append(store_a, "shared-1")
        self._publish(store_a, "snap-base", "cycle-base")
        store_b = self._store(self.repo_b, "store-b")
        self._append(store_a, "lane-a-only")
        self._append(store_b, "lane-b-only")
        self._publish(store_a, "snap-a", "cycle-a")
        with mock.patch(
            "aria_kernel.contention_replay.replay_append_only_suffixes",
            side_effect=StateStoreError("injected replay failure"),
        ), self.assertRaises(StateStoreError):
            self._publish(store_b, "snap-b", "cycle-b")

        self.assertEqual(self._cycle_ids(store_b), ["shared-1", "lane-b-only"])
        recovery, manifest = self._single_recovery_package(store_b)
        self.assertEqual(manifest["phase"], "restored_after_failure")
        self._assert_complete_recovery_package(recovery, manifest)

    def test_partial_multi_row_replay_restores_before_a_safe_retry(self) -> None:
        store_a = self._store(self.repo_a, "store-a")
        self._append(store_a, "shared-1")
        self._publish(store_a, "snap-base", "cycle-base")
        store_b = self._store(self.repo_b, "store-b")
        base_head = _git(store_b.root, "rev-parse", "HEAD").strip()
        base = state_store.read_snapshot_at_worktree_head(
            store_b,
            expected_head=base_head,
        )
        self._append(store_b, "lane-b-first")
        self._append(store_b, "lane-b-second")
        local = state_store.build_publishable_snapshot(
            store_b,
            snapshot_id="snap-b",
            cycle_id="cycle-b",
            lane="test",
            repo_hash=REPO_HASH,
            previous=base,
        )
        cycles = tools_root(store_b) / "cycles.jsonl"
        loser_bytes = cycles.read_bytes()
        self._append(store_a, "lane-a-only")
        self._publish(store_a, "snap-a", "cycle-a")
        winner = _git(
            self.remote,
            "rev-parse",
            "refs/heads/aria/state",
        ).strip()
        real_append = state_store.StateTransaction.append_declared_jsonl
        replay_appends = 0

        def crash_after_first_replayed_row(
            transaction,
            path,
            record,
            *,
            expected_surface,
            bypass_profile_gate=False,
        ):
            nonlocal replay_appends
            if record.get("$schema") == "aria/ledger-replay-transport/v2":
                replay_appends += 1
                if replay_appends == 2:
                    raise RuntimeError("injected crash after replay prefix")
            return real_append(
                transaction,
                path,
                record,
                expected_surface=expected_surface,
                bypass_profile_gate=bypass_profile_gate,
            )

        with mock.patch.object(
            state_store.StateTransaction,
            "append_declared_jsonl",
            new=crash_after_first_replayed_row,
        ), self.assertRaisesRegex(RuntimeError, "after replay prefix"):
            self._rebase(store_b, base, local, base_head, winner)

        self.assertEqual(replay_appends, 2)
        self.assertEqual(cycles.read_bytes(), loser_bytes)
        self.assertEqual(
            self._cycle_ids(store_b),
            ["shared-1", "lane-b-first", "lane-b-second"],
        )
        self.assertTrue(
            all(
                "_aria_contention_replay" not in row
                for row in read_jsonl(cycles)
            ),
        )
        self.assertEqual(_git(store_b.root, "rev-parse", "HEAD").strip(), base_head)
        recovery, manifest = self._single_recovery_package(store_b)
        self.assertEqual(manifest["phase"], "restored_after_failure")
        self._assert_complete_recovery_package(recovery, manifest)

        recovered = state_store.recover_pending_state_replay(
            self._fresh_store(store_b),
            repo_hash=REPO_HASH,
        )
        self.assertEqual(recovered["status"], "retry_ready")
        result = self._publish(store_b, "snap-b-retry", "cycle-b-retry")

        self.assertEqual(result["attempts"], 2)
        self.assertEqual(
            self._cycle_ids(store_b),
            ["shared-1", "lane-a-only", "lane-b-first", "lane-b-second"],
        )
        self.assertEqual(self._cycle_ids(store_b).count("lane-b-first"), 1)
        self.assertEqual(self._cycle_ids(store_b).count("lane-b-second"), 1)

    def test_replay_failure_restores_the_exact_base_head(self) -> None:
        store, base_head, _winner, _transaction, _manifest = (
            self._retained_failed_recovery()
        )

        self.assertEqual(
            _git(store.root, "rev-parse", "HEAD").strip(),
            base_head,
        )
        self.assertEqual(
            _git(store.root, "write-tree").strip(),
            _git(store.root, "rev-parse", f"{base_head}^{{tree}}").strip(),
        )
        self.assertEqual(self._cycle_ids(store), ["shared-1", "lane-b-only"])

    def test_retry_after_failed_replay_cannot_publish_over_the_winner(self) -> None:
        store, base, local, base_head, winner = self._rebase_inputs()
        with mock.patch(
            "aria_kernel.contention_replay.replay_append_only_suffixes",
            side_effect=StateStoreError("injected retained replay failure"),
        ), self.assertRaises(StateStoreError):
            self._rebase(store, base, local, base_head, winner)

        self.assertEqual(
            _git(store.root, "write-tree").strip(),
            _git(store.root, "rev-parse", f"{base_head}^{{tree}}").strip(),
        )

        with self.assertRaisesRegex(
            StateStoreRefusal,
            "state_publish_ancestry_unproven",
        ):
            state_store.publish_state(
                store,
                snapshot=local,
                cycle_id="stale-direct-publish",
                repo_hash=REPO_HASH,
                expected_base_head=base_head,
            )

        self.assertEqual(
            _git(store.root, "rev-parse", "HEAD").strip(),
            base_head,
        )
        result = self._publish(store, "snap-safe-retry", "cycle-safe-retry")

        self.assertEqual(result["attempts"], 2)
        self.assertEqual(
            self._cycle_ids(store),
            ["shared-1", "lane-a-only", "lane-b-only"],
        )
        self.assertEqual(self._cycle_ids(store).count("lane-a-only"), 1)
        self.assertEqual(self._cycle_ids(store).count("lane-b-only"), 1)

    def test_crash_recovery_restores_the_exact_base_head(self) -> None:
        store, base_head, winner, transaction, manifest = (
            self._retained_failed_recovery()
        )
        self._rewrite_recovery_phase(transaction, manifest, "destructive_started")
        _git(store.root, "reset", "--hard", winner)

        with self.assertRaisesRegex(
            StateStoreRefusal,
            "state_recovery_retry_required",
        ):
            state_store.recover_pending_state_replay(
                self._fresh_store(store),
                repo_hash=REPO_HASH,
            )

        self.assertEqual(
            _git(store.root, "rev-parse", "HEAD").strip(),
            base_head,
        )
        self.assertEqual(
            _git(store.root, "write-tree").strip(),
            _git(store.root, "rev-parse", f"{base_head}^{{tree}}").strip(),
        )
        self.assertEqual(self._cycle_ids(store), ["shared-1", "lane-b-only"])

    def test_checkout_recovers_a_crash_package_before_removing_the_store(
        self,
    ) -> None:
        store, base_head, winner, transaction, manifest = (
            self._retained_failed_recovery()
        )
        self._rewrite_recovery_phase(transaction, manifest, "reset_complete")
        _git(store.root, "reset", "--hard", winner)

        with mock.patch.object(
            state_store,
            "_clear_existing_store",
            wraps=state_store._clear_existing_store,
        ) as clear, mock.patch.object(
            state_store,
            "_attest_state_writer",
            wraps=state_store._attest_state_writer,
        ) as attest, self.assertRaisesRegex(
            StateStoreRefusal,
            "state_recovery_retry_required",
        ):
            checkout_state_store(
                store.repo_root,
                store_dir=store.root,
            )

        clear.assert_not_called()
        attest.assert_not_called()
        self.assertTrue(store.root.exists())
        self.assertTrue(transaction.exists())
        self.assertEqual(
            _git(store.root, "rev-parse", "HEAD").strip(),
            base_head,
        )
        self.assertEqual(self._cycle_ids(store), ["shared-1", "lane-b-only"])

    def test_recovery_head_cas_failure_requires_operator_and_retains_package(
        self,
    ) -> None:
        store, _base_head, winner, transaction, manifest = (
            self._retained_failed_recovery()
        )
        self._rewrite_recovery_phase(transaction, manifest, "destructive_started")
        _git(store.root, "reset", "--hard", winner)

        with mock.patch.object(
            state_store,
            "_move_owned_head_cas",
            side_effect=StatePublishOutcomeUnknown("injected HEAD CAS failure"),
        ), self.assertRaises(StateStoreError):
            state_store.recover_pending_state_replay(
                self._fresh_store(store),
                repo_hash=REPO_HASH,
            )

        retained = json.loads(
            (transaction / "manifest.json").read_text(encoding="utf-8")
        )
        self.assertEqual(retained["phase"], "restore_failed")
        with self.assertRaisesRegex(
            StateStoreError,
            "state_recovery_phase_requires_operator:restore_failed",
        ):
            state_store.recover_pending_state_replay(
                self._fresh_store(store),
                repo_hash=REPO_HASH,
            )
        self.assertTrue(transaction.exists())

    def test_exhausting_the_attempts_refuses_and_keeps_the_rows(self) -> None:
        """Losing every attempt must refuse, not report success, and not eat rows.

        The rejection is injected rather than raced. An earlier version of this
        test tried to make a second lane win repeatedly by publishing from
        inside the rebase hook, and its outcome depended on fetch ordering — it
        passed for the wrong reason as often as the right one. What is being
        claimed here is a property of the ORCHESTRATOR (it stops at
        `max_attempts` and re-raises), so the race belongs in the tests above
        that exercise a real rejected push, and the bound belongs here where it
        can be stated exactly.
        """
        store_a = self._store(self.repo_a, "store-a")
        self._append(store_a, "shared-1")
        self._publish(store_a, "snap-base", "cycle-base")
        self._append(store_a, "not-yet-published")

        attempts: list[int] = []
        original = state_store.publish_state
        winner = _git(self.remote, "rev-parse", "refs/heads/aria/state").strip()
        base_head = _git(store_a.root, "rev-parse", "HEAD").strip()
        loser = _git(
            store_a.root,
            "commit-tree",
            f"{base_head}^{{tree}}",
            "-p",
            base_head,
            "-m",
            "synthetic rejected publish",
        ).strip()

        def _always_rejected(store, **kwargs):
            attempts.append(1)
            raise state_store.StatePublishContention(
                winner,
                loser,
                base_head,
                "synthetic verified winner",
            )

        state_store.publish_state = _always_rejected
        self.addCleanup(setattr, state_store, "publish_state", original)

        with self.assertRaises(StateStoreRefusal) as caught:
            self._publish(store_a, "snap-x", "cycle-x", max_attempts=3)
        self.assertIn("contention_unresolved", str(caught.exception))
        self.assertEqual(len(attempts), 3)
        # The rows are still there: a refusal must not be a data loss event.
        self.assertIn("not-yet-published", self._cycle_ids(store_a))

    def test_a_non_race_refusal_is_not_retried(self) -> None:
        """Only a lost race is retryable.

        Retrying an ancestry refusal would just make the same true statement
        again, more slowly — and each retry resets the tree, so a bug that
        produced an unprovable snapshot would churn the store instead of
        stopping at it.
        """
        store_a = self._store(self.repo_a, "store-a")
        self._append(store_a, "shared-1")
        self._publish(store_a, "snap-base", "cycle-base")

        calls: list[int] = []
        original = state_store.publish_state

        def _always_unprovable(store, **kwargs):
            calls.append(1)
            raise StateStoreRefusal(
                "state_publish_push_rejected: untyped text is not contention"
            )

        state_store.publish_state = _always_unprovable
        self.addCleanup(setattr, state_store, "publish_state", original)

        with self.assertRaises(StateStoreRefusal) as caught:
            self._publish(store_a, "snap-x", "cycle-x", max_attempts=3)
        self.assertIn("untyped text", str(caught.exception))
        self.assertEqual(len(calls), 1, "a non-race refusal must not be retried")


if __name__ == "__main__":
    unittest.main()
