"""Z1 (ORPHAN-712) — the state store survives its neighbors.

Measured 2026-08-17: the hourly dataflow watchdog's default checkout ran
`git clean -ffdx` at the shared self-hosted workspace root and swept the
untracked, gitignored `.aria-state-store` between runs; a deleted store
bypassed `_clear_existing_store`'s unpublished-work refusal entirely, so
the loss was SILENT. Today a single-slot runner is the only thing
serializing the four self-hosted lanes — an accident of runner count, not
a property of the repo.

Deliberate-breakage pins:
- every self-hosted workflow shares ONE concurrency group (adding a second
  runner service can never reopen the mid-run wipe window);
- the watchdog checks out into its own subdirectory (its clean can never
  touch the store path again);
- a registered-but-missing store re-materializes LOUDLY (governance row on
  the freshly restored store, published with the next push).
"""
from __future__ import annotations

import json
import unittest
from pathlib import Path

import yaml

_REPO = Path(__file__).resolve().parents[2]
_WF = _REPO / ".github" / "workflows"

_SELF_HOSTED_GROUP = "aria-selfhosted-workspace"


def _workflows_with_selfhosted() -> list[Path]:
    hits = []
    for path in sorted(_WF.glob("*.yml")):
        if "self-hosted" in path.read_text(encoding="utf-8"):
            doc = yaml.safe_load(path.read_text(encoding="utf-8"))
            for job in (doc.get("jobs") or {}).values():
                runs_on = job.get("runs-on")
                if isinstance(runs_on, list) and "self-hosted" in runs_on:
                    hits.append(path)
                    break
    return hits


class SharedWorkspaceGroupPins(unittest.TestCase):
    def test_every_selfhosted_workflow_shares_the_group(self) -> None:
        paths = _workflows_with_selfhosted()
        self.assertGreaterEqual(len(paths), 4, [p.name for p in paths])
        for path in paths:
            doc = yaml.safe_load(path.read_text(encoding="utf-8"))
            group = (doc.get("concurrency") or {}).get("group")
            self.assertEqual(
                group, _SELF_HOSTED_GROUP,
                f"{path.name}: self-hosted lane outside the shared workspace group",
            )
            self.assertFalse(
                (doc.get("concurrency") or {}).get("cancel-in-progress", False),
                f"{path.name}: cancel-in-progress would kill a running cycle",
            )

    def test_watchdog_checkout_is_scoped_away_from_the_store(self) -> None:
        doc = yaml.safe_load(
            (_WF / "dataflow-integrity-watchdog.yml").read_text(encoding="utf-8"),
        )
        steps = doc["jobs"]["probe"]["steps"]
        checkout = next(s for s in steps if str(s.get("uses", "")).startswith("actions/checkout"))
        self.assertEqual(
            (checkout.get("with") or {}).get("path"), "watchdog-checkout",
            "the hourly clean must never run at the workspace root again",
        )


class RematerializeDisclosureTests(unittest.TestCase):
    def test_registered_but_missing_store_discloses_on_restore(self) -> None:
        # Reuses the state-store test harness (offline remote + derived
        # bootstrap ack) rather than re-inventing the fixture shape.
        from tests.test_state_store import REPO_HASH, StateStoreTestCase
        from aria_kernel.state_store import checkout_state_store, publish_state

        harness = StateStoreTestCase("run")
        harness.setUp()
        try:
            store = harness._bootstrap()
            harness._seed_surface(store, "")
            publish_state(
                store,
                snapshot=harness._snapshot(store, "z1-snap-1"),
                cycle_id="cycle-z1",
                repo_hash=REPO_HASH,
            )
            import shutil

            shutil.rmtree(store.root)  # the wipe: dir gone, worktree registered
            restored = checkout_state_store(
                harness.repo, store_dir=store.root,
            )
            gov = restored.root / "tools" / "governance.jsonl"
            self.assertTrue(gov.exists(), "disclosure row missing entirely")
            kinds = [
                json.loads(l)["kind"]
                for l in gov.read_text(encoding="utf-8").splitlines() if l.strip()
            ]
            self.assertIn("state_store_rematerialized_after_missing", kinds)
        finally:
            harness.doCleanups()


if __name__ == "__main__":
    unittest.main()
