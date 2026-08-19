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

# ORPHAN-713 — the exemption is EARNED structurally, not declared: a GitHub
# concurrency group holds ONE pending slot and an arriving run evicts the
# queued one, so the hourly watchdog inside the shared group cancelled the
# queued nightly executor three times on 2026-08-18. It may leave the group
# ONLY because its checkout is scoped to a subdirectory (verified below) —
# its clean can never reach the store, and a read-only probe needs no
# workspace serialization beyond the runner itself.
_PATH_ISOLATED_EXEMPT = {
    "dataflow-integrity-watchdog.yml",
    # ORPHAN-HIGH-736 — the report lane joined the self-hosted runner for
    # its PAT identity alone (a PR opened with the job token parks every
    # check in action_required). It touches ARIA's state not at all, so it
    # checks out into `report-checkout/` and keeps its own group: taking a
    # slot in the shared group would let a two-minute report evict a queued
    # drain, which is the harm ORPHAN-713 removed for the watchdog.
    "aria-daily-report.yml",
}


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
            if path.name in _PATH_ISOLATED_EXEMPT:
                self.assertNotEqual(
                    group, _SELF_HOSTED_GROUP,
                    f"{path.name}: exempt lane must not occupy the shared "
                    "group's single pending slot (it evicts queued lanes)",
                )
                self.assertTrue(
                    group,
                    f"{path.name}: exempt lane still needs its own group",
                )
            else:
                self.assertEqual(
                    group, _SELF_HOSTED_GROUP,
                    f"{path.name}: self-hosted lane outside the shared workspace group",
                )
            self.assertFalse(
                (doc.get("concurrency") or {}).get("cancel-in-progress", False),
                f"{path.name}: cancel-in-progress would kill a running cycle",
            )

    def test_exempt_lanes_earned_it_with_a_scoped_checkout(self) -> None:
        """The exemption is earned by the jobs that can actually reach the store.

        The property being protected is that a lane outside the shared
        group never checks out — and therefore never cleans — at the
        persistent workspace root. That is reachable ONLY from the
        self-hosted runner: a github-hosted job gets a fresh VM, so its
        unscoped checkout cannot touch ARIA's state. Scoping the check to
        self-hosted jobs is what the rule always meant; requiring it of
        every job would have forced a hosted job to adopt a subdirectory
        for a danger it structurally does not have (ORPHAN-HIGH-736 —
        the report lane's read-only generate job).
        """
        checked = 0
        for name in _PATH_ISOLATED_EXEMPT:
            doc = yaml.safe_load((_WF / name).read_text(encoding="utf-8"))
            for job_name, job in (doc.get("jobs") or {}).items():
                runs_on = job.get("runs-on")
                if not (isinstance(runs_on, list) and "self-hosted" in runs_on):
                    continue
                for step in job.get("steps") or []:
                    if str(step.get("uses", "")).startswith("actions/checkout"):
                        checked += 1
                        self.assertTrue(
                            (step.get("with") or {}).get("path"),
                            f"{name}:{job_name}: group exemption requires a "
                            "subdirectory checkout — an unscoped clean could "
                            "wipe the store",
                        )
        self.assertGreater(
            checked, 0,
            "every exempt lane must have a self-hosted checkout to scope; "
            "an exemption with nothing to earn it is a hole",
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
