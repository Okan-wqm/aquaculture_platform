"""ARIA-HIGH-342 — aria/state has exactly one writer at a time.

Measured on 2026-10-04, twice in one day: a long self-hosted job restored the
store, worked for hours, and lost everything at its final ``state publish``
because a short lane (aria-agent-eval; an operator-lane publish) had moved the
branch in between. The loser's contention replay refused with
``replay_materialization_budget_exceeded`` and the job exited 3.

These tests drive real git repositories against a bare remote, because the
property under test is a remote one: which writer the server lets advance the
branch, and whether the other one finds out before or after its work.

Three defects, one fixture each:

* SERIALIZATION. Nothing made the lanes take turns. A writer now holds the
  aria/state writer lease (``aria/state-lease``) from before its restore to
  after its publish; ``state publish`` refuses without it, and another writer
  waits with a bound and then yields by name.
* THE RECONCILIATION IS NOT A SUBSTITUTE FOR TURNS. The replay that runs after
  a lost race refuses over its admission bound at today's ledger sizes (kept:
  it is the OOM guard on a whole-file parse), and below the bound it carried
  only ledger and index surfaces while reporting ``published: true`` — a
  loser's agent output artifact vanished. It now refuses instead.
* CONTINUITY SCOPE. An observe burn-in runs its cycles against a RUNNER_TEMP
  tools root outside the workspace, yet the continuity phase judged the REAL
  store and called the foreign publish amnesia, aborting every cycle.
"""

from __future__ import annotations

import ast
import contextlib
import io
import json
import os
import subprocess
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

import yaml

from aria_kernel import state_store
from aria_kernel.cli import main as cli_main
from aria_kernel.ledger import append_declared_jsonl_rows, read_jsonl
from aria_kernel.state_store import (
    BOOTSTRAP_ACK_ENV,
    StateStoreRefusal,
    checkout_state_store,
    publish_with_contention_replay,
    tools_root,
)
from aria_kernel.tools_binding import bind_tools_root

from tests._helpers.declared_fixtures import append_declared_fixture

REPO_HASH = "repohash0342"
KERNEL_ROOT = Path(__file__).resolve().parents[1]
REPO_ROOT = KERNEL_ROOT.parent
WORKFLOWS = REPO_ROOT / ".github" / "workflows"


def _git(cwd: Path, *args: str) -> str:
    return subprocess.run(
        ["git", "-C", str(cwd), *args],
        capture_output=True,
        text=True,
        check=True,
        env={key: value for key, value in os.environ.items() if not key.startswith("GIT_DIR")},
    ).stdout


