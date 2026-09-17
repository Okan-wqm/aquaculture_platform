"""The continuity gate: a broken chain never publishes, and a loss publishes
only when someone vouched for it — the compactor by attestation, or the
operator by an acknowledgment that names this repository and is recorded
inside the very commit it accepts.

THE REGRESSION THIS PINS. bd74c801c refused ``chain_broken`` by name. The
compaction-attestation rewrite gated on the loss list instead of on the
status, so a chain_broken snapshot with NO lost surfaces (matching
manifest_root, foreign prev_snapshot_id) walked through — with or without
an acknowledgment. Both cases are driven here against a real store.

THE PROMISE THIS KEEPS. The pre-attestation comment said an acknowledged
reduction "is recorded in the governance audit trail" and nothing recorded
it. Now the preamble appends ``state_publish_losses_accepted_by_ack`` before
the snapshot is built, the publish verifies the row is there, and the
acknowledgment is validated exactly as the bootstrap validates it.
"""
from __future__ import annotations

import json
import threading
from unittest import mock

from aria_kernel import ledger_inline, state_store
from aria_kernel.file_lock import with_exclusive_lock
from aria_kernel.state_continuity_gate import (
    ACCEPTED_SURFACES_DIGEST_KEY,
    ACCEPTED_SURFACES_KEY,
    ACK_REF_KEY,
    LOSSES_ACCEPTED_BY_ACK_EVENT,
    surfaces_digest,
)
from aria_kernel.state_snapshot import build_snapshot
from aria_kernel.state_store import (
    BOOTSTRAP_ACK_ENV,
    StateStoreRefusal,
    prepare_and_publish_state,
    prepare_publishable_snapshot,
    publish_state,
    read_published_snapshot,
    tools_root,
    verify_state_store,
)
from tests.test_state_store import REPO_HASH, StateStoreTestCase, _EnvPatch, _git


class ContinuityGateTestCase(StateStoreTestCase):
    def _bound_store(self):
        """A bound store, as the restore action leaves every lane's: the
        governance row an acceptance appends needs a bound tools root."""
        from aria_kernel.tools_binding import bind_tools_root

        store = self._bootstrap()
        with _EnvPatch(state_store.store_environment(store, REPO_HASH)):
            bind_tools_root(
                tools_dir=str(tools_root(store)),
                workspace_root=str(self.repo),
                reason="bind the restored aria/state store to this checkout",
            )
        return store

    def _published_store(self):
        store = self._bound_store()
        self._seed_surface(store, '{"row": 1}\n')
        result = prepare_and_publish_state(
            store,
            snapshot_id="snap-1",
            cycle_id="cycle-1",
            lane="test",
            repo_hash=REPO_HASH,
        )
        self.assertTrue(result["published"])
        return store

    def _prepare(self, store, snapshot_id: str, cycle_id: str):
        return prepare_publishable_snapshot(
            store,
            snapshot_id=snapshot_id,
            cycle_id=cycle_id,
            lane="test",
            repo_hash=REPO_HASH,
        )

    def _lose_a_surface(self, store) -> str:
        """Remove a claimed surface nothing attests; return its snapshot key."""
        stray = tools_root(store) / "pressure" / "hand-removed.json"
        stray.parent.mkdir(parents=True, exist_ok=True)
        stray.write_text("{}\n", encoding="utf-8")
        result = prepare_and_publish_state(
            store,
            snapshot_id="snap-with-stray",
            cycle_id="cycle-with-stray",
            lane="test",
            repo_hash=REPO_HASH,
        )
        self.assertTrue(result["published"])
        stray.unlink()
        return "pressure_artifacts:pressure/hand-removed.json"

    @staticmethod
    def _committed_governance_rows(store, ref: str = "HEAD") -> list[dict]:
        blob = _git(store.root, "show", f"{ref}:tools/governance.jsonl")
        return [json.loads(line) for line in blob.splitlines() if line.strip()]

    def _acceptance_rows(self, store, ref: str = "HEAD") -> list[dict]:
        return [
            row for row in self._committed_governance_rows(store, ref)
            if row.get("kind") == LOSSES_ACCEPTED_BY_ACK_EVENT
        ]


