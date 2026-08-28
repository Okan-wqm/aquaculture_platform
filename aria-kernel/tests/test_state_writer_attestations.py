"""ORPHAN-MEDIUM-767 — local state-tree materializations name their writer.

The local mirror's ledgers were batch-touched twice on 2026-08-20 with
nanosecond-identical mtimes, no content change, and no attributable writer
(ledgers are gitignored — no VCS signal). checkout/bootstrap now attest to
a HOST-LOCAL sibling ledger beside the store directory — never inside the
store worktree, whose clean-tree and snapshot-continuity invariants must
not observe the attestation. The branch side needs no attestation: git
already attributes every publish commit.
"""
from __future__ import annotations

import json
import shutil
import unittest
from pathlib import Path

from aria_kernel.state_store import checkout_state_store, publish_state
from tests.test_state_store import REPO_HASH, StateStoreTestCase


def _writer_rows(store) -> list[dict]:
    ledger = store.root.parent / f"{store.root.name}.writers.jsonl"
    return [
        json.loads(line)
        for line in ledger.read_text(encoding="utf-8").splitlines()
        if line.strip()
    ]


class StateWriterAttestationTests(unittest.TestCase):
    def test_bootstrap_and_restore_attest_outside_the_store_tree(self) -> None:
        harness = StateStoreTestCase("run")
        harness.setUp()
        try:
            store = harness._bootstrap()
            harness._seed_surface(store, "")
            publish_state(
                store,
                snapshot=harness._snapshot(store, "writers-snap-1"),
                cycle_id="cycle-writers",
                repo_hash=REPO_HASH,
            )
            rows = _writer_rows(store)
            actions = [row.get("action") for row in rows]
            self.assertIn("bootstrap", actions)
            self.assertNotIn("publish", actions)  # git attributes publishes
            for row in rows:
                self.assertIsInstance(row.get("pid"), int)
                self.assertTrue(str(row.get("command") or "").strip())

            # The attestation never lands INSIDE the store worktree: the
            # clean-tree and snapshot-continuity invariants must not see it.
            self.assertFalse((store.root / "tools" / "state-manifest").exists())
            self.assertFalse(
                any(
                    row.get("kind") == "state_writer_attested"
                    for row in _governance_rows(store)
                )
            )

            shutil.rmtree(store.root)  # the wipe: dir gone, worktree registered
            restored = checkout_state_store(harness.repo, store_dir=store.root)
            actions = [row.get("action") for row in _writer_rows(restored)]
            self.assertIn("checkout", actions)
            # Z1's disclosure still lands inside the store, untouched.
            kinds = [row.get("kind") for row in _governance_rows(restored)]
            self.assertIn("state_store_rematerialized_after_missing", kinds)
        finally:
            harness.doCleanups()


def _governance_rows(store) -> list[dict]:
    gov = Path(store.root) / "tools" / "governance.jsonl"
    if not gov.exists():
        return []
    return [
        json.loads(line)
        for line in gov.read_text(encoding="utf-8").splitlines()
        if line.strip()
    ]


if __name__ == "__main__":
    unittest.main()