class _TwoWriters(unittest.TestCase):
    """A bare remote and two clones of it: the long job and the short lane."""

    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.base = Path(self._tmp.name)
        # A spec once rewrote the shared .git/config from inside a hook: no
        # GIT_* location variable reaches any git this fixture spawns.
        stripped = {
            key: value for key, value in os.environ.items()
            if key.startswith("GIT_") and not key.startswith("GIT_CONFIG_")
        }
        patcher = mock.patch.dict(os.environ, {}, clear=False)
        patcher.start()
        self.addCleanup(patcher.stop)
        for key in stripped:
            os.environ.pop(key, None)
        os.environ.pop("ARIA_STATE_WRITER_LEASE_ID", None)

        self.remote = self.base / "remote.git"
        self.remote.mkdir()
        _git(self.remote, "init", "--bare", "--initial-branch=main", ".")
        self.repo_long = self._clone("long-job", seed=True)
        os.environ[BOOTSTRAP_ACK_ENV] = state_store._repository_identity(self.repo_long)
        self.repo_short = self._clone("short-lane", seed=False)

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

    def _store(self, repo: Path):
        return checkout_state_store(repo, store_dir=repo / ".aria-state-store")

    @staticmethod
    def _bind(store) -> Path:
        root = tools_root(store)
        root.mkdir(parents=True, exist_ok=True)
        if not (root / "repo_identity.json").exists():
            bind_tools_root(
                tools_dir=root,
                workspace_root=store.repo_root,
                reason="bind the fixture store as this writer's tools root",
            )
        return root

    def _append(self, store, cycle_id: str) -> None:
        append_declared_fixture(
            self._bind(store) / "cycles.jsonl",
            {"schema_version": 2, "cycle_id": cycle_id, "event": "started"},
            expected_surface="cycles",
        )

    def _seed_ledger_over_the_bound(self, store) -> int:
        """A ledger sized like today's: the replay's admission bound is 16 x
        (loser + winner) whole-file bytes against 256 MiB, so two copies of a
        9 MiB ledger already exceed it (raw_findings was ~24 MB)."""
        rows = [
            {"schema_version": 1, "event": "health_observed", "index": index, "pad": "x" * 30_000}
            for index in range(310)
        ]
        path = self._bind(store) / "health.jsonl"
        append_declared_jsonl_rows(
            path, rows, expected_surface="health", bypass_profile_gate=True,
        )
        size = path.stat().st_size
        bound = state_store._MAX_REPLAY_MATERIALIZATION_BYTES
        self.assertGreater(
            2 * size * state_store._REPLAY_MATERIALIZATION_MULTIPLIER,
            bound,
            "the fixture must reproduce the measured scale, not a shrunken bound",
        )
        return size

    @staticmethod
    def _publish_direct(store, snapshot_id: str) -> dict:
        return publish_with_contention_replay(
            store,
            snapshot_id=snapshot_id,
            cycle_id=snapshot_id,
            lane="test",
            repo_hash=REPO_HASH,
        )

    @staticmethod
    def _cli(argv: list[str]) -> tuple[int, dict]:
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            code = cli_main(argv)
        text = out.getvalue()
        start = text.find("{")
        return code, (json.loads(text[start:]) if start >= 0 else {})

    def _acquire(self, repo: Path, *, ttl: int = 30, wait: int = 0, owner: str | None = None):
        argv = [
            "state", "lease", "acquire", "--repo-root", str(repo),
            "--ttl-minutes", str(ttl), "--wait-seconds", str(wait), "--poll-seconds", "1",
        ]
        if owner:
            argv += ["--owner", owner]
        return self._cli(argv)

    def _cli_publish(self, repo: Path, snapshot_id: str, *, lease_id: str | None) -> tuple[int, dict]:
        env = {"ARIA_STATE_WRITER_LEASE_ID": lease_id} if lease_id else {}
        with mock.patch.dict(os.environ, env):
            if not lease_id:
                os.environ.pop("ARIA_STATE_WRITER_LEASE_ID", None)
            return self._cli([
                "state", "publish", "--repo-root", str(repo), "--repo-hash", REPO_HASH,
                "--snapshot-id", snapshot_id, "--cycle-id", snapshot_id,
            ])

    def _remote_cycle_ids(self, repo: Path) -> list[str]:
        _git(repo, "fetch", "origin", "aria/state")
        blob = _git(repo, "show", "FETCH_HEAD:tools/cycles.jsonl")
        return [json.loads(line)["cycle_id"] for line in blob.splitlines() if line.strip()]


class MeasuredDefectReproduction(_TwoWriters):
    """The 2026-10-04 shape, at the measured ledger scale."""

    def _published_base_over_the_bound(self) -> None:
        seed = self._store(self.repo_long)
        self._append(seed, "seed")
        self._seed_ledger_over_the_bound(seed)
        self.assertTrue(self._publish_direct(seed, "snap-seed")["published"])

    def test_without_turns_a_foreign_publish_costs_the_long_job_its_work(self) -> None:
        """The replay's bound is a deliberate OOM guard, not the defect: it
        refuses to parse two whole ledgers this size in memory. What made the
        refusal reachable is that two writers were allowed to interleave."""
        self._published_base_over_the_bound()
        long_job = self._store(self.repo_long)
        short_lane = self._store(self.repo_short)
        self._append(long_job, "long-job-work")
        self._append(short_lane, "short-lane-row")
        self.assertTrue(self._publish_direct(short_lane, "agent-eval")["published"])

        with self.assertRaisesRegex(StateStoreRefusal, "replay_materialization_budget_exceeded"):
            self._publish_direct(long_job, "executor-final")
        self.assertNotIn("long-job-work", self._remote_cycle_ids(self.repo_long))

    def test_with_the_writer_lease_the_short_lane_yields_and_the_long_job_publishes(self) -> None:
        self._published_base_over_the_bound()
        code, held = self._acquire(self.repo_long, ttl=510)
        self.assertEqual(code, 0, held)
        long_job = self._store(self.repo_long)
        self._append(long_job, "long-job-work")

        # The short lane is told who holds the branch and until when — and is
        # never given a store to work on.
        code, yielded = self._acquire(self.repo_short, ttl=25, wait=2)
        self.assertEqual(code, 3, yielded)
        self.assertFalse(yielded["held"])
        self.assertEqual(yielded["holder"]["lease_id"], held["lease_id"])
        self.assertIn("expires_at", yielded["holder"])
        # Publishing without a lease of its own is refused outright.
        short_lane = self._store(self.repo_short)
        self._append(short_lane, "short-lane-row")
        code, refused = self._cli_publish(self.repo_short, "agent-eval", lease_id=None)
        self.assertEqual(code, 3)
        self.assertIn("state_writer_lease_required", refused["refusal"])
        code, refused = self._cli_publish(self.repo_short, "agent-eval", lease_id=held["lease_id"] + "0")
        self.assertEqual(code, 3)
        self.assertIn("state_writer_lease_not_held", refused["refusal"])

        code, result = self._cli_publish(self.repo_long, "executor-final", lease_id=held["lease_id"])
        self.assertEqual(code, 0, result)
        self.assertTrue(result["published"])
        self.assertEqual(result["attempts"], 1, "no race, so no replay")
        self.assertIn("long-job-work", self._remote_cycle_ids(self.repo_long))


