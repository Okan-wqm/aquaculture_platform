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

import subprocess
import tempfile
import unittest
from pathlib import Path

from aria_kernel import state_store
from aria_kernel.ledger import read_jsonl, verify_jsonl
from aria_kernel.state_store import (
    BOOTSTRAP_ACK_ENV,
    StateStoreRefusal,
    checkout_state_store,
    publish_with_contention_replay,
    tools_root,
)
from aria_kernel.migration import migrate_tools_bootstrap

from tests._helpers.declared_fixtures import append_declared_fixture

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
        published branch does not carry it. `migrate-tools-bootstrap` is the
        governed step that binds such a root — which is the same step PLAN §2.5
        wanted deleted, and a second reason it must stay.
        """
        root = tools_root(store)
        root.mkdir(parents=True, exist_ok=True)
        if not (root / "repo_identity.json").exists():
            migrate_tools_bootstrap(
                tools_dir=root,
                workspace_root=store.repo_root,
                acknowledge=True,
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

        def _always_rejected(store, **kwargs):
            attempts.append(1)
            raise StateStoreRefusal(
                "state_publish_push_rejected: another lane published first."
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
            raise StateStoreRefusal("state_publish_ancestry_unproven: synthetic")

        state_store.publish_state = _always_unprovable
        self.addCleanup(setattr, state_store, "publish_state", original)

        with self.assertRaises(StateStoreRefusal) as caught:
            self._publish(store_a, "snap-x", "cycle-x", max_attempts=3)
        self.assertIn("ancestry_unproven", str(caught.exception))
        self.assertEqual(len(calls), 1, "a non-race refusal must not be retried")


if __name__ == "__main__":
    unittest.main()
