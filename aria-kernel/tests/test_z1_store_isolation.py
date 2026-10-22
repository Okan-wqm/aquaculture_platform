"""Z1 (ORPHAN-712) — the state store survives its neighbors.

Measured 2026-08-17: the hourly dataflow watchdog's default checkout ran
`git clean -ffdx` at the shared self-hosted workspace root and swept the
untracked, gitignored `.aria-state-store` between runs; a deleted store
bypassed `_clear_existing_store`'s unpublished-work refusal entirely, so
the loss was SILENT. Today a single-slot runner is the only thing
serializing the four self-hosted lanes — an accident of runner count, not
a property of the repo.

ARIA-MEDIUM-277 moved the serialization OFF the shared concurrency group
(a GitHub group holds ONE pending slot and an arriving run evicts the
queued one, so the shared group let each lane's dispatch silently cancel
another lane's pending run) and ONTO the host workspace lock: a flock on
the workspace directory, held for the job's lifetime by
.github/actions/selfhosted-workspace-lock. The no-shared-group half of
the new rule is pinned in tests/invariants/selfhosted-lane-concurrency
.spec.ts; THIS file pins the workspace half.

Deliberate-breakage pins:
- every self-hosted job that checks out the workspace ROOT takes the host
  workspace lock first and releases it last under `if: always()` (adding
  a second runner service can never reopen the mid-run wipe window);
- the lanes exempt from the lock earn it with a subdirectory checkout
  (their clean can never touch the store path again);
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

_LOCK_ACTION = "./.github/actions/selfhosted-workspace-lock"

# ORPHAN-713 — the exemption is EARNED structurally, not declared: a GitHub
# concurrency group holds ONE pending slot and an arriving run evicts the
# queued one, so the hourly watchdog inside the shared group cancelled the
# queued nightly executor three times on 2026-08-18. It may skip the
# workspace lock ONLY because its checkout is scoped to a subdirectory
# (verified below) — its clean can never reach the store, and a read-only
# probe needs no workspace serialization beyond the runner itself.
_PATH_ISOLATED_EXEMPT = {
    "dataflow-integrity-watchdog.yml",
    # ORPHAN-HIGH-736 — the report lane joined the self-hosted runner for
    # its PAT identity alone (a PR opened with the job token parks every
    # check in action_required). It touches ARIA's state not at all, so it
    # checks out into `report-checkout/` and keeps its own group: taking a
    # slot in another lane's group would let a two-minute report evict a
    # queued drain, which is the harm ORPHAN-713 removed for the watchdog.
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


def _selfhosted_jobs(doc: dict) -> list[tuple[str, dict]]:
    return [
        (name, job)
        for name, job in (doc.get("jobs") or {}).items()
        if isinstance(job.get("runs-on"), list)
        and "self-hosted" in job["runs-on"]
    ]


def _checkouts_at_workspace_root(job: dict) -> bool:
    """A checkout without `path` cleans at the persistent workspace root."""
    for step in job.get("steps") or []:
        if str(step.get("uses", "")).startswith("actions/checkout"):
            if not (step.get("with") or {}).get("path"):
                return True
    return False


class SharedWorkspaceLockPins(unittest.TestCase):
    def test_root_checkout_jobs_take_the_workspace_lock_first(self) -> None:
        paths = _workflows_with_selfhosted()
        self.assertGreaterEqual(len(paths), 4, [p.name for p in paths])
        checked = 0
        for path in paths:
            doc = yaml.safe_load(path.read_text(encoding="utf-8"))
            for job_name, job in _selfhosted_jobs(doc):
                if not _checkouts_at_workspace_root(job):
                    continue
                checked += 1
                steps = job.get("steps") or []
                first = steps[0] if steps else {}
                self.assertEqual(
                    str(first.get("uses", "")), _LOCK_ACTION,
                    f"{path.name}:{job_name}: a job that checks out the "
                    "workspace root must take the host workspace lock as "
                    "its FIRST step (ARIA-MEDIUM-277) — the reset and the "
                    "checkout below it are the wipe vectors",
                )
                self.assertNotEqual(
                    (first.get("with") or {}).get("mode"), "release",
                    f"{path.name}:{job_name}: the first lock step must be "
                    "the acquire",
                )
                self.assertNotIn(
                    "if", first,
                    f"{path.name}:{job_name}: the acquire must run "
                    "unconditionally",
                )
                last = steps[-1] if steps else {}
                self.assertEqual(
                    str(last.get("uses", "")), _LOCK_ACTION,
                    f"{path.name}:{job_name}: the lock must be released by "
                    "the job's LAST step",
                )
                self.assertEqual(
                    (last.get("with") or {}).get("mode"), "release",
                    f"{path.name}:{job_name}: the last lock step must be "
                    "the release",
                )
                self.assertIn(
                    "always()", str(last.get("if", "")),
                    f"{path.name}:{job_name}: the release must run even "
                    "when the job failed, or one red lane starves them all",
                )
        self.assertGreaterEqual(
            checked, 3,
            "the cycle, the executor and the capability probe must be "
            "among the lock takers",
        )

    def test_every_selfhosted_workflow_declares_its_own_group(self) -> None:
        for path in _workflows_with_selfhosted():
            doc = yaml.safe_load(path.read_text(encoding="utf-8"))
            concurrency = doc.get("concurrency") or {}
            self.assertTrue(
                concurrency.get("group"),
                f"{path.name}: a self-hosted lane still needs a concurrency "
                "group (its own duplicate is the one eviction it may take)",
            )
            self.assertFalse(
                concurrency.get("cancel-in-progress", False),
                f"{path.name}: cancel-in-progress would kill a running cycle",
            )

    def test_exempt_lanes_earned_it_with_a_scoped_checkout(self) -> None:
        """The exemption is earned by the jobs that can actually reach the store.

        The property being protected is that a lane without the workspace
        lock never checks out — and therefore never cleans — at the
        persistent workspace root. That is reachable ONLY from the
        self-hosted runner: a github-hosted job gets a fresh VM, so its
        unscoped checkout cannot touch ARIA's state. Scoping the check to
        self-hosted jobs is what the rule always meant; requiring it of
        every job would have forced a hosted job to adopt a subdirectory
        for a danger it structurally does not have (ORPHAN-HIGH-736 — the
        report lane's read-only generate job).
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
                            f"{name}:{job_name}: the lock exemption requires "
                            "a subdirectory checkout — an unscoped clean "
                            "could wipe the store",
                        )
        self.assertGreater(
            checked, 0,
            "every exempt lane must have a self-hosted checkout to scope; "
            "an exemption with nothing to earn it is a hole",
        )

    def test_scoped_checkout_jobs_preflight_their_own_checkout(self) -> None:
        """ARIA-MEDIUM-251 — a job that checks out into a subdirectory writes
        that subdirectory, so its enterprise preflight must judge it.

        aria-daily-report's commit-report job rooted the preflight at
        GITHUB_WORKSPACE: on the self-hosted runner that is the shared ARIA
        workspace, where its own `report-checkout/` and the watchdog's
        `watchdog-checkout/` are untracked directories, so the clean-worktree
        check refused every run from 2026-08-20 on. The scoped checkout that
        earns the group exemption above is the same thing that makes the
        workspace root the wrong tree to judge.
        """
        checked = 0
        for path in _workflows_with_selfhosted():
            doc = yaml.safe_load(path.read_text(encoding="utf-8"))
            for job_name, job in (doc.get("jobs") or {}).items():
                runs_on = job.get("runs-on")
                if not (isinstance(runs_on, list) and "self-hosted" in runs_on):
                    continue
                steps = job.get("steps") or []
                checkout_paths = {
                    (s.get("with") or {}).get("path")
                    for s in steps
                    if str(s.get("uses", "")).startswith("actions/checkout")
                }
                checkout_paths.discard(None)
                if not checkout_paths:
                    continue
                for step in steps:
                    run = str(step.get("run") or "")
                    if "verify_workflow_preflight(" not in run:
                        continue
                    checked += 1
                    where = f"{path.name}:{job_name}:{step.get('name')}"
                    self.assertIn(
                        step.get("working-directory"), checkout_paths,
                        f"{where}: preflight must run inside the job's own checkout",
                    )
                    self.assertNotIn(
                        'workspace_root=os.environ["GITHUB_WORKSPACE"]', run,
                        f"{where}: GITHUB_WORKSPACE is the shared runner workspace, "
                        "not the tree this job writes",
                    )
                    self.assertIn("workspace_root=os.getcwd()", run, where)
        self.assertGreater(
            checked, 0,
            "aria-daily-report's commit-report preflight must be among the checked steps",
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


class BranchWritingConcurrencyPins(unittest.TestCase):
    """ORPHAN-MEDIUM-770 — the BRANCH hazard, sibling to the disk rule above.

    The shared-group rule above protects the local state-store DISK and is
    scoped to self-hosted lanes on purpose (its own docstring explains why a
    hosted job is structurally outside it). But a lane that FF-pushes the
    aria/state LEDGER — hosted or self-hosted — has a second hazard the disk
    rule never covered: two concurrent writers waste a run at best (the
    server rejects one CAS) and interleave restores at worst. The rule was
    written about disks, not branches; this is the branch rule.
    """

    def test_every_state_publishing_lane_declares_a_concurrency_group(self) -> None:
        publishers = []
        for path in sorted(_WF.glob("*.yml")):
            text = path.read_text(encoding="utf-8")
            if "state publish" not in text:
                continue
            publishers.append(path)
        self.assertGreaterEqual(len(publishers), 3, [p.name for p in publishers])
        for path in publishers:
            doc = yaml.safe_load(path.read_text(encoding="utf-8"))
            group = (doc.get("concurrency") or {}).get("group")
            self.assertTrue(
                group,
                f"{path.name}: publishes aria/state but declares no concurrency group",
            )
            self.assertFalse(
                (doc.get("concurrency") or {}).get("cancel-in-progress", False),
                f"{path.name}: cancel-in-progress would kill a run mid-publish",
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
                store, writer_fence=None,
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