class WriterLeaseTransport(_TwoWriters):
    def test_acquire_records_holder_run_and_expiry_on_the_lease_branch(self) -> None:
        from aria_kernel.state_writer_lease import read_writer_lease, writer_lease_branch

        with mock.patch.dict(os.environ, {"GITHUB_RUN_ID": "37192561282", "GITHUB_RUN_ATTEMPT": "1",
                                          "GITHUB_WORKFLOW": "aria-agent-executor", "GITHUB_JOB": "executor"}):
            code, held = self._acquire(self.repo_long, ttl=510)
        self.assertEqual(code, 0, held)
        self.assertEqual(writer_lease_branch("aria/state"), "aria/state-lease")
        view = read_writer_lease(self.repo_short)
        self.assertEqual(view.lease.lease_id, held["lease_id"])
        self.assertEqual(view.run_id, "37192561282")
        self.assertIn("run=37192561282", view.lease.owner)
        self.assertEqual(view.lease.target_ref, "refs/heads/aria/state")
        expires = datetime.fromisoformat(view.lease.expires_at.replace("Z", "+00:00"))
        self.assertGreater(expires - datetime.now(timezone.utc), timedelta(minutes=500))
        self.assertTrue(view.is_held())

    def test_a_released_lease_is_taken_by_the_waiter_with_a_higher_epoch(self) -> None:
        from aria_kernel.state_writer_lease import acquire_writer_lease, release_writer_lease

        first = acquire_writer_lease(self.repo_long, ttl_minutes=30, owner="lane-a")
        released: list[dict] = []

        def release_while_waiting(_seconds: float) -> None:
            if not released:
                released.append(release_writer_lease(self.repo_long, lease_id=first.lease_id))

        second = acquire_writer_lease(
            self.repo_short, ttl_minutes=30, owner="lane-b", wait_seconds=60, poll_seconds=1,
            sleep=release_while_waiting,
        )
        self.assertTrue(released[0]["released"])
        self.assertEqual(second.owner, "lane-b")
        self.assertGreater(second.epoch, first.epoch)

    def test_the_wait_is_bounded_and_names_the_holder(self) -> None:
        from aria_kernel.state_writer_lease import StateWriterLeaseBlocked, acquire_writer_lease

        acquire_writer_lease(self.repo_long, ttl_minutes=30, owner="long-job")
        clock = [0.0]

        def advance(seconds: float) -> None:
            clock[0] += seconds

        with self.assertRaises(StateWriterLeaseBlocked) as caught:
            acquire_writer_lease(
                self.repo_short, ttl_minutes=15, owner="short-lane", wait_seconds=30,
                poll_seconds=10, monotonic=lambda: clock[0], sleep=advance,
            )
        self.assertIn("state_writer_lease_held", str(caught.exception))
        self.assertIn("long-job", str(caught.exception))
        self.assertGreaterEqual(caught.exception.waited_seconds, 30)

    def test_an_expired_lease_is_reaped(self) -> None:
        from aria_kernel.state_writer_lease import acquire_writer_lease

        first = acquire_writer_lease(self.repo_long, ttl_minutes=1, owner="dead-runner")
        later = datetime.now(timezone.utc) + timedelta(minutes=5)
        second = acquire_writer_lease(
            self.repo_short, ttl_minutes=15, owner="next-lane", now=lambda: later,
        )
        self.assertEqual(second.epoch, first.epoch + 1)

    def test_two_writers_racing_from_one_lease_tip_cannot_both_hold_it(self) -> None:
        """The push to aria/state-lease is fast-forward-only: it IS the CAS."""
        from aria_kernel import state_writer_lease as module

        real_read = module.read_writer_lease
        stale = real_read(self.repo_short)  # no lease yet
        module.acquire_writer_lease(self.repo_long, ttl_minutes=30, owner="winner")
        calls = [0]

        def read_once_stale(*args, **kwargs):
            calls[0] += 1
            return stale if calls[0] == 1 else real_read(*args, **kwargs)

        with mock.patch.object(module, "read_writer_lease", side_effect=read_once_stale):
            with self.assertRaises(module.StateWriterLeaseBlocked):
                module.acquire_writer_lease(self.repo_short, ttl_minutes=30, owner="loser")
        self.assertEqual(real_read(self.repo_long).lease.owner, "winner")

    def test_the_operator_lane_is_refused_while_a_job_holds_the_lease(self) -> None:
        self._acquire(self.repo_long, ttl=360, owner="gha:aria-auto-cycle:cycle:run=37178472968:attempt=1")
        code, verdict = self._acquire(self.repo_short, ttl=30, owner="local:operator")
        self.assertEqual(code, 3)
        self.assertIn("aria-auto-cycle", verdict["refusal"])


