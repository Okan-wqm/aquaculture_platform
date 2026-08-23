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
import os
import stat
import subprocess
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest import mock

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
        temp_root = self.base / "invalid-late-acceptance-staging"
        temp_root.mkdir()
        with mock.patch.object(
            state_store,
            "_run_git",
            side_effect=capture_loser,
        ), mock.patch.object(
            state_store,
            "rebase_store_onto_remote",
            side_effect=accept_loser_before_replay,
        ), mock.patch.object(
            state_store.tempfile,
            "tempdir",
            str(temp_root),
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
        self.assertEqual(list(temp_root.iterdir()), [])

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
        temp_root = self.base / "replay-temp-success"
        temp_root.mkdir()

        with mock.patch.object(state_store.tempfile, "tempdir", str(temp_root)):
            self._publish(store_b, "snap-b", "cycle-b")

        self.assertEqual(list(temp_root.iterdir()), [])

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
            if stat.S_ISDIR(opened.st_mode) and name.startswith("aria-replay-"):
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
        temp_root = self.base / "replay-destination-symlink"
        temp_root.mkdir()

        def replace_destination_with_symlink(*, surfaces):
            cycles.unlink()
            cycles.symlink_to(external)
            raise StateStoreError("injected replay failure")

        with mock.patch.object(
            state_store.tempfile,
            "tempdir",
            str(temp_root),
        ), mock.patch(
            "aria_kernel.contention_replay.replay_append_only_suffixes",
            side_effect=replace_destination_with_symlink,
        ), self.assertRaisesRegex(
            StateStoreError,
            "recovery bytes remain at",
        ):
            self._rebase(store, base, local, base_head, winner)

        self.assertEqual(external.read_bytes(), external_before)
        staging = list(temp_root.iterdir())
        self.assertEqual(len(staging), 1)
        self.assertTrue(any(staging[0].iterdir()))

    def test_replay_restore_rejects_corrupt_staging_and_retains_it(self) -> None:
        store, base, local, base_head, winner = self._rebase_inputs()
        temp_root = self.base / "replay-corrupt-staging"
        temp_root.mkdir()

        def corrupt_staged_loser(*, surfaces):
            staged = [
                path
                for path in temp_root.glob("aria-replay-*/surface-*.bin")
                if b"lane-b-only" in path.read_bytes()
            ]
            self.assertEqual(len(staged), 1)
            staged[0].write_bytes(b"tampered recovery bytes\n")
            raise StateStoreError("injected replay failure")

        with mock.patch.object(
            state_store.tempfile,
            "tempdir",
            str(temp_root),
        ), mock.patch(
            "aria_kernel.contention_replay.replay_append_only_suffixes",
            side_effect=corrupt_staged_loser,
        ), self.assertRaisesRegex(
            StateStoreError,
            "recovery bytes remain at",
        ):
            self._rebase(store, base, local, base_head, winner)

        staging = list(temp_root.iterdir())
        self.assertEqual(len(staging), 1)
        self.assertTrue(any(staging[0].iterdir()))
        self.assertEqual(
            list(store.root.rglob(".aria-replay-restore-*.tmp")),
            [],
        )

    def test_replay_incoherent_index_is_rejected_with_staging_retained(
        self,
    ) -> None:
        from aria_kernel.contention_replay import replay_append_only_suffixes

        store, base, local, base_head, winner = self._rebase_inputs()
        temp_root = self.base / "replay-incoherent-index"
        temp_root.mkdir()

        def replay_then_corrupt_index(*, surfaces):
            result = replay_append_only_suffixes(surfaces=surfaces)
            (tools_root(store) / "integrity_index.json").write_text(
                '{"ledger_hashes": {}, "schema_version": 2}\n',
                encoding="utf-8",
            )
            return result

        with mock.patch.object(
            state_store.tempfile,
            "tempdir",
            str(temp_root),
        ), mock.patch(
            "aria_kernel.contention_replay.replay_append_only_suffixes",
            side_effect=replay_then_corrupt_index,
        ), self.assertRaisesRegex(
            StateStoreError,
            "replay_verification_failed",
        ):
            self._rebase(store, base, local, base_head, winner)

        staging = list(temp_root.iterdir())
        self.assertEqual(len(staging), 1)
        self.assertTrue(any(staging[0].iterdir()))

    def test_replay_noop_cannot_discard_loser_suffix(self) -> None:
        from aria_kernel.contention_replay import ReplayResult
        from aria_kernel.tool_registry import update_tools_index

        store, base, local, base_head, winner = self._rebase_inputs()
        temp_root = self.base / "replay-noop"
        temp_root.mkdir()

        def no_replay(*, surfaces):
            update_tools_index(tools_root(store))
            return ReplayResult(replayed_rows=0, per_surface={})

        with mock.patch.object(
            state_store.tempfile,
            "tempdir",
            str(temp_root),
        ), mock.patch(
            "aria_kernel.contention_replay.replay_append_only_suffixes",
            side_effect=no_replay,
        ), self.assertRaisesRegex(
            StateStoreError,
            "replay_verification_failed",
        ):
            self._rebase(store, base, local, base_head, winner)

        staging = list(temp_root.iterdir())
        self.assertEqual(len(staging), 1)
        self.assertTrue(any(staging[0].iterdir()))

    def test_replay_rejects_validly_rechained_winner_prefix_mutation(self) -> None:
        from aria_kernel.contention_replay import replay_append_only_suffixes
        from aria_kernel.tool_registry import update_tools_index

        store, base, local, base_head, winner = self._rebase_inputs()
        cycles = tools_root(store) / "cycles.jsonl"
        temp_root = self.base / "replay-prefix-mutation"
        temp_root.mkdir()

        def replay_then_rewrite_prefix(*, surfaces):
            result = replay_append_only_suffixes(surfaces=surfaces)
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
            rewrite_declared_fixture(
                cycles,
                rewritten,
                expected_surface=SURFACE,
            )
            update_tools_index(tools_root(store))
            return result

        with mock.patch.object(
            state_store.tempfile,
            "tempdir",
            str(temp_root),
        ), mock.patch(
            "aria_kernel.contention_replay.replay_append_only_suffixes",
            side_effect=replay_then_rewrite_prefix,
        ), self.assertRaisesRegex(
            StateStoreError,
            "replay_verification_failed",
        ):
            self._rebase(store, base, local, base_head, winner)

        staging = list(temp_root.iterdir())
        self.assertEqual(len(staging), 1)
        self.assertTrue(any(staging[0].iterdir()))

    def test_replay_failure_restores_loser_rows_and_cleans_temp_staging(
        self,
    ) -> None:
        store_a = self._store(self.repo_a, "store-a")
        self._append(store_a, "shared-1")
        self._publish(store_a, "snap-base", "cycle-base")
        store_b = self._store(self.repo_b, "store-b")
        self._append(store_a, "lane-a-only")
        self._append(store_b, "lane-b-only")
        self._publish(store_a, "snap-a", "cycle-a")
        temp_root = self.base / "replay-temp-failure"
        temp_root.mkdir()

        with mock.patch.object(
            state_store.tempfile,
            "tempdir",
            str(temp_root),
        ), mock.patch(
            "aria_kernel.contention_replay.replay_append_only_suffixes",
            side_effect=StateStoreError("injected replay failure"),
        ), self.assertRaises(StateStoreError):
            self._publish(store_b, "snap-b", "cycle-b")

        self.assertEqual(
            ([path.name for path in temp_root.iterdir()], self._cycle_ids(store_b)),
            ([], ["shared-1", "lane-b-only"]),
        )

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
