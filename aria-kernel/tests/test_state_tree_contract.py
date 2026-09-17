"""A parent tip that carries what no snapshot can claim must not poison
every later publish — the publish heals it, and says so.

THE DEFECT, measured on ``origin/aria/state`` tip 84032eda1 (2026-09-11).
The maintenance lane committed with ``git add -A`` and admitted sixteen
zero-byte ``*.lock`` side-cars (``file_lock`` leaves them on disk by
design), ``repo_identity.json`` and ``integrity_index.json``. The kernel
publish stages a bounded pathspec, so it inherited them through the index,
the immutable verifier refused the child with
``state_snapshot_unclaimed_tree_entry:tools/cycles.jsonl.lock``, the commit
was soft-reset, and no kernel publish landed after 2026-09-04.

These tests drive real git repositories: the poison is planted exactly the
way the retired lane planted it (files on disk, whole-tree add, commit,
push), then the kernel is asked to publish on top of it.
"""
from __future__ import annotations

import gzip
import json
import unittest
from pathlib import PurePosixPath

from aria_kernel import state_store
from aria_kernel.file_lock import lock_sidecar_path
from aria_kernel.ledger_inline import INLINE_ROW_FIELD_MAX_BYTES
from aria_kernel.state_manifest import state_group_lock_relative_path
from aria_kernel.state_store import (
    StateStoreRefusal,
    prepare_publishable_snapshot,
    publish_state,
    tools_root,
    verify_state_store,
)
from aria_kernel.state_tree_contract import (
    INHERITED_ENTRIES_DROPPED_EVENT,
    MAX_RECORDED_DROPPED_ENTRIES,
    classify_state_tree_path,
)
from tests.test_state_store import REPO_HASH, StateStoreTestCase, _EnvPatch, _git

_ROOTS = {"tools": "tools", "workspace": "workspace/abc123", "repo": "findings"}