class ReplayRefusesWhatItCannotCarry(_TwoWriters):
    def test_a_losers_artifact_is_refused_not_silently_dropped(self) -> None:
        """Below the bound the replay used to succeed — and the loser's agent
        output (a declared ``artifact`` surface) was gone from disk and from
        the branch while the publish reported ``published: true``."""
        seed = self._store(self.repo_long)
        self._append(seed, "seed")
        self._publish_direct(seed, "snap-seed")
        loser = self._store(self.repo_long)
        winner = self._store(self.repo_short)
        self._append(loser, "loser-row")
        artifact = tools_root(loser) / "agent-invocations/outputs/plan/round-1-challenger-x.md"
        artifact.parent.mkdir(parents=True, exist_ok=True)
        artifact.write_text("# the first live plan's challenger\n", encoding="utf-8")
        self._append(winner, "winner-row")
        self.assertTrue(self._publish_direct(winner, "winner")["published"])

        with self.assertRaisesRegex(StateStoreRefusal, "replay_unreplayable_surface_changed"):
            self._publish_direct(loser, "loser")
        self.assertTrue(artifact.is_file(), "the refused loser keeps its bytes on disk")
        self.assertIn("loser-row", [row["cycle_id"] for row in read_jsonl(tools_root(loser) / "cycles.jsonl")])


class ObserveBurnInContinuityScope(_TwoWriters):
    """Burn-in run 37178472968: every observe cycle after 06:19Z aborted."""

    def _store_behind_a_foreign_publish(self):
        store = self._store(self.repo_long)
        self._append(store, "seed")
        self._publish_direct(store, "snap-seed")
        store = self._store(self.repo_long)
        foreign = self._store(self.repo_short)
        self._append(foreign, "operator-lane")
        self._publish_direct(foreign, "operator")
        return store

    def _phase(self, base_dir: Path) -> dict:
        from aria_kernel.cycle import _phase_state_continuity

        context = SimpleNamespace(
            cycle_id="burnin-observe-20261004T062000Z-001",
            mode="burn_in",
            workspace_root=str(self.repo_long),
            base_dir=str(base_dir),
        )
        with mock.patch("aria_kernel.workspace.canonical_identity", return_value=REPO_HASH):
            return _phase_state_continuity(context)

    def test_a_detached_tools_root_is_not_judged_against_the_store(self) -> None:
        self._store_behind_a_foreign_publish()
        with tempfile.TemporaryDirectory(prefix="aria-burn-tools.") as burn_tools:
            verdict = self._phase(Path(burn_tools))
        self.assertFalse(verdict["blocks_action"], verdict)
        self.assertIn("tools_root_detached_from_state_store", verdict["notes"])

    def test_the_store_bound_cycle_still_sees_the_foreign_publish(self) -> None:
        store = self._store_behind_a_foreign_publish()
        verdict = self._phase(tools_root(store))
        self.assertTrue(verdict["blocks_action"], verdict)
        self.assertTrue(
            any(reason.startswith("state_continuity_store_not_at_tip") for reason in verdict["reasons"]),
            verdict,
        )