class AChainBrokenSnapshotNeverPublishes(ContinuityGateTestCase):
    def _chain_broken_snapshot(self, store) -> dict:
        """Matching manifest_root, foreign prev_snapshot_id, no losses: the
        ancestry proof passes, the chain does not."""
        published = read_published_snapshot(store)
        snapshot = build_snapshot(
            snapshot_id="snap-foreign-parent",
            cycle_id="cycle-2",
            lane="test",
            roots=state_store.store_roots(store, REPO_HASH),
            previous={
                "snapshot_id": "a-snapshot-this-branch-never-published",
                "manifest_root": published["manifest_root"],
            },
        )
        self.assertEqual(snapshot["prev_manifest_root"], published["manifest_root"])
        self.assertNotEqual(snapshot["prev_snapshot_id"], published["snapshot_id"])
        return snapshot

    def _assert_refused_unmutated(self, store, snapshot: dict) -> None:
        head_before = _git(store.root, "rev-parse", "HEAD").strip()
        snapshot_before = (store.root / "snapshot.json").read_bytes()
        with self.assertRaises(StateStoreRefusal) as caught:
            publish_state(store, snapshot=snapshot, cycle_id="cycle-2", repo_hash=REPO_HASH)
        message = str(caught.exception)
        self.assertIn("state_publish_continuity_chain_broken", message)
        self.assertIn("a-snapshot-this-branch-never-published", message)
        self.assertIn("lost_surfaces=[]", message)
        self.assertEqual(_git(store.root, "rev-parse", "HEAD").strip(), head_before)
        self.assertEqual((store.root / "snapshot.json").read_bytes(), snapshot_before)

    def test_refused_by_name_without_an_acknowledgment(self) -> None:
        store = self._published_store()
        snapshot = self._chain_broken_snapshot(store)
        with _EnvPatch({BOOTSTRAP_ACK_ENV: None}):
            self._assert_refused_unmutated(store, snapshot)

    def test_refused_by_name_with_the_acknowledgment_set(self) -> None:
        # The ack opens exactly one gate — an acknowledged REDUCTION. A tree
        # that does not know which snapshot it continues is not a reduction
        # and no operator can make it one.
        store = self._published_store()
        snapshot = self._chain_broken_snapshot(store)
        with _EnvPatch({BOOTSTRAP_ACK_ENV: self.identity}):
            self._assert_refused_unmutated(store, snapshot)


class TheAcknowledgmentIsValidatedLikeTheBootstrap(ContinuityGateTestCase):
    def test_an_ack_naming_another_repository_is_refused_by_name(self) -> None:
        """Any non-empty string used to open the gate; a fork's ack, or a
        "1" pasted forward, must not. The preamble refuses before it records
        anything, and the publish refuses the same value the same way."""
        store = self._published_store()
        lost = self._lose_a_surface(store)
        with _EnvPatch({BOOTSTRAP_ACK_ENV: "someone-else/other-repo"}):
            with self.assertRaises(StateStoreRefusal) as caught:
                self._prepare(store, "snap-3", "cycle-3")
            self.assertIn("state_publish_reduction_ack_mismatch", str(caught.exception))
            self.assertIn(self.identity, str(caught.exception))
            self.assertEqual(self._acceptance_rows(store), [])

            follow_up = self._snapshot(store, "snap-3", cycle_id="cycle-3")
            with self.assertRaises(StateStoreRefusal) as caught:
                publish_state(store, snapshot=follow_up, cycle_id="cycle-3", repo_hash=REPO_HASH)
            self.assertIn("state_publish_reduction_ack_mismatch", str(caught.exception))
        self.assertNotIn(lost, follow_up["surfaces"])

    def test_no_ack_means_the_loss_is_refused_by_name(self) -> None:
        store = self._published_store()
        lost = self._lose_a_surface(store)
        with _EnvPatch({BOOTSTRAP_ACK_ENV: None}):
            prepared = self._prepare(store, "snap-3", "cycle-3")
            self.assertEqual(prepared.accepted_losses_recorded, ())
            with self.assertRaises(StateStoreRefusal) as caught:
                publish_state(
                    store,
                    snapshot=prepared.snapshot,
                    cycle_id="cycle-3",
                    repo_hash=REPO_HASH,
                    expected_base_head=prepared.base_head,
                )
        self.assertIn("state_publish_continuity_surfaces_lost", str(caught.exception))
        self.assertIn(lost, str(caught.exception))
        self.assertEqual(self._acceptance_rows(store), [])