class TreeEntryClassificationTests(unittest.TestCase):
    """The one rule, judged path by path, with no store involved."""

    def test_contract_files_and_markers_are_contract(self) -> None:
        for path in ("GENESIS", "snapshot.json", "tools/.gitkeep", "findings/.gitkeep"):
            self.assertEqual(
                classify_state_tree_path(path, root_prefixes=_ROOTS).kind,
                "contract",
                path,
            )

    def test_declared_surfaces_under_every_root_are_surfaces(self) -> None:
        for path, name in (
            ("tools/runs.jsonl", "runs"),
            ("tools/archives/runs-compact-20260911T182938Z.jsonl.gz", "state_archives"),
            ("workspace/abc123/aria-memory/pressure.jsonl", None),
            ("findings/aria-findings/F-001.json", None),
        ):
            verdict = classify_state_tree_path(path, root_prefixes=_ROOTS)
            self.assertEqual(verdict.kind, "surface", path)
            if name is not None:
                self.assertEqual(verdict.surface_name, name)

    def test_a_lock_sidecar_is_recognised_through_the_file_lock_naming(self) -> None:
        # The reason is decoded from file_lock's own side-car shape, so the
        # side-car of ANY target — a ledger, the tools index — is named by
        # its target rather than by a second ".lock" literal here.
        for target in ("runs.jsonl", "integrity_index.json", "memory/beliefs.jsonl"):
            sidecar = lock_sidecar_path(PurePosixPath(target)).as_posix()
            verdict = classify_state_tree_path(f"tools/{sidecar}", root_prefixes=_ROOTS)
            self.assertEqual(verdict.kind, "unclaimable", sidecar)
            self.assertEqual(verdict.reason, f"lock_sidecar:{target}")

    def test_a_state_group_lock_is_named_by_its_group_not_as_a_sidecar_of_nothing(self) -> None:
        """The group-lock KEY (`locks/state-groups/<group>.lock`) is itself
        side-car-shaped: decoded as a side-car it would name a target —
        `locks/state-groups/runtime` — that nothing ever creates. The key
        is recognised through the manifest's own shape FIRST; the side-car
        file_lock actually leaves beside it (`<group>.lock.lock`, sixteen of
        which the 2026-09-11 tip carried) is named by the group it
        serialises. Both shapes derive from the one declaration; neither is
        spelled here."""
        for group in ("runtime", "governance", "memory"):
            key = state_group_lock_relative_path(group)
            verdict = classify_state_tree_path(f"tools/{key.as_posix()}", root_prefixes=_ROOTS)
            self.assertEqual(verdict.kind, "unclaimable", key)
            self.assertEqual(verdict.reason, f"state_group_lock:{group}")

            sidecar = lock_sidecar_path(key)
            verdict = classify_state_tree_path(f"tools/{sidecar.as_posix()}", root_prefixes=_ROOTS)
            self.assertEqual(verdict.kind, "unclaimable", sidecar)
            self.assertEqual(verdict.reason, f"state_group_lock_sidecar:{group}")
        # A name under the group-lock directory that is no declared group is
        # not a group lock: it falls through to the generic decode and is
        # named honestly as the side-car of whatever it spells.
        stray = classify_state_tree_path(
            "tools/locks/state-groups/not-a-group.lock",
            root_prefixes=_ROOTS,
        )
        self.assertEqual(stray.reason, "lock_sidecar:locks/state-groups/not-a-group")

    def test_the_host_lease_is_an_excluded_surface_not_a_sidecar(self) -> None:
        # `locks/autonomous-host.lock` is a DECLARED lock-class surface whose
        # storage policy excludes it from every snapshot; it must be judged
        # by the manifest first, never mistaken for the side-car of a
        # `locks/autonomous-host` target.
        verdict = classify_state_tree_path(
            "tools/locks/autonomous-host.lock",
            root_prefixes=_ROOTS,
        )
        self.assertEqual(verdict.kind, "unclaimable")
        self.assertEqual(verdict.reason, "excluded_surface:autonomous_host_local_lease")

    def test_host_local_files_and_foreign_roots_are_unclaimable(self) -> None:
        self.assertEqual(
            classify_state_tree_path("tools/repo_identity.json", root_prefixes=_ROOTS).reason,
            "undeclared",
        )
        self.assertEqual(
            classify_state_tree_path("tools/integrity_index.json", root_prefixes=_ROOTS).reason,
            "undeclared",
        )
        self.assertEqual(
            classify_state_tree_path(
                "workspace/otherrepo/aria-memory/pressure.jsonl",
                root_prefixes=_ROOTS,
            ).reason,
            "outside_declared_roots",
        )