class EveryWriterTakesTurns(unittest.TestCase):
    """Tier 3 behind the runtime refusal: no lane can be written without the lease."""

    def test_every_kernel_publisher_verifies_the_lease_first(self) -> None:
        package = KERNEL_ROOT / "aria_kernel"
        callers: list[str] = []
        for path in sorted(package.rglob("*.py")):
            if path.name == "state_store.py":
                continue
            tree = ast.parse(path.read_text(encoding="utf-8"))
            for function in ast.walk(tree):
                if not isinstance(function, (ast.FunctionDef, ast.AsyncFunctionDef)):
                    continue
                names = {
                    node.func.id if isinstance(node.func, ast.Name) else getattr(node.func, "attr", "")
                    for node in ast.walk(function)
                    if isinstance(node, ast.Call)
                }
                if "publish_with_contention_replay" in names:
                    callers.append(f"{path.name}:{function.name}")
                    self.assertIn(
                        "require_held_writer_lease", names,
                        f"{path.name}:{function.name} publishes aria/state without the writer lease",
                    )
        self.assertGreaterEqual(len(callers), 2, callers)

    def test_every_publishing_workflow_holds_the_lease_for_its_whole_job(self) -> None:
        publishing = 0
        for path in sorted(WORKFLOWS.glob("*.yml")):
            workflow = yaml.safe_load(path.read_text(encoding="utf-8"))
            for job_id, job in (workflow.get("jobs") or {}).items():
                steps = job.get("steps") or []
                runs = [str(step.get("run") or "") for step in steps]
                if not any("aria_kernel state publish" in run for run in runs):
                    continue
                publishing += 1
                label = f"{path.name}:{job_id}"
                restores = [
                    (index, step) for index, step in enumerate(steps)
                    if step.get("uses") == "./.github/actions/restore-aria-state"
                ]
                self.assertEqual(len(restores), 1, label)
                restore_index, restore = restores[0]
                ttl = str((restore.get("with") or {}).get("writer-lease-ttl-minutes") or "")
                self.assertEqual(ttl, str(job.get("timeout-minutes")), f"{label}: TTL must be the job bound")
                last_publish = max(i for i, run in enumerate(runs) if "aria_kernel state publish" in run)
                releases = [
                    index for index, step in enumerate(steps)
                    if step.get("uses") == "./.github/actions/release-aria-state-lease"
                    and index > last_publish
                    and "always()" in str(step.get("if") or "")
                ]
                self.assertTrue(releases, f"{label}: no always() release after the last publish")
                self.assertEqual(restore.get("id"), "restore_state", label)
                # A yielded restore checks nothing out, so every later step
                # that runs the kernel against the store must be closed by a
                # gate the yield closes: the held output itself, the
                # restore proof, or the abort gate the yield trips.
                for step in steps[restore_index + 1:]:
                    if "aria_kernel" not in str(step.get("run") or ""):
                        continue
                    condition = str(step.get("if") or "")
                    reads_the_yield = "steps.restore_state.outputs.writer-lease" in json.dumps(step.get("env") or {})
                    self.assertTrue(
                        reads_the_yield
                        or "steps.restore_state.outputs.writer-lease == 'held'" in condition
                        or "steps.restore_state.outputs.restored == 'true'" in condition
                        or "steps.lease_check.outputs.blocked != 'true'" in condition
                        or "steps.integrity.outputs.state_valid == 'true'" in condition,
                        f"{label}:{step.get('name')} runs the kernel when the lease was yielded",
                    )
        self.assertEqual(publishing, 6)


if __name__ == "__main__":
    unittest.main()
