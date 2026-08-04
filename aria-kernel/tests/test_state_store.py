"""The ``aria/state`` store: bootstrap discipline and the ancestry proof.

These tests drive real git repositories rather than mocking the porcelain.
The behaviour under test IS git's fast-forward rule plus what this module
refuses to do around it, and a mocked ``git push`` that returns whatever
the test wants would be asserting the test's own opinion.
"""

from __future__ import annotations

import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path

from aria_kernel import state_store
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
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding="utf-8")
        return path

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
        with self.assertRaises(StateStoreRefusal) as ctx:
            publish_state(store, snapshot=follow_up, cycle_id="cycle-2", repo_hash=REPO_HASH)
        self.assertIn("state_publish_continuity_surfaces_lost", str(ctx.exception))

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
        surface_b.write_text('{"row": "published"}\n{"row": "ONLY-COPY"}\n', encoding="utf-8")
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

    def test_a_clean_store_is_replaced_without_complaint(self) -> None:
        store = self._bootstrap()
        self._seed_surface(store, '{"row": 1}\n')
        publish_state(store, snapshot=self._snapshot(store, "snap-1"), cycle_id="cycle-1", repo_hash=REPO_HASH)
        # Same path, second call: everything is committed, so nothing is lost.
        again = checkout_state_store(self.repo, store_dir=store.root)
        self.assertFalse(again.bootstrapped)
        self.assertEqual(read_published_snapshot(again)["snapshot_id"], "snap-1")

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
        (debts / "debt-events.jsonl").write_text('{"event": "opened"}\n', encoding="utf-8")

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
        extra.write_text('{"ok": true}\n', encoding="utf-8")
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

    def test_an_unbound_restored_root_is_refused_rather_than_guessed(self) -> None:
        from aria_kernel.tool_registry import GovernanceError, ensure_tools_dir

        fresh = self._published_then_fresh()
        with _EnvPatch(state_store.store_environment(fresh, REPO_HASH)):
            with self.assertRaises(GovernanceError) as caught:
                ensure_tools_dir()
        self.assertIn("ambiguous_tools_root", str(caught.exception))

    def test_the_restore_time_migration_makes_it_usable(self) -> None:
        """The step the restore action runs, asserted end to end."""
        from aria_kernel.migration import migrate_tools_bootstrap
        from aria_kernel.tool_registry import ensure_tools_dir

        fresh = self._published_then_fresh()
        with _EnvPatch(state_store.store_environment(fresh, REPO_HASH)):
            result = migrate_tools_bootstrap(
                tools_dir=str(tools_root(fresh)),
                workspace_root=str(self.repo),
                acknowledge=True,
                reason="bind the restored aria/state store to this checkout",
            )
            self.assertEqual(result["final_version"], 3)
            self.assertEqual(ensure_tools_dir(), tools_root(fresh))

    def test_the_migration_also_covers_a_genesis_store(self) -> None:
        """A newborn store has an EMPTY tools root, which takes the other
        branch of the migration chain. Both lanes hit this on the first run,
        so a fix that only worked on a populated root would fail exactly once
        — on the day it first mattered."""
        from aria_kernel.migration import migrate_tools_bootstrap
        from aria_kernel.tool_registry import ensure_tools_dir

        store = self._bootstrap()
        with _EnvPatch(state_store.store_environment(store, REPO_HASH)):
            result = migrate_tools_bootstrap(
                tools_dir=str(tools_root(store)),
                workspace_root=str(self.repo),
                acknowledge=True,
                reason="bind the restored aria/state store to this checkout",
            )
            self.assertEqual(result["final_version"], 3)
            self.assertEqual(ensure_tools_dir(), tools_root(store))


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
        surface.write_text('{"row": 1}\n{"row": 2}\n', encoding="utf-8")
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


if __name__ == "__main__":
    unittest.main()
