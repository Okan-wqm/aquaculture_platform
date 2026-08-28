"""ARIA-HIGH-017 — the snapshot line cap must grandfather inherited history.

The Task 2 hardening bounded every ledger line at 1 MiB. The repository's
own published ``runs.jsonl`` already carries a 1.49 MB row (written under
the pre-cap code), so every ``Publish ARIA state`` step since the
hardening merged fails closed at that line: the publisher refuses to
re-publish the very ledger it already published. An append-only,
hash-chained ledger cannot be retroactively shrunk — the cap must bind
NEWLY appended rows while admitting lines inherited from the previously
published tip.
"""

from __future__ import annotations

import copy
import sys
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent))

from aria_kernel import autonomy_evidence, cycle, state_snapshot, state_store
from aria_kernel.ledger import append_jsonl
from aria_kernel.memory_gap import REFERENCE_DAILY_ANCHOR, REFERENCE_STATE_BRANCH
from aria_kernel.state_snapshot import SnapshotError
from aria_kernel.state_store import checkout_state_store, publish_state, tools_root
from aria_kernel.workspace import canonical_identity

from test_state_store import REPO_HASH, StateStoreTestCase

_FAT_PADDING = "x" * (1100 * 1024)  # > 1 MiB serialized


class PublishedPrefixRowCountTests(StateStoreTestCase):
    def _complete_snapshot(self) -> dict[str, object]:
        store = self._bootstrap()
        append_jsonl(
            tools_root(store) / "runs.jsonl",
            {"note": "fixed"},
            test_fixture=True,
        )
        append_jsonl(
            tools_root(store) / "cost-attribution" / "2026-08.jsonl",
            {"note": "glob"},
            test_fixture=True,
        )
        return state_store.build_publishable_snapshot(
            store,
            snapshot_id="prefix-snapshot",
            cycle_id="prefix-cycle",
            lane="test",
            repo_hash=REPO_HASH,
        )

    def test_none_has_no_published_prefix_counts(self) -> None:
        self.assertEqual(state_snapshot.published_prefix_row_counts(None), {})

    def test_exact_declared_fixed_and_glob_ledger_keys_are_extracted(self) -> None:
        snapshot = self._complete_snapshot()

        self.assertEqual(
            state_snapshot.published_prefix_row_counts(snapshot),
            {
                "runs": 1,
                "cost_attribution:cost-attribution/2026-08.jsonl": 1,
            },
        )

    def test_non_string_key_is_not_coerced(self) -> None:
        snapshot = copy.deepcopy(self._complete_snapshot())
        surfaces = snapshot["surfaces"]
        surfaces[1] = surfaces.pop("runs")

        with self.assertRaisesRegex(SnapshotError, r"snapshot_manifest_invalid:"):
            state_snapshot.published_prefix_row_counts(snapshot)

    def test_boolean_negative_missing_unknown_and_malformed_counts_are_refused(
        self,
    ) -> None:
        valid = self._complete_snapshot()

        malformed: list[tuple[str, dict[str, object]]] = []
        boolean = copy.deepcopy(valid)
        boolean["surfaces"]["runs"]["row_count"] = True
        malformed.append(("boolean", boolean))

        negative = copy.deepcopy(valid)
        negative["surfaces"]["runs"]["row_count"] = -1
        malformed.append(("negative", negative))

        missing = copy.deepcopy(valid)
        del missing["surfaces"]["runs"]["row_count"]
        malformed.append(("missing", missing))

        unknown = copy.deepcopy(valid)
        unknown["surfaces"]["unknown"] = unknown["surfaces"].pop("runs")
        malformed.append(("unknown", unknown))

        malformed_claim = copy.deepcopy(valid)
        malformed_claim["surfaces"]["runs"] = "not-a-claim"
        malformed.append(("malformed", malformed_claim))

        for label, snapshot in malformed:
            with self.subTest(label=label):
                with self.assertRaisesRegex(
                    SnapshotError,
                    r"snapshot_manifest_invalid:",
                ):
                    state_snapshot.published_prefix_row_counts(snapshot)

    def test_top_level_manifest_drift_is_refused_before_claim_extraction(self) -> None:
        snapshot = copy.deepcopy(self._complete_snapshot())
        snapshot["unexpected"] = "drift"

        with self.assertRaisesRegex(SnapshotError, r"snapshot_manifest_invalid:"):
            state_snapshot.published_prefix_row_counts(snapshot)