class InheritedEntriesAreHealed(StateStoreTestCase):
    def _bound_store(self):
        """A bootstrapped store whose tools root is bound, as the restore
        action leaves it — the governance row a healing publish appends
        needs a bound root, exactly as every lane has one."""
        from aria_kernel.tools_binding import bind_tools_root

        store = self._bootstrap()
        with _EnvPatch(state_store.store_environment(store, REPO_HASH)):
            bind_tools_root(
                tools_dir=str(tools_root(store)),
                workspace_root=str(self.repo),
                reason="bind the restored aria/state store to this checkout",
            )
        return store

    def _prepare(self, store, snapshot_id: str, cycle_id: str):
        return prepare_publishable_snapshot(
            store,
            snapshot_id=snapshot_id,
            cycle_id=cycle_id,
            lane="test",
            repo_hash=REPO_HASH,
        )

    def _publish(self, store, snapshot_id: str, cycle_id: str) -> dict:
        prepared = self._prepare(store, snapshot_id, cycle_id)
        result = publish_state(
            store,
            snapshot=prepared.snapshot,
            cycle_id=cycle_id,
            repo_hash=REPO_HASH,
            expected_base_head=prepared.base_head,
        )
        result["prepared"] = prepared
        return result

    def _poison_the_tip_like_the_retired_lane(self, store, *paths: str) -> str:
        """Commit and push whatever is on disk, whole tree, stale snapshot.json.

        This is byte-for-byte the shape aria-state-maintenance.yml produced
        until it was routed through the kernel: `git add -A` after the
        side-cars and the host identity had been written.
        """
        for path in paths:
            target = store.root / path
            target.parent.mkdir(parents=True, exist_ok=True)
            if not target.exists():
                target.write_bytes(b"")
        _git(store.root, "add", "-A")
        _git(
            store.root,
            "-c", "user.name=aria-state-maintenance",
            "-c", "user.email=aria-state-maintenance@users.noreply.github.com",
            "-c", "commit.gpgsign=false",
            "commit", "-m", "chore(state): automated compaction",
        )
        _git(store.root, "push", "origin", "HEAD:refs/heads/aria/state")
        _git(store.root, "fetch", "origin")
        return _git(store.root, "rev-parse", "HEAD").strip()

    @staticmethod
    def _tree(store, ref: str = "HEAD") -> set[str]:
        return set(_git(store.root, "ls-tree", "-r", "--name-only", ref).split())

    def _unclaimable_in(self, store, ref: str) -> list[str]:
        """What the contract says a commit's tree carries that no snapshot
        can claim — computed here, path by path, as the test's own oracle.
        A bound store's working tree already holds the real side-cars and
        host files the writers leave behind, so a whole-tree add admits
        far more than the paths a test plants: exactly the live shape."""
        prefixes = {
            kind: root.relative_to(store.root).as_posix()
            for kind, root in state_store.store_roots(store, REPO_HASH).items()
        }
        return sorted(
            path for path in self._tree(store, ref)
            if classify_state_tree_path(path, root_prefixes=prefixes).kind == "unclaimable"
        )

    @staticmethod
    def _committed_governance_rows(store, ref: str = "HEAD") -> list[dict]:
        blob = _git(store.root, "show", f"{ref}:tools/governance.jsonl")
        return [json.loads(line) for line in blob.splitlines() if line.strip()]

    def test_publish_without_the_preamble_refuses_by_name_before_mutation(self) -> None:
        """The primitive stays strict: an unhealed inheritance is refused
        BEFORE the snapshot is written, by a name that says what to run —
        not after a commit and a soft reset, by a generic mismatch."""
        store = self._bound_store()
        self._seed_surface(store, '{"row": "attested"}\n')
        self._publish(store, "snap-1", "cycle-1")
        sidecar = lock_sidecar_path(tools_root(store) / "runs.jsonl")
        poisoned = self._poison_the_tip_like_the_retired_lane(
            store,
            sidecar.relative_to(store.root).as_posix(),
        )
        snapshot_before = (store.root / "snapshot.json").read_bytes()

        follow_up = self._snapshot(store, "snap-2", cycle_id="cycle-2")
        with self.assertRaises(StateStoreRefusal) as caught:
            publish_state(store, snapshot=follow_up, cycle_id="cycle-2", repo_hash=REPO_HASH)

        message = str(caught.exception)
        self.assertIn("state_publish_inherited_unclaimed_entries_unhealed", message)
        self.assertIn("prepare_publishable_snapshot", message)
        expected = self._unclaimable_in(store, poisoned)
        self.assertIn(sidecar.relative_to(store.root).as_posix(), expected)
        self.assertIn(f"carries {len(expected)} entr", message)
        self.assertIn(expected[0], message)
        # Refused before mutation: HEAD is the poisoned tip, nothing was
        # written to snapshot.json, nothing new is staged.
        self.assertEqual(_git(store.root, "rev-parse", "HEAD").strip(), poisoned)
        self.assertEqual((store.root / "snapshot.json").read_bytes(), snapshot_before)
        self.assertEqual(_git(store.root, "diff", "--cached", "--name-only").strip(), "")

    def test_the_preamble_drops_the_inheritance_records_it_and_the_child_verifies(self) -> None:
        store = self._bound_store()
        self._seed_surface(store, '{"row": "attested"}\n')
        self._publish(store, "snap-1", "cycle-1")

        tools = tools_root(store)
        group_key = tools / state_group_lock_relative_path("runtime")
        poison = sorted(
            path.relative_to(store.root).as_posix()
            for path in (
                lock_sidecar_path(tools / "runs.jsonl"),
                group_key,  # the group-lock key itself, committed as a file
                lock_sidecar_path(group_key),  # what file_lock leaves beside it
                tools / "repo_identity.json",  # the bound host identity, as on the live tip
            )
        )
        poisoned = self._poison_the_tip_like_the_retired_lane(store, *poison)
        self.assertTrue(set(poison) <= self._tree(store, poisoned))
        # The whole-tree add took every side-car and host file the bound
        # store's writers had left on disk, not only the three planted —
        # the live tip's sixteen side-cars plus identity and index arose
        # the same way. The oracle is the contract, not the plant list.
        expected = self._unclaimable_in(store, poisoned)
        self.assertTrue(set(poison) <= set(expected), expected)
        self.assertGreater(len(expected), len(poison))

        result = self._publish(store, "snap-2", "cycle-2")
        prepared = result["prepared"]

        self.assertTrue(result["published"])
        self.assertEqual(
            [entry["path"] for entry in prepared.dropped_inherited_entries],
            expected,
        )
        reasons = {entry["path"]: entry["reason"] for entry in prepared.dropped_inherited_entries}
        self.assertEqual(reasons["tools/runs.jsonl.lock"], "lock_sidecar:runs.jsonl")
        self.assertEqual(
            reasons["tools/locks/state-groups/runtime.lock"],
            "state_group_lock:runtime",
        )
        self.assertEqual(
            reasons["tools/locks/state-groups/runtime.lock.lock"],
            "state_group_lock_sidecar:runtime",
        )
        self.assertEqual(reasons["tools/repo_identity.json"], "undeclared")

        # The child's tree simply omits them — and nothing else changed shape.
        child_tree = self._tree(store)
        self.assertFalse(set(expected) & child_tree, child_tree)
        self.assertEqual(self._unclaimable_in(store, "HEAD"), [])
        self.assertIn("tools/runs.jsonl", child_tree)
        self.assertIn("tools/governance.jsonl", child_tree)

        # Index-only: the side-car may be held by a live writer and the
        # identity is what binds this checkout, so the files stay on disk.
        for path in poison:
            self.assertTrue((store.root / path).exists(), path)

        # The governance row names the parent and every path, and it is
        # INSIDE the healing commit, not left behind in the working tree.
        rows = [
            row for row in self._committed_governance_rows(store)
            if row.get("kind") == INHERITED_ENTRIES_DROPPED_EVENT
        ]
        self.assertEqual(len(rows), 1)
        details = rows[0]["details"]
        self.assertEqual(details["parent_commit"], poisoned)
        self.assertEqual(details["dropped_count"], len(expected))
        self.assertEqual([entry["path"] for entry in details["entries"]], expected)
        self.assertEqual(details["entries_not_listed"], 0)
        for entry in details["entries"]:
            self.assertEqual(
                _git(store.root, "rev-parse", f"{poisoned}:{entry['path']}").strip(),
                entry["object_id"],
            )

        # The healed tip verifies, and the next publish needs no healing.
        self.assertTrue(verify_state_store(store, repo_hash=REPO_HASH)["valid"])
        third = self._publish(store, "snap-3", "cycle-3")
        self.assertTrue(third["published"])
        self.assertEqual(third["prepared"].dropped_inherited_entries, ())
        self.assertEqual(
            len([
                row for row in self._committed_governance_rows(store)
                if row.get("kind") == INHERITED_ENTRIES_DROPPED_EVENT
            ]),
            1,
        )

    def test_a_record_that_cannot_be_written_drops_nothing(self) -> None:
        """The row comes first. A tools root that refuses the governance
        write (here: covered state with no host binding, the shape a raw
        clone has) turns the heal into a named refusal, and the index is
        left exactly as it was — no unrecorded mutation."""
        store = self._bootstrap()  # deliberately unbound
        self._seed_surface(store, '{"row": "attested"}\n')
        publish_state(
            store,
            snapshot=self._snapshot(store, "snap-1"),
            cycle_id="cycle-1",
            repo_hash=REPO_HASH,
        )
        sidecar = lock_sidecar_path(tools_root(store) / "runs.jsonl")
        relative = sidecar.relative_to(store.root).as_posix()
        self._poison_the_tip_like_the_retired_lane(store, relative)

        with self.assertRaises(StateStoreRefusal) as caught:
            self._prepare(store, "snap-2", "cycle-2")

        self.assertIn("state_publish_inherited_entries_record_refused", str(caught.exception))
        self.assertIn("ambiguous_tools_root", str(caught.exception))
        self.assertIn(relative, _git(store.root, "ls-files", "--cached", "--", relative))

    def test_a_governance_chain_the_append_refuses_is_a_named_refusal_and_drops_nothing(self) -> None:
        """The record comes first, and a governance ledger whose hash chain
        the append primitive refuses to extend is the same verdict the
        continuity gate gives when it cannot read that ledger — by name,
        not as the primitive's bare RuntimeError — with the index untouched."""
        store = self._bound_store()
        self._seed_surface(store, '{"row": "attested"}\n')
        self._publish(store, "snap-1", "cycle-1")
        sidecar = lock_sidecar_path(tools_root(store) / "runs.jsonl")
        relative = sidecar.relative_to(store.root).as_posix()
        self._poison_the_tip_like_the_retired_lane(store, relative)

        # Break the chain: flip a byte inside the first row's payload so its
        # recorded ledger_hash no longer matches its content.
        ledger = tools_root(store) / "governance.jsonl"
        lines = ledger.read_text(encoding="utf-8").splitlines(keepends=True)
        self.assertTrue(lines)
        first = json.loads(lines[0])
        first["kind"] = first["kind"] + "-tampered"
        lines[0] = json.dumps(first, sort_keys=True, separators=(",", ":")) + "\n"
        ledger.write_text("".join(lines), encoding="utf-8")

        with self.assertRaises(StateStoreRefusal) as caught:
            self._prepare(store, "snap-2", "cycle-2")

        self.assertIn("state_publish_governance_ledger_unreadable", str(caught.exception))
        self.assertIn("nothing was dropped", str(caught.exception))
        self.assertIn(relative, _git(store.root, "ls-files", "--cached", "--", relative))

    def test_a_parent_carrying_more_than_a_row_can_list_inline_still_heals(self) -> None:
        """The row is bounded by construction, not by luck: past the count
        cap the sample is cut and the row says how many were not listed;
        past the inline byte cap the listed sample itself becomes a digest
        stub naming the parent commit as the recovery. Either way the heal
        proceeds and the append primitive never sees a row it would refuse."""
        store = self._bound_store()
        self._seed_surface(store, '{"row": "attested"}\n')
        self._publish(store, "snap-1", "cycle-1")

        count = MAX_RECORDED_DROPPED_ENTRIES + 100
        stem = "tools/undeclared/" + "x" * 200 + "-"
        planted = [f"{stem}{index:05d}" for index in range(count)]
        # The listed sample alone is far past the inline field cap.
        self.assertGreater(
            len(json.dumps(planted[:MAX_RECORDED_DROPPED_ENTRIES])),
            INLINE_ROW_FIELD_MAX_BYTES,
        )
        poisoned = self._poison_the_tip_like_the_retired_lane(store, *planted)

        result = self._publish(store, "snap-2", "cycle-2")

        self.assertTrue(result["published"])
        # The whole-tree add admitted the bound store's own side-cars and
        # host files too; the listed sample is the first slice of everything
        # unclaimable, in tree order, and the heal covers all of it.
        expected = self._unclaimable_in(store, poisoned)
        self.assertTrue(set(planted) <= set(expected))
        dropped = [entry["path"] for entry in result["prepared"].dropped_inherited_entries]
        self.assertEqual(dropped, expected[:MAX_RECORDED_DROPPED_ENTRIES])
        self.assertFalse(set(expected) & self._tree(store))
        self.assertEqual(self._unclaimable_in(store, "HEAD"), [])
        rows = [
            row for row in self._committed_governance_rows(store)
            if row.get("kind") == INHERITED_ENTRIES_DROPPED_EVENT
        ]
        self.assertEqual(len(rows), 1)
        details = rows[0]["details"]
        self.assertEqual(details["parent_commit"], poisoned)
        self.assertEqual(details["dropped_count"], len(expected))
        self.assertEqual(
            details["entries_not_listed"],
            len(expected) - MAX_RECORDED_DROPPED_ENTRIES,
        )
        self.assertTrue(details["entries"]["spilled"])
        self.assertIn(poisoned, details["entries"]["recovery"])
        self.assertTrue(verify_state_store(store, repo_hash=REPO_HASH)["valid"])

    def test_a_clean_parent_writes_no_row_and_drops_nothing(self) -> None:
        store = self._bound_store()
        self._seed_surface(store, '{"row": "attested"}\n')
        self._publish(store, "snap-1", "cycle-1")
        result = self._publish(store, "snap-2", "cycle-2")
        self.assertTrue(result["published"])
        self.assertEqual(result["prepared"].dropped_inherited_entries, ())
        self.assertFalse(any(
            row.get("kind") == INHERITED_ENTRIES_DROPPED_EVENT
            for row in self._committed_governance_rows(store)
        ))

    def test_an_inherited_surface_the_stale_manifest_never_claimed_stages_as_a_deletion(self) -> None:
        """The second half of the live tip: `git add -A` also admitted
        DECLARED surfaces (compaction archives, fresh hot artifacts) that its
        stale snapshot.json never claimed. Staging deletions only for what the
        published manifest named would leave such a file in the tree once the
        working tree loses it — unclaimed, and refused by the verifier."""
        store = self._bound_store()
        self._seed_surface(store, '{"row": "attested"}\n')
        self._publish(store, "snap-1", "cycle-1")

        archive = tools_root(store) / "archives" / "runs-compact-20260911T182938Z.jsonl.gz"
        archive.parent.mkdir(parents=True, exist_ok=True)
        with gzip.open(archive, "wt", encoding="utf-8") as handle:
            handle.write('{"row": "stripped"}\n')
        relative = archive.relative_to(store.root).as_posix()
        poisoned = self._poison_the_tip_like_the_retired_lane(store)
        self.assertIn(relative, self._tree(store, poisoned))
        stale_claims = json.loads(_git(store.root, "show", f"{poisoned}:snapshot.json"))
        self.assertFalse(any(
            entry.get("path") == "archives/runs-compact-20260911T182938Z.jsonl.gz"
            for entry in stale_claims["surfaces"].values()
        ))

        # A later run removed it from the working tree; nothing claims it now.
        archive.unlink()
        result = self._publish(store, "snap-2", "cycle-2")

        self.assertTrue(result["published"])
        # A declared surface is never "unclaimable": it is not dropped and
        # recorded like a side-car, it is STAGED as the deletion it is —
        # the same path a surface the manifest did claim takes.
        self.assertNotIn(
            relative,
            [entry["path"] for entry in result["prepared"].dropped_inherited_entries],
        )
        self.assertNotIn(relative, self._tree(store))
        self.assertTrue(verify_state_store(store, repo_hash=REPO_HASH)["valid"])
