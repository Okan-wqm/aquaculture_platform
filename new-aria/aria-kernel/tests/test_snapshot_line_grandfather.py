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

import json
import sys
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent))

from aria_kernel import autonomy_evidence, state_snapshot, state_store
from aria_kernel.ledger import _record_hash, _stamped_for_surface, append_jsonl, read_jsonl
from aria_kernel.state_snapshot import SnapshotError
from aria_kernel.state_store import publish_state, tools_root

from test_state_store import REPO_HASH, StateStoreTestCase

_FAT_PADDING = "x" * (1100 * 1024)  # > 1 MiB serialized


class LineCapGrandfatherTests(StateStoreTestCase):
    def _append_fat_row(self, store) -> None:
        """One chain-valid row whose serialized size exceeds the 1 MiB cap.

        Written the way the pre-cap code wrote it — straight to the file
        with the chain fields computed by the same helpers the primitive
        uses. ARIA-HIGH-034 made ``append_jsonl`` refuse such a row, which
        is exactly why an INHERITED one can only come from history: this
        helper is that history.
        """
        path = tools_root(store) / "runs.jsonl"
        rows = read_jsonl(path) if path.exists() else []
        previous_hash = str(rows[-1]["ledger_hash"]) if rows else None
        stored = dict(_stamped_for_surface(path, {"note": _FAT_PADDING}))
        stored["previous_ledger_hash"] = previous_hash
        stored["ledger_hash"] = _record_hash(stored, previous_hash)
        with path.open("a", encoding="utf-8") as handle:
            handle.write(json.dumps(stored, sort_keys=True, separators=(",", ":")) + "\n")

    def _publish(self, store, snapshot_id: str, cycle_id: str):
        return publish_state(
            store,
            snapshot=state_store.build_publishable_snapshot(
                store,
                snapshot_id=snapshot_id,
                cycle_id=cycle_id,
                lane="test",
                repo_hash=REPO_HASH,
            ),
            cycle_id=cycle_id,
            repo_hash=REPO_HASH,
        )

    def test_inherited_oversized_line_publishes_under_the_restored_cap(self) -> None:
        store = self._bootstrap()
        self._seed_surface(store, '{"note": "row-1"}')
        # Leg one: publish v1 under a relaxed cap — this models the
        # pre-hardening history that already exists in production (the
        # 1.49 MB row is published at the 05:47 tip).
        with mock.patch.object(
            state_snapshot, "SNAPSHOT_MAX_LEDGER_LINE_BYTES", 8 * 1024 * 1024,
        ), mock.patch.object(
            autonomy_evidence, "_MAX_SNAPSHOT_LEDGER_LINE_BYTES", 8 * 1024 * 1024,
        ):
            self._append_fat_row(store)
            self._publish(store, "snap-1", "c1")
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


if __name__ == "__main__":
    unittest.main()