class LineCapGrandfatherTests(StateStoreTestCase):
    def _append_fat_row(self, store) -> None:
        """One chain-valid row whose serialized size exceeds the 1 MiB cap."""
        append_jsonl(
            tools_root(store) / "runs.jsonl",
            {"note": _FAT_PADDING},
            test_fixture=True,
        )

    def _publish(
        self,
        store,
        snapshot_id: str,
        cycle_id: str,
        *,
        repo_hash: str = REPO_HASH,
    ):
        return publish_state(
            store,
            snapshot=state_store.build_publishable_snapshot(
                store,
                snapshot_id=snapshot_id,
                cycle_id=cycle_id,
                lane="test",
                repo_hash=repo_hash,
            ),
            cycle_id=cycle_id,
            repo_hash=repo_hash,
        )

    def _published_store_with_inherited_fat_row(
        self,
        *,
        in_workspace: bool = False,
        repo_hash: str = REPO_HASH,
    ):
        store = checkout_state_store(self.repo) if in_workspace else self._bootstrap()
        self.assertTrue(store.bootstrapped)
        self._seed_surface(store, '{"note": "row-1"}')
        with mock.patch.object(
            state_snapshot,
            "SNAPSHOT_MAX_LEDGER_LINE_BYTES",
            8 * 1024 * 1024,
        ), mock.patch.object(
            autonomy_evidence,
            "_MAX_SNAPSHOT_LEDGER_LINE_BYTES",
            8 * 1024 * 1024,
        ):
            self._append_fat_row(store)
            self._publish(store, "snap-1", "c1", repo_hash=repo_hash)
        return store

    def test_inherited_oversized_line_publishes_under_the_restored_cap(self) -> None:
        # Leg one models pre-hardening history already published at the old,
        # relaxed cap; the shared helper leaves those exact bytes at the tip.
        store = self._published_store_with_inherited_fat_row()
        # Leg two: the cap is back at 1 MiB. The fat row is INHERITED (it
        # is present in the previously published tip), so the next publish
        # must admit it while still enforcing the cap on anything new.
        # NOTE: append, never _seed_surface — the seeded writer REPLACES
        # the ledger and would silently erase the inherited fat row.
        append_jsonl(
            tools_root(store) / "runs.jsonl",
            {"note": "row-2"},
            test_fixture=True,
        )
        result = self._publish(store, "snap-2", "c2")
        self.assertTrue(result["published"])
        self.assertTrue(result["pushed"])

    def test_new_oversized_line_is_still_refused(self) -> None:
        store = self._bootstrap()
        self._seed_surface(store, '{"note": "row-1"}')
        self._publish(store, "snap-1", "c1")
        # A fat row appended AFTER the previous tip is NOT inherited.
        self._append_fat_row(store)
        with self.assertRaises((SnapshotError, state_store.StateStoreError)) as ctx:
            self._publish(store, "snap-2", "c2")
        self.assertIn("line_too_large", str(ctx.exception))

    def test_verify_store_accepts_the_exact_inherited_oversized_prefix(self) -> None:
        store = self._published_store_with_inherited_fat_row()

        verdict = state_store.verify_state_store(store, repo_hash=REPO_HASH)

        self.assertTrue(verdict["valid"], verdict)
        self.assertEqual(verdict["status"], "ok")

    def test_verify_store_rejects_an_oversized_row_after_the_published_prefix(
        self,
    ) -> None:
        store = self._published_store_with_inherited_fat_row()
        self._append_fat_row(store)

        with self.assertRaisesRegex(
            SnapshotError,
            "snapshot_surface_line_too_large",
        ):
            state_store.verify_state_store(store, repo_hash=REPO_HASH)

    def test_state_continuity_reports_ok_for_the_exact_inherited_oversized_prefix(
        self,
    ) -> None:
        identity = canonical_identity(self.repo)
        store = self._published_store_with_inherited_fat_row(
            in_workspace=True,
            repo_hash=identity,
        )
        context = cycle.build_phase_context(
            cycle_id="continuity-1",
            workspace_root=self.repo,
            base_dir=tools_root(store),
        )

        verdict = cycle._phase_state_continuity(context)

        self.assertEqual(verdict["status"], "ok")
        self.assertEqual(verdict["reference_kind"], REFERENCE_STATE_BRANCH)
        self.assertFalse(verdict["blocks_action"])

    def test_state_continuity_rejects_an_oversized_row_after_the_published_prefix(
        self,
    ) -> None:
        identity = canonical_identity(self.repo)
        store = self._published_store_with_inherited_fat_row(
            in_workspace=True,
            repo_hash=identity,
        )
        self._append_fat_row(store)
        context = cycle.build_phase_context(
            cycle_id="continuity-1",
            workspace_root=self.repo,
            base_dir=tools_root(store),
        )

        with self.assertRaisesRegex(
            SnapshotError,
            "snapshot_surface_line_too_large",
        ):
            cycle._phase_state_continuity(context)

    def test_state_continuity_does_not_grandfather_daily_anchor_counts(self) -> None:
        base_dir = self.repo / "daily-tools"
        append_jsonl(
            base_dir / "runs.jsonl",
            {"note": "row-1"},
            test_fixture=True,
        )
        self._append_fat_row_at(base_dir)
        with mock.patch.object(
            state_snapshot,
            "SNAPSHOT_MAX_LEDGER_LINE_BYTES",
            8 * 1024 * 1024,
        ):
            anchor = state_snapshot.build_snapshot(
                snapshot_id="daily-anchor",
                cycle_id="daily-cycle",
                lane="test",
                roots={"tools": base_dir},
            )
        context = cycle.build_phase_context(
            cycle_id="continuity-1",
            workspace_root=self.repo,
            base_dir=base_dir,
        )

        with mock.patch(
            "aria_kernel.memory_gap.resolve_continuity_reference",
            return_value=(anchor, REFERENCE_DAILY_ANCHOR),
        ):
            with self.assertRaisesRegex(
                SnapshotError,
                "snapshot_surface_line_too_large",
            ):
                cycle._phase_state_continuity(context)

    @staticmethod
    def _append_fat_row_at(base_dir: Path) -> None:
        append_jsonl(
            base_dir / "runs.jsonl",
            {"note": _FAT_PADDING},
            test_fixture=True,
        )


if __name__ == "__main__":
    unittest.main()