class AnAcceptedReductionIsRecordedInsideThePublish(ContinuityGateTestCase):
    def test_the_row_lives_in_the_commit_and_names_the_losses_and_the_ack(self) -> None:
        store = self._published_store()
        lost = self._lose_a_surface(store)
        base_rows = len(self._committed_governance_rows(store))

        with _EnvPatch({BOOTSTRAP_ACK_ENV: self.identity}):
            result = prepare_and_publish_state(
                store,
                snapshot_id="snap-3",
                cycle_id="cycle-3",
                lane="test",
                repo_hash=REPO_HASH,
            )

        self.assertTrue(result["published"])
        self.assertEqual(result["accepted_losses_recorded"], [lost])
        continuity = result["continuity"]
        self.assertEqual(continuity["status"], "surfaces_lost")
        self.assertEqual(continuity["lost_surfaces"], [lost])
        self.assertEqual(continuity["compaction_attested_surfaces"], [])
        self.assertEqual(continuity["ack_accepted_surfaces"], [lost])

        # Durable: the row is in the published commit's governance ledger,
        # after the tip's rows, and the committed snapshot attests it.
        rows = self._acceptance_rows(store)
        self.assertEqual(len(rows), 1)
        details = rows[0]["details"]
        self.assertEqual(details[ACCEPTED_SURFACES_KEY], [lost])
        self.assertEqual(details[ACCEPTED_SURFACES_DIGEST_KEY], surfaces_digest([lost]))
        self.assertEqual(details[ACK_REF_KEY], self.identity)
        self.assertEqual(details["lost_count"], 1)
        self.assertEqual(details["write_driving_lost"], [])
        self.assertEqual(details["previous_snapshot_id"], "snap-with-stray")
        self.assertGreater(len(self._committed_governance_rows(store)), base_rows)
        committed = json.loads(_git(store.root, "show", "HEAD:snapshot.json"))
        self.assertEqual(
            committed["surfaces"]["tools_governance"]["row_count"],
            len(self._committed_governance_rows(store)),
        )
        self.assertTrue(verify_state_store(store, repo_hash=REPO_HASH)["valid"])

        # The next publish needs no acknowledgment and records nothing.
        with _EnvPatch({BOOTSTRAP_ACK_ENV: None}):
            again = prepare_and_publish_state(
                store,
                snapshot_id="snap-4",
                cycle_id="cycle-4",
                lane="test",
                repo_hash=REPO_HASH,
            )
        self.assertEqual(again["accepted_losses_recorded"], [])
        self.assertEqual(len(self._acceptance_rows(store)), 1)

    def test_a_publish_that_skipped_the_preamble_cannot_accept_unrecorded(self) -> None:
        """The primitive stays strict: with the ack in the environment but no
        row recorded, `publish_state` refuses by a name that says what to
        run — the acceptance is never implied by an environment variable."""
        store = self._published_store()
        lost = self._lose_a_surface(store)
        head_before = _git(store.root, "rev-parse", "HEAD").strip()
        with _EnvPatch({BOOTSTRAP_ACK_ENV: self.identity}):
            follow_up = self._snapshot(store, "snap-3", cycle_id="cycle-3")
            with self.assertRaises(StateStoreRefusal) as caught:
                publish_state(store, snapshot=follow_up, cycle_id="cycle-3", repo_hash=REPO_HASH)
        message = str(caught.exception)
        self.assertIn("state_publish_losses_acceptance_unrecorded", message)
        self.assertIn(lost, message)
        self.assertIn("prepare_publishable_snapshot", message)
        self.assertEqual(_git(store.root, "rev-parse", "HEAD").strip(), head_before)
        self.assertEqual(self._acceptance_rows(store), [])

    def test_a_spilled_record_still_vouches_by_digest(self) -> None:
        """The row is bounded by construction: past the inline cap the list
        becomes a digest stub, and the publish verifies the digest over its
        own loss set — so a reduction too wide to list inline is accepted
        exactly as a narrow one, never refused for the row's size."""
        store = self._published_store()
        lost = self._lose_a_surface(store)
        with _EnvPatch({BOOTSTRAP_ACK_ENV: self.identity}), mock.patch.object(
            ledger_inline, "INLINE_ROW_FIELD_MAX_BYTES", 8
        ):
            result = prepare_and_publish_state(
                store,
                snapshot_id="snap-3",
                cycle_id="cycle-3",
                lane="test",
                repo_hash=REPO_HASH,
            )
        self.assertTrue(result["published"])
        self.assertEqual(result["continuity"]["ack_accepted_surfaces"], [lost])
        details = self._acceptance_rows(store)[0]["details"]
        self.assertTrue(details[ACCEPTED_SURFACES_KEY]["spilled"])
        self.assertEqual(details[ACCEPTED_SURFACES_DIGEST_KEY], surfaces_digest([lost]))
        self.assertTrue(verify_state_store(store, repo_hash=REPO_HASH)["valid"])


class TheSingleAttemptPublishHoldsOneLock(ContinuityGateTestCase):
    def test_nothing_can_take_the_lifecycle_lock_between_preamble_and_publish(self) -> None:
        """`prepare_and_publish_state` — what `state publish` runs — holds
        the store's lifecycle lock from before the preamble's index mutation
        until the publish has pushed. Probed from another thread at the one
        instant that used to be unguarded: after the preamble returned and
        before the publish began."""
        store = self._published_store()
        real_preamble = state_store.prepare_publishable_snapshot
        lock_path = (
            state_store._git_common_directory(self.repo.resolve())
            / state_store._LIFECYCLE_LOCK_TARGET
        )
        probe: dict[str, object] = {}

        def probe_from_another_thread() -> None:
            try:
                with with_exclusive_lock(lock_path, timeout_seconds=0):
                    probe["acquired"] = True
            except TimeoutError:
                probe["acquired"] = False

        def preamble_then_probe(*args, **kwargs):
            prepared = real_preamble(*args, **kwargs)
            worker = threading.Thread(target=probe_from_another_thread)
            worker.start()
            worker.join()
            return prepared

        self._seed_surface(store, '{"row": 2}\n')
        with mock.patch.object(
            state_store, "prepare_publishable_snapshot", side_effect=preamble_then_probe
        ):
            result = prepare_and_publish_state(
                store,
                snapshot_id="snap-3",
                cycle_id="cycle-3",
                lane="test",
                repo_hash=REPO_HASH,
            )
        self.assertTrue(result["published"])
        self.assertEqual(probe, {"acquired": False})
