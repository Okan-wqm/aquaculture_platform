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
from aria_kernel.state_writer_lease import WRITER_LEASE_TOKEN_ENV
from aria_kernel.tools_binding import bind_tools_root

from tests._helpers.declared_fixtures import append_declared_fixture
from tests._helpers.writer_lease import holding_writer_lease

REPO_HASH = "repohash0342"
KERNEL_ROOT = Path(__file__).resolve().parents[1]
REPO_ROOT = KERNEL_ROOT.parent
WORKFLOWS = REPO_ROOT / ".github" / "workflows"


# The fixture's environment keeps exactly the hermetic git configuration
# (`tests/_helpers/hermetic_git`) and nothing else git reads from outside.
_HERMETIC_GIT_VARS = ("GIT_CONFIG_GLOBAL", "GIT_CONFIG_SYSTEM")


class GitFixtureError(subprocess.CalledProcessError):
    """A fixture git command failed — with what git said, not just the code.

    CI on PR #1791 failed with only `exit status 128` from a helper fetch;
    the fatal line that named the cause was captured and dropped.
    """

    def __str__(self) -> str:
        argv = " ".join(str(part) for part in self.cmd[3:])
        return f"git {argv} exited {self.returncode}: {(self.stderr or '').strip()[:2000]}"


def _git(cwd: Path, *args: str) -> str:
    """The fixture's own git: hermetic environment, and no hooks.

    The hook-free `-c` mirrors the kernel's own runner (ARIA-HIGH-350): a
    fixture that arms failing hooks to test the kernel must not trip them
    in its own setup and assertions (`reference-transaction` aborts any
    fetch that moves a remote-tracking ref).
    """
    argv = ["git", "-C", str(cwd), "-c", "core.hooksPath=/dev/null", *args]
    proc = subprocess.run(
        argv,
        capture_output=True,
        text=True,
        env={
            key: value for key, value in os.environ.items()
            if not key.startswith("GIT_") or key in _HERMETIC_GIT_VARS
        },
    )
    if proc.returncode != 0:
        raise GitFixtureError(proc.returncode, argv, proc.stdout, proc.stderr)
    return proc.stdout


class _TwoWriters(unittest.TestCase):
    """A bare remote and two clones of it: the long job and the short lane."""

    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.base = Path(self._tmp.name)
        # A spec once rewrote the shared .git/config from inside a hook: no
        # GIT_* location variable reaches any git this fixture spawns.
        patcher = mock.patch.dict(os.environ, {}, clear=False)
        patcher.start()
        self.addCleanup(patcher.stop)
        # Hermetic, whatever the runner exports: no inherited GIT_* variable
        # (a location, a GIT_CONFIG_COUNT credential header, a namespace) and
        # a fixed HOME, so neither ~/.gitconfig nor a user hooksPath can
        # reach a fixture; the global/system config is the suite's own.
        for key in [key for key in os.environ if key.startswith("GIT_")]:
            os.environ.pop(key, None)
        from tests._helpers.hermetic_git import apply_hermetic_git_env

        apply_hermetic_git_env()
        home = self.base / "home"
        home.mkdir()
        os.environ["HOME"] = str(home)
        os.environ.pop(WRITER_LEASE_TOKEN_ENV, None)
        # Hermetic identities: a CI runner exports GITHUB_RUN_ID and friends,
        # which would give both fixture writers ONE identity. Every writer in
        # these tests names its own (`_identity`), and the CI-shaped case is
        # tested on purpose (`CiShapedIdentities`), never inherited.
        for key in [key for key in os.environ if key.startswith("GITHUB_")]:
            os.environ.pop(key, None)
        os.environ.pop("GH_TOKEN", None)
        # ARIA-HIGH-350 — the reaper asks the Actions API about a held gha:
        # lease. A fixture never reaches the network: it answers "no
        # answer" (no reap) unless a test supplies its own fake runs.
        from aria_kernel import state_writer_lease as lease_module
        from aria_kernel.state_writer_lease_runs import RunStatusUnavailable

        def no_actions_api(run_id: str, attempt: str):
            raise RunStatusUnavailable("fixture: no Actions API")

        api = mock.patch.object(lease_module, "github_run_attempt_status", side_effect=no_actions_api)
        api.start()
        self.addCleanup(api.stop)

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

    def _publish(self, store, snapshot_id: str, *, token: str | None = None) -> dict:
        """A publish the way every lane runs it: under the writer lease."""
        if token is not None:
            return publish_with_contention_replay(
                store, snapshot_id=snapshot_id, cycle_id=snapshot_id, lane="test",
                repo_hash=REPO_HASH, writer_lease_token=token,
            )
        with holding_writer_lease(store.repo_root) as held:
            return publish_with_contention_replay(
                store, snapshot_id=snapshot_id, cycle_id=snapshot_id, lane="test",
                repo_hash=REPO_HASH, writer_lease_token=held.token,
            )

    @staticmethod
    def _replay_onto_remote(store) -> dict:
        """The reconciliation the orchestrator used to run after a lost race
        (and `memory_gap.restore_and_replay` still runs): the loser's rows
        rebuilt onto the published tip."""
        from aria_kernel.state_snapshot import build_snapshot

        base_head = state_store._read_commit_ref(store.root, "HEAD")
        base = state_store.read_snapshot_at_worktree_head(store, expected_head=base_head)
        local = build_snapshot(
            snapshot_id="replay-local", cycle_id="replay-local", lane="test",
            roots=state_store.store_roots(store, REPO_HASH),
        )
        return state_store.rebase_store_onto_remote(
            store, base=base, local=local, repo_hash=REPO_HASH, expected_base=base_head,
        )

    @staticmethod
    def _cli(argv: list[str]) -> tuple[int, dict]:
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            code = cli_main(argv)
        text = out.getvalue()
        start = text.find("{")
        return code, (json.loads(text[start:]) if start >= 0 else {})

    @staticmethod
    def _identity(repo: Path, run_id: str | None = None) -> dict[str, str]:
        """An explicit GitHub-run identity for one fixture writer."""
        return {
            "GITHUB_RUN_ID": run_id or str(1000 + sum(repo.name.encode("utf-8"))),
            "GITHUB_RUN_ATTEMPT": "1",
            "GITHUB_WORKFLOW": f"fixture-{repo.name}",
            "GITHUB_JOB": "writer",
        }

    def _acquire(
        self, repo: Path, *, ttl: int = 30, wait: int = 0, identity: dict[str, str] | None = None,
    ) -> tuple[int, dict, str]:
        token_file = self.base / f"token-{repo.name}-{len(list(self.base.glob('token-*')))}"
        with mock.patch.dict(os.environ, identity or self._identity(repo)):
            code, verdict = self._cli([
                "state", "lease", "acquire", "--repo-root", str(repo),
                "--ttl-minutes", str(ttl), "--wait-seconds", str(wait), "--poll-seconds", "1",
                "--token-file", str(token_file),
            ])
        token = token_file.read_text(encoding="utf-8").strip() if token_file.exists() else ""
        return code, verdict, token

    def _cli_publish(self, repo: Path, snapshot_id: str, *, token: str | None) -> tuple[int, dict]:
        with mock.patch.dict(os.environ, {}):
            os.environ.pop(WRITER_LEASE_TOKEN_ENV, None)
            if token:
                os.environ[WRITER_LEASE_TOKEN_ENV] = token
            return self._cli([
                "state", "publish", "--repo-root", str(repo), "--repo-hash", REPO_HASH,
                "--snapshot-id", snapshot_id, "--cycle-id", snapshot_id,
            ])

    def _remote_cycle_ids(self, repo: Path) -> list[str]:
        _git(repo, "fetch", "origin", "aria/state")
        blob = _git(repo, "show", "FETCH_HEAD:tools/cycles.jsonl")
        return [json.loads(line)["cycle_id"] for line in blob.splitlines() if line.strip()]

    def _remote_tip(self, branch: str) -> str:
        return _git(self.remote, "rev-parse", f"refs/heads/{branch}").strip()


class MeasuredDefectReproduction(_TwoWriters):
    """The 2026-10-04 shape, at the measured ledger scale."""

    def _published_base_over_the_bound(self) -> None:
        seed = self._store(self.repo_long)
        self._append(seed, "seed")
        self._seed_ledger_over_the_bound(seed)
        self.assertTrue(self._publish(seed, "snap-seed")["published"])

    def test_without_turns_a_foreign_publish_costs_the_long_job_its_work(self) -> None:
        """The replay's bound is a deliberate OOM guard, not the defect: it
        refuses to parse two whole ledgers this size in memory. What made the
        refusal reachable is that two writers were allowed to interleave."""
        self._published_base_over_the_bound()
        long_job = self._store(self.repo_long)
        short_lane = self._store(self.repo_short)
        self._append(long_job, "long-job-work")
        self._append(short_lane, "short-lane-row")
        self.assertTrue(self._publish(short_lane, "agent-eval")["published"])

        with self.assertRaisesRegex(StateStoreRefusal, "replay_materialization_budget_exceeded"):
            self._replay_onto_remote(long_job)
        self.assertNotIn("long-job-work", self._remote_cycle_ids(self.repo_long))

    def test_with_the_writer_lease_the_short_lane_yields_and_the_long_job_publishes(self) -> None:
        self._published_base_over_the_bound()
        code, held, token = self._acquire(self.repo_long, ttl=545)
        self.assertEqual(code, 0, held)
        self.assertNotIn("token", held, "the capability is never printed")
        long_job = self._store(self.repo_long)
        self._append(long_job, "long-job-work")

        # The short lane is told who holds the branch and until when — and is
        # never given a store to work on.
        code, yielded, _ = self._acquire(self.repo_short, ttl=60, wait=2)
        self.assertEqual(code, 3, yielded)
        self.assertFalse(yielded["held"])
        self.assertEqual(yielded["holder"]["lease_id"], held["lease_id"])
        self.assertIn("expires_at", yielded["holder"])
        short_lane = self._store(self.repo_short)
        self._append(short_lane, "short-lane-row")
        code, refused = self._cli_publish(self.repo_short, "agent-eval", token=None)
        self.assertEqual(code, 3)
        self.assertIn("state_writer_lease_required", refused["refusal"])
        # GSEC-MEDIUM-001 — the public lease id is not a credential.
        code, refused = self._cli_publish(self.repo_short, "agent-eval", token=held["lease_id"])
        self.assertEqual(code, 3)
        self.assertIn("state_writer_lease_lost: the presented capability does not hold", refused["refusal"])

        code, result = self._cli_publish(self.repo_long, "executor-final", token=token)
        self.assertEqual(code, 0, result)
        self.assertTrue(result["published"])
        self.assertIn("long-job-work", self._remote_cycle_ids(self.repo_long))


class TheFenceIsPartOfThePush(_TwoWriters):
    """GSEC-HIGH-001 — a takeover between the lease check and the push must
    reject the whole push; contention under a lease is refused, not replayed."""

    def _seeded(self) -> None:
        seed = self._store(self.repo_long)
        self._append(seed, "seed")
        self.assertTrue(self._publish(seed, "snap-seed")["published"])

    def test_a_takeover_after_expiry_refuses_the_late_holder(self) -> None:
        from aria_kernel.state_writer_lease import acquire_writer_lease

        self._seeded()
        late = acquire_writer_lease(self.repo_long, ttl_minutes=1, owner="dead-slow-runner")
        store = self._store(self.repo_long)
        self._append(store, "late-holder-row")
        later = datetime.now(timezone.utc) + timedelta(minutes=5)
        taker = acquire_writer_lease(self.repo_short, ttl_minutes=60, owner="next-lane", now=lambda: later)
        state_before = self._remote_tip("aria/state")

        with self.assertRaisesRegex(StateStoreRefusal, "state_writer_lease_lost: .*taken over"):
            self._publish(store, "late", token=late.token)
        self.assertEqual(self._remote_tip("aria/state"), state_before)
        self.assertIn("late-holder-row", [r["cycle_id"] for r in read_jsonl(tools_root(store) / "cycles.jsonl")])
        self.assertGreater(taker.epoch, late.epoch)

    def test_a_takeover_between_the_check_and_the_push_rejects_the_whole_atomic_push(self) -> None:
        from aria_kernel import state_writer_fence
        from aria_kernel.state_writer_lease import acquire_writer_lease

        self._seeded()
        holder = acquire_writer_lease(self.repo_long, ttl_minutes=30, owner="holder")
        store = self._store(self.repo_long)
        self._append(store, "holder-row")
        state_before = self._remote_tip("aria/state")
        real_prepare = state_writer_fence.prepare_writer_fence
        stolen: list[str] = []

        def prepare_then_get_taken_over(*args, **kwargs):
            fence = real_prepare(*args, **kwargs)
            later = datetime.now(timezone.utc) + timedelta(hours=2)
            stolen.append(acquire_writer_lease(
                self.repo_short, ttl_minutes=30, owner="taker", now=lambda: later,
            ).lease_id)
            return fence

        with mock.patch.object(state_writer_fence, "prepare_writer_fence", side_effect=prepare_then_get_taken_over):
            with self.assertRaisesRegex(StateStoreRefusal, "state_writer_lease_lost"):
                self._publish(store, "holder", token=holder.token)
        self.assertEqual(self._remote_tip("aria/state"), state_before, "the state half was rejected too")
        from aria_kernel.state_writer_lease import read_writer_lease

        self.assertEqual(read_writer_lease(self.repo_long).lease.lease_id, stolen[0])
        self.assertIn("holder-row", [r["cycle_id"] for r in read_jsonl(tools_root(store) / "cycles.jsonl")])

    def test_an_expired_but_untaken_lease_is_renewed_by_cas_and_publishes(self) -> None:
        from aria_kernel import state_writer_lease as lease_module
        from aria_kernel.state_writer_lease import acquire_writer_lease, read_writer_lease

        self._seeded()
        holder = acquire_writer_lease(self.repo_long, ttl_minutes=1, owner="slow-but-alone")
        store = self._store(self.repo_long)
        self._append(store, "slow-row")
        later = datetime.now(timezone.utc) + timedelta(minutes=10)
        with mock.patch.object(lease_module, "_utc_now", return_value=later):
            result = self._publish(store, "slow", token=holder.token)
        self.assertTrue(result["published"])
        renewed = read_writer_lease(self.repo_long)
        self.assertEqual(renewed.lease.lease_id, holder.lease_id)
        self.assertGreater(renewed.seconds_left(now=later), 0)
        self.assertIn("slow-row", self._remote_cycle_ids(self.repo_long))

    def test_contention_under_a_lease_is_refused_and_never_replayed(self) -> None:
        from aria_kernel.state_writer_lease import acquire_writer_lease

        self._seeded()
        holder = acquire_writer_lease(self.repo_long, ttl_minutes=30, owner="holder")
        store = self._store(self.repo_long)
        self._append(store, "holder-row")
        # A writer that never took the lease (pre-lease code mid-rollout, or a
        # raw push) moves aria/state under the held lease.
        rogue = self._store(self.repo_short)
        self._append(rogue, "rogue-row")
        state_store.publish_state(
            rogue, writer_fence=None,
            snapshot=state_store.prepare_publishable_snapshot(
                rogue, snapshot_id="rogue", cycle_id="rogue", lane="test", repo_hash=REPO_HASH,
            ).snapshot,
            cycle_id="rogue",
            repo_hash=REPO_HASH,
        )
        with mock.patch.object(
            state_store, "rebase_store_onto_remote", side_effect=AssertionError("replayed under a lease"),
        ):
            with self.assertRaisesRegex(StateStoreRefusal, "state_writer_lease_lost: aria/state is at"):
                self._publish(store, "holder", token=holder.token)
        self.assertNotIn("holder-row", self._remote_cycle_ids(self.repo_long))
        self.assertIn("holder-row", [r["cycle_id"] for r in read_jsonl(tools_root(store) / "cycles.jsonl")])

    def test_a_push_the_server_rejects_mid_flight_is_lease_lost_not_replay(self) -> None:
        """The atomic rejection itself: the state tip moves AFTER the base
        check, so only the push can catch it — and refuses whole."""
        from aria_kernel import state_writer_fence
        from aria_kernel.state_writer_lease import acquire_writer_lease

        self._seeded()
        # Long enough that the publish needs no renewal: the lease tip below
        # must be the one the fence was built on.
        holder = acquire_writer_lease(self.repo_long, ttl_minutes=120, owner="holder")
        store = self._store(self.repo_long)
        self._append(store, "holder-row")
        rogue = self._store(self.repo_short)
        self._append(rogue, "rogue-row")
        real_prepare = state_writer_fence.prepare_writer_fence
        lease_before = self._remote_tip("aria/state-lease")

        def prepare_then_rogue_publishes(*args, **kwargs):
            fence = real_prepare(*args, **kwargs)
            state_store.publish_state(
                rogue, writer_fence=None,
                snapshot=state_store.prepare_publishable_snapshot(
                    rogue, snapshot_id="rogue", cycle_id="rogue", lane="test", repo_hash=REPO_HASH,
                ).snapshot,
                cycle_id="rogue",
                repo_hash=REPO_HASH,
            )
            return fence

        with mock.patch.object(state_writer_fence, "prepare_writer_fence", side_effect=prepare_then_rogue_publishes), \
                mock.patch.object(state_store, "rebase_store_onto_remote", side_effect=AssertionError("replayed")):
            with self.assertRaisesRegex(StateStoreRefusal, "state_writer_lease_lost: aria/state moved under"):
                self._publish(store, "holder", token=holder.token)
        self.assertEqual(self._remote_tip("aria/state-lease"), lease_before, "the fence half was rejected too")
        self.assertIn("holder-row", [r["cycle_id"] for r in read_jsonl(tools_root(store) / "cycles.jsonl")])


class WriterLeaseTransport(_TwoWriters):
    def test_acquire_records_holder_run_and_expiry_on_the_lease_branch(self) -> None:
        from aria_kernel.state_writer_lease import read_writer_lease, token_digest, writer_lease_branch

        code, held, token = self._acquire(self.repo_long, ttl=545, identity={
            "GITHUB_RUN_ID": "37192561282", "GITHUB_RUN_ATTEMPT": "1",
            "GITHUB_WORKFLOW": "aria-agent-executor", "GITHUB_JOB": "executor",
        })
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
        # GSEC-MEDIUM-001 — the branch stores the digest, never the secret.
        self.assertEqual(len(token), 64)
        self.assertEqual(view.secret_sha256, token_digest(token))
        _git(self.repo_long, "fetch", "origin", "aria/state-lease")
        self.assertNotIn(token, _git(self.repo_long, "show", "FETCH_HEAD:lease.json"))

    def test_the_cli_has_no_owner_flag(self) -> None:
        with self.assertRaises(SystemExit):
            with contextlib.redirect_stderr(io.StringIO()):
                cli_main(["state", "lease", "acquire", "--repo-root", str(self.repo_long),
                          "--ttl-minutes", "5", "--token-file", str(self.base / "t"), "--owner", "x"])

    def test_a_released_lease_is_taken_by_the_waiter_with_a_higher_epoch(self) -> None:
        from aria_kernel.state_writer_lease import acquire_writer_lease, release_writer_lease

        first = acquire_writer_lease(self.repo_long, ttl_minutes=30, owner="lane-a")
        released: list[dict] = []

        def release_while_waiting(_seconds: float) -> None:
            if not released:
                released.append(release_writer_lease(self.repo_long, token=first.token))

        second = acquire_writer_lease(
            self.repo_short, ttl_minutes=30, owner="lane-b", wait_seconds=60, poll_seconds=1,
            sleep=release_while_waiting,
        )
        self.assertTrue(released[0]["released"])
        self.assertEqual(second.owner, "lane-b")
        self.assertGreater(second.epoch, first.epoch)

    def test_a_foreign_release_needs_force_foreign_and_a_reason(self) -> None:
        from aria_kernel.state_writer_lease import acquire_writer_lease, read_writer_lease

        acquire_writer_lease(self.repo_long, ttl_minutes=30, owner="gha:aria-agent-executor:executor:run=1:attempt=1")
        code, verdict = self._cli(["state", "lease", "release", "--repo-root", str(self.repo_short)])
        self.assertEqual(code, 0)
        self.assertFalse(verdict["released"], verdict)
        self.assertEqual(verdict["reason"], "no_token")
        with self.assertRaises(SystemExit):
            with contextlib.redirect_stderr(io.StringIO()):
                cli_main(["state", "lease", "release", "--repo-root", str(self.repo_short), "--force-foreign"])
        code, verdict = self._cli([
            "state", "lease", "release", "--repo-root", str(self.repo_short),
            "--force-foreign", "--reason", "runner died at 13:24Z",
        ])
        self.assertTrue(verdict["released"], verdict)
        view = read_writer_lease(self.repo_long)
        self.assertTrue(view.released)
        self.assertIn("runner died at 13:24Z", view.release_reason)

    def test_a_release_without_the_token_releases_nothing(self) -> None:
        """No identity fallback (R-2): the run's identity is public, so a
        release without the token leaves the lease to its holder or expiry."""
        from aria_kernel.state_writer_lease import read_writer_lease

        identity = self._identity(self.repo_long, run_id="7")
        code, held, token = self._acquire(self.repo_long, ttl=30, identity=identity)
        with mock.patch.dict(os.environ, identity):
            code, verdict = self._cli(["state", "lease", "release", "--repo-root", str(self.repo_long)])
        self.assertFalse(verdict["released"], verdict)
        self.assertEqual(verdict["reason"], "no_token")
        self.assertTrue(read_writer_lease(self.repo_long).is_held())
        with mock.patch.dict(os.environ, {WRITER_LEASE_TOKEN_ENV: token}):
            code, verdict = self._cli(["state", "lease", "release", "--repo-root", str(self.repo_long)])
        self.assertTrue(verdict["released"], verdict)
        with mock.patch.dict(os.environ, {WRITER_LEASE_TOKEN_ENV: token}):
            code, verdict = self._cli(["state", "lease", "release", "--repo-root", str(self.repo_long)])
        self.assertEqual(verdict["reason"], "already_released")

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
        from aria_kernel.state_writer_lease import acquire_writer_lease

        acquire_writer_lease(self.repo_long, ttl_minutes=390, owner="gha:aria-auto-cycle:cycle:run=37178472968:attempt=1")
        code, verdict, _ = self._acquire(self.repo_short, ttl=30)
        self.assertEqual(code, 3)
        self.assertIn("aria-auto-cycle", verdict["refusal"])


class AWedgedLeaseIsRepairedNotHandEdited(_TwoWriters):
    """GSEC-HIGH-002 — the audited way out of a record nobody can parse."""

    def _wedge(self) -> None:
        from aria_kernel.state_writer_lease import lease_commit

        commit = lease_commit(self.repo_long, parent=None, record={"schema": "garbage"}, message="wedge")
        _git(self.repo_long, "push", "origin", f"{commit}:refs/heads/aria/state-lease")

    def test_a_malformed_record_fails_closed_and_repair_replaces_it_as_a_child(self) -> None:
        from aria_kernel.state_writer_lease import read_writer_lease

        self._wedge()
        wedged_tip = self._remote_tip("aria/state-lease")
        code, verdict, _ = self._acquire(self.repo_short, ttl=30)
        # R-1 — an unreadable record is an ERROR (exit 4) naming the repair,
        # never the yield (exit 3, a holder) that would turn every writer
        # green-and-idle for as long as the record stays broken.
        self.assertEqual(code, 4, "an unreadable lease is neither a free branch nor a holder")
        self.assertNotIn("holder", verdict)
        self.assertIn("state_writer_lease_record_invalid", verdict["error"])
        self.assertIn("state lease repair", verdict["error"])
        code, repaired = self._cli([
            "state", "lease", "repair", "--repo-root", str(self.repo_short),
            "--reason", "record overwritten by a hand edit",
        ])
        self.assertEqual(code, 0, repaired)
        self.assertTrue(repaired["repaired"])
        new_tip = self._remote_tip("aria/state-lease")
        self.assertEqual(_git(self.remote, "rev-parse", f"{new_tip}^").strip(), wedged_tip)
        view = read_writer_lease(self.repo_short)
        self.assertTrue(view.released)
        self.assertIn("record overwritten by a hand edit", view.release_reason)
        code, held, _ = self._acquire(self.repo_short, ttl=30)
        self.assertEqual(code, 0, held)

    def test_repair_refuses_a_valid_held_lease(self) -> None:
        from aria_kernel.state_writer_lease import acquire_writer_lease

        acquire_writer_lease(self.repo_long, ttl_minutes=30, owner="holder")
        code, verdict = self._cli([
            "state", "lease", "repair", "--repo-root", str(self.repo_short), "--reason", "x",
        ])
        self.assertEqual(code, 4)
        self.assertIn("state_writer_lease_repair_refused", verdict["error"])


class ReplayRefusesWhatItCannotCarry(_TwoWriters):
    def test_a_losers_artifact_is_refused_not_silently_dropped(self) -> None:
        """Below the bound the replay used to succeed — and the loser's agent
        output (a declared ``artifact`` surface) was gone from disk and from
        the branch while the publish reported ``published: true``."""
        seed = self._store(self.repo_long)
        self._append(seed, "seed")
        self._publish(seed, "snap-seed")
        loser = self._store(self.repo_long)
        winner = self._store(self.repo_short)
        self._append(loser, "loser-row")
        artifact = tools_root(loser) / "agent-invocations/outputs/plan/round-1-challenger-x.md"
        artifact.parent.mkdir(parents=True, exist_ok=True)
        artifact.write_text("# the first live plan's challenger\n", encoding="utf-8")
        self._append(winner, "winner-row")
        self.assertTrue(self._publish(winner, "winner")["published"])

        with self.assertRaisesRegex(StateStoreRefusal, "replay_unreplayable_surface_changed"):
            self._replay_onto_remote(loser)
        self.assertTrue(artifact.is_file(), "the refused loser keeps its bytes on disk")
        self.assertIn("loser-row", [row["cycle_id"] for row in read_jsonl(tools_root(loser) / "cycles.jsonl")])


class ContinuityScope(_TwoWriters):
    """Burn-in run 37178472968: every observe cycle after 06:19Z aborted."""

    def _store_behind_a_foreign_publish(self):
        store = self._store(self.repo_long)
        self._append(store, "seed")
        self._publish(store, "snap-seed")
        store = self._store(self.repo_long)
        foreign = self._store(self.repo_short)
        self._append(foreign, "operator-lane")
        self._publish(foreign, "operator")
        return store

    def _phase(self, base_dir: Path, *, mode: str, profile: str) -> dict:
        from aria_kernel.cycle import _phase_state_continuity

        context = SimpleNamespace(
            cycle_id="burnin-observe-20261004T062000Z-001",
            mode=mode,
            workspace_root=str(self.repo_long),
            base_dir=str(base_dir),
        )
        with mock.patch("aria_kernel.workspace.canonical_identity", return_value=REPO_HASH), \
                mock.patch("aria_kernel.runtime_profile.get_profile", return_value=profile):
            return _phase_state_continuity(context)

    def test_an_observe_burn_in_root_is_not_judged_against_the_store(self) -> None:
        self._store_behind_a_foreign_publish()
        with tempfile.TemporaryDirectory(prefix="aria-burn-tools.") as burn_tools:
            verdict = self._phase(Path(burn_tools), mode="burn_in", profile="observe")
        self.assertFalse(verdict["blocks_action"], verdict)
        self.assertIn("tools_root_detached_from_state_store", verdict["notes"])

    def test_any_other_detached_root_is_a_blocking_reason(self) -> None:
        """GSEC-MEDIUM-006 — only the explicit observe burn-in is exempt."""
        self._store_behind_a_foreign_publish()
        for mode, profile in (("standard", "observe"), ("burn_in", "standard"), ("standard", "standard")):
            with self.subTest(mode=mode, profile=profile), \
                    tempfile.TemporaryDirectory(prefix="aria-elsewhere.") as elsewhere:
                verdict = self._phase(Path(elsewhere), mode=mode, profile=profile)
                self.assertTrue(verdict["blocks_action"], verdict)
                self.assertTrue(
                    any(r.startswith("state_continuity_tools_root_detached_from_state_store")
                        for r in verdict["reasons"]),
                    verdict,
                )

    def test_a_blocking_detached_root_never_rebases_the_real_store(self) -> None:
        from aria_kernel.memory_gap import ContinuityVerdict, restore_and_replay

        store = self._store_behind_a_foreign_publish()
        head_before = state_store._read_commit_ref(store.root, "HEAD")
        verdict = ContinuityVerdict(
            status="critical",
            reference_kind="state_branch",
            reasons=("state_continuity_tools_root_detached_from_state_store:/tmp/x",),
        )
        with mock.patch.object(state_store, "rebase_store_onto_remote", side_effect=AssertionError("rebased")):
            result = restore_and_replay(self.repo_long, verdict, base_dir=self.base / "x", cycle_id="c")
        self.assertFalse(result.resolved)
        self.assertIn("detached", result.reason)
        self.assertEqual(state_store._read_commit_ref(store.root, "HEAD"), head_before)

    def test_the_store_bound_cycle_still_sees_the_foreign_publish(self) -> None:
        store = self._store_behind_a_foreign_publish()
        verdict = self._phase(tools_root(store), mode="standard", profile="standard")
        self.assertTrue(verdict["blocks_action"], verdict)
        self.assertTrue(
            any(reason.startswith("state_continuity_store_not_at_tip") for reason in verdict["reasons"]),
            verdict,
        )


class ReReviewFixes(_TwoWriters):
    """PR #1779 re-review: R-1, R-4, R-6."""

    def _seeded(self) -> None:
        seed = self._store(self.repo_long)
        self._append(seed, "seed")
        self.assertTrue(self._publish(seed, "snap-seed")["published"])

    def test_only_a_held_lease_yields(self) -> None:
        """R-1 — exit 3 carries a holder; a missing record is exit 4."""
        from aria_kernel.state_writer_lease import acquire_writer_lease

        acquire_writer_lease(self.repo_long, ttl_minutes=30, owner="holder")
        code, verdict, _ = self._acquire(self.repo_short, ttl=30)
        self.assertEqual(code, 3)
        self.assertEqual(verdict["holder"]["owner"], "holder")
        # A lease-branch tip that carries no lease.json at all (a fast-forward
        # child, as anything on that branch must be).
        tip = self._remote_tip("aria/state-lease")
        _git(self.repo_long, "fetch", "origin", "aria/state-lease")
        empty_tree = _git(self.repo_long, "hash-object", "-w", "-t", "tree", "/dev/null").strip()
        bare = _git(self.repo_long, "commit-tree", empty_tree, "-p", tip, "-m", "no record").strip()
        _git(self.repo_long, "push", "origin", f"{bare}:refs/heads/aria/state-lease")
        code, verdict, _ = self._acquire(self.repo_short, ttl=30)
        self.assertEqual(code, 4, verdict)
        self.assertIn("state_writer_lease_record_missing", verdict["error"])
        self.assertIn("state lease repair", verdict["error"])

    def test_the_action_yields_only_on_a_verdict_with_a_holder(self) -> None:
        action = (REPO_ROOT / ".github/actions/restore-aria-state/action.yml").read_text(encoding="utf-8")
        acquire = action[action.index("- name: Acquire the aria/state writer lease"):]
        acquire = acquire[: acquire.index("- name: Check out the aria/state store")]
        self.assertIn('"$LEASE_EXIT" -ne 3', acquire)
        self.assertIn('["holder"]', acquire, "a yield must be proven by the verdict's holder")
        self.assertIn("state lease repair", acquire)

    def test_the_fence_never_prints_its_token(self) -> None:
        from aria_kernel.state_writer_fence import WriterFence

        fence = WriterFence(
            commit="c" * 40, lease_branch="aria/state-lease", parent_tip="p" * 40,
            lease_id="sha256:x", epoch=1, token="s3cret-token",
        )
        self.assertNotIn("s3cret-token", repr(fence))

    def test_the_token_file_is_created_exclusively_and_never_through_a_symlink(self) -> None:
        from aria_kernel.state_writer_lease import read_writer_lease

        target = self.base / "elsewhere"
        target.write_text("", encoding="utf-8")
        link = self.base / "token-link"
        link.symlink_to(target)
        with self.assertRaises(OSError):
            cli_main([
                "state", "lease", "acquire", "--repo-root", str(self.repo_long),
                "--ttl-minutes", "5", "--token-file", str(link),
            ])
        self.assertIsNone(read_writer_lease(self.repo_long).tip, "no lease taken when the token cannot be kept")
        code, held, token = self._acquire(self.repo_long, ttl=5)
        self.assertEqual(code, 0, held)
        mode = os.stat(next(self.base.glob("token-long-job-*"))).st_mode & 0o777
        self.assertEqual(mode, 0o600)

    def test_publish_and_release_take_the_token_from_a_file(self) -> None:
        """R-4 — the operator never exports the capability into a shell."""
        from aria_kernel.state_writer_lease import read_writer_lease

        self._seeded()
        token_file = self.base / "operator-token"
        code, held = self._cli([
            "state", "lease", "acquire", "--repo-root", str(self.repo_long),
            "--ttl-minutes", "30", "--token-file", str(token_file),
        ])
        self.assertEqual(code, 0, held)
        store = self._store(self.repo_long)
        self._append(store, "operator-row")
        code, result = self._cli([
            "state", "publish", "--repo-root", str(self.repo_long), "--repo-hash", REPO_HASH,
            "--snapshot-id", "op", "--cycle-id", "op", "--lease-token-file", str(token_file),
        ])
        self.assertEqual(code, 0, result)
        self.assertIn("operator-row", self._remote_cycle_ids(self.repo_long))
        code, released = self._cli([
            "state", "lease", "release", "--repo-root", str(self.repo_long), "--token-file", str(token_file),
        ])
        self.assertTrue(released["released"], released)
        self.assertTrue(read_writer_lease(self.repo_long).released)
        runbook = (REPO_ROOT / "docs/runbooks/aria-state-branch-bootstrap.md").read_text(encoding="utf-8")
        self.assertNotIn("export ARIA_STATE_WRITER_LEASE_TOKEN", runbook)
        self.assertIn("--lease-token-file", runbook)

    def test_publish_state_has_no_unfenced_default(self) -> None:
        import inspect

        parameter = inspect.signature(state_store.publish_state).parameters["writer_fence"]
        self.assertIs(parameter.default, inspect.Parameter.empty)
        self.assertEqual(parameter.kind, inspect.Parameter.KEYWORD_ONLY)

    def test_a_refused_push_with_an_unmoved_lease_is_write_denied_not_lease_lost(self) -> None:
        """R-6 — permission, ruleset or transport: the state did not move and
        neither did the lease, so nothing was lost to another writer."""
        from aria_kernel.state_writer_lease import acquire_writer_lease

        self._seeded()
        holder = acquire_writer_lease(self.repo_long, ttl_minutes=120, owner="holder")
        store = self._store(self.repo_long)
        self._append(store, "holder-row")
        real_run_git = state_store._run_git

        def push_denied(cwd, args):
            if args and args[0] == "push" and "--atomic" in args:
                return subprocess.CompletedProcess(args, 1, "", "remote: Permission denied (ruleset)")
            return real_run_git(cwd, args)

        with mock.patch.object(state_store, "_run_git", side_effect=push_denied):
            with self.assertRaises(state_store.StateStoreError) as caught:
                self._publish(store, "holder", token=holder.token)
        self.assertIn("state_publish_write_denied", str(caught.exception))
        self.assertNotIn("state_writer_lease_lost", str(caught.exception))
        self.assertNotIn("aria/state moved", str(caught.exception))


class CiShapedIdentities(_TwoWriters):
    """The CI failure of d38b25979: with GITHUB_RUN_ID & co set, every
    process of one job derives the SAME public identity, and the second
    acquire re-entered the held lease without its token."""

    CI_ENV = {
        "GITHUB_RUN_ID": "1", "GITHUB_WORKFLOW": "aria-kernel", "GITHUB_JOB": "suite", "GITHUB_RUN_ATTEMPT": "1",
    }

    def test_the_same_identity_without_the_token_yields(self) -> None:
        code, held, token = self._acquire(self.repo_long, ttl=60, identity=self.CI_ENV)
        self.assertEqual(code, 0, held)
        code, verdict, other = self._acquire(self.repo_short, ttl=60, identity=self.CI_ENV)
        self.assertEqual(code, 3, verdict)
        self.assertEqual(verdict["holder"]["lease_id"], held["lease_id"])
        self.assertEqual(other, "", "a yield mints no capability")

    def test_the_api_never_re_enters_by_owner(self) -> None:
        from aria_kernel.state_writer_lease import StateWriterLeaseBlocked, acquire_writer_lease

        acquire_writer_lease(self.repo_long, ttl_minutes=30, owner="gha:w:j:run=1:attempt=1")
        with self.assertRaises(StateWriterLeaseBlocked):
            acquire_writer_lease(self.repo_short, ttl_minutes=30, owner="gha:w:j:run=1:attempt=1")

    def test_the_measured_scenario_holds_under_a_ci_shaped_environment(self) -> None:
        """The module's headline scenario, with the CI variables exported for
        the whole test — a laptop run must not pass where CI fails."""
        with mock.patch.dict(os.environ, self.CI_ENV):
            seed = self._store(self.repo_long)
            self._append(seed, "seed")
            self.assertTrue(self._publish(seed, "snap-seed")["published"])
            code, held, token = self._acquire(self.repo_long, ttl=120, identity=self.CI_ENV)
            self.assertEqual(code, 0, held)
            long_job = self._store(self.repo_long)
            self._append(long_job, "long-job-work")
            code, yielded, _ = self._acquire(self.repo_short, ttl=95, wait=1, identity=self.CI_ENV)
            self.assertEqual(code, 3, yielded)
            code, result = self._cli_publish(self.repo_long, "executor-final", token=token)
            self.assertEqual(code, 0, result)
        self.assertIn("long-job-work", self._remote_cycle_ids(self.repo_long))

    def test_the_token_is_kept_before_the_lease_is_pushed(self) -> None:
        """R-2 — no identity fallback is needed because the capability is on
        disk before the push that makes it the lease's: an acquire that dies
        after its push still leaves the token its release step reads."""
        from aria_kernel import state_writer_lease as module

        real_push = module._push_record
        kept: list[str] = []

        def push_then_die(*args, **kwargs):
            self.assertTrue(kept, "the token must be kept before the push")
            real_push(*args, **kwargs)
            raise RuntimeError("runner died after the lease push")

        with mock.patch.object(module, "_push_record", side_effect=push_then_die), \
                self.assertRaises(RuntimeError):
            module.acquire_writer_lease(
                self.repo_long, ttl_minutes=30, owner="dies", persist_token=kept.append,
            )
        view = module.read_writer_lease(self.repo_long)
        self.assertTrue(view.held_by_token(kept[-1]))
        self.assertTrue(module.release_writer_lease(self.repo_long, token=kept[-1])["released"])

    def test_the_cli_token_file_survives_a_crash_after_the_push(self) -> None:
        from aria_kernel import state_writer_lease as module

        real_push = module._push_record
        token_file = self.base / "crash-token"

        def push_then_die(*args, **kwargs):
            real_push(*args, **kwargs)
            raise RuntimeError("runner died after the lease push")

        with mock.patch.object(module, "_push_record", side_effect=push_then_die), \
                mock.patch.dict(os.environ, self._identity(self.repo_long)), self.assertRaises(RuntimeError):
            cli_main([
                "state", "lease", "acquire", "--repo-root", str(self.repo_long),
                "--ttl-minutes", "30", "--token-file", str(token_file),
            ])
        token = token_file.read_text(encoding="utf-8").strip()
        self.assertTrue(module.read_writer_lease(self.repo_long).held_by_token(token))

    def test_the_action_emits_a_kept_token_even_when_the_acquire_failed(self) -> None:
        action = (REPO_ROOT / ".github/actions/restore-aria-state/action.yml").read_text(encoding="utf-8")
        acquire = action[action.index("- name: Acquire the aria/state writer lease"):]
        acquire = acquire[: acquire.index("- name: Check out the aria/state store")]
        emit = acquire.index('echo "token=${LEASE_TOKEN}"')
        branch = acquire.index("then\n          echo \"writer_lease=held\"")
        self.assertLess(emit, branch, "the token output is written before the outcome is judged")


class StateBranchProtection(unittest.TestCase):
    """GSEC-HIGH-002 Tier 3 — the ruleset must cover all three aria/state* branches."""

    def _listing(self, *, cover=("aria/state", "aria/state-cold", "aria/state-lease"), rules=("deletion", "non_fast_forward")):
        def rules_for(branch: str) -> list[dict]:
            if branch not in cover:
                return []
            return [{"type": rule, "ruleset_id": 20441794} for rule in rules]

        return rules_for

    def test_all_three_branches_covered_is_green(self) -> None:
        from aria_kernel.readiness_proofs import STATE_BRANCHES, state_branch_protection_reasons

        self.assertEqual(STATE_BRANCHES, ("aria/state", "aria/state-cold", "aria/state-lease"))
        self.assertEqual(state_branch_protection_reasons(self._listing()), [])

    def test_an_uncovered_lease_branch_is_named(self) -> None:
        from aria_kernel.readiness_proofs import state_branch_protection_reasons

        reasons = state_branch_protection_reasons(self._listing(cover=("aria/state", "aria/state-cold")))
        self.assertEqual(
            reasons,
            ["state_branch_unprotected:aria/state-lease:deletion",
             "state_branch_unprotected:aria/state-lease:non_fast_forward"],
        )

    def test_force_pushes_allowed_is_named(self) -> None:
        from aria_kernel.readiness_proofs import state_branch_protection_reasons

        reasons = state_branch_protection_reasons(self._listing(rules=("deletion",)))
        self.assertEqual(len(reasons), 3)
        self.assertTrue(all(r.endswith(":non_fast_forward") for r in reasons))


class EveryWriterTakesTurns(unittest.TestCase):
    """Tier 3 behind the runtime refusal: no lane can be written without the lease."""

    def test_the_fence_lives_in_the_orchestrator_and_nothing_else_publishes(self) -> None:
        import inspect

        source = inspect.getsource(state_store.publish_with_contention_replay)
        self.assertIn("prepare_writer_fence(", source)
        locked = inspect.getsource(state_store._publish_with_contention_replay_locked)
        self.assertIn("writer_fence=writer_fence", locked)
        self.assertNotIn("rebase_store_onto_remote(", locked, "no replay under a lease")
        push = inspect.getsource(state_store._publish_state_locked)
        self.assertIn('"--atomic"', push)
        package = KERNEL_ROOT / "aria_kernel"
        for path in sorted(package.rglob("*.py")):
            if path.name == "state_store.py":
                continue
            tree = ast.parse(path.read_text(encoding="utf-8"))
            for node in ast.walk(tree):
                if isinstance(node, ast.Call):
                    name = node.func.id if isinstance(node.func, ast.Name) else getattr(node.func, "attr", "")
                    self.assertNotEqual(name, "publish_state", f"{path.name} publishes around the fence")

    def test_every_publishing_workflow_holds_the_lease_for_its_whole_job(self) -> None:
        from aria_kernel.state_writer_lease import PUBLISH_MARGIN_MINUTES

        publishing = 0
        token = "steps.restore_state.outputs.writer-lease-token"
        for path in sorted(WORKFLOWS.glob("*.yml")):
            text = path.read_text(encoding="utf-8")
            workflow = yaml.safe_load(text)
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
                self.assertEqual(restore.get("id"), "restore_state", label)
                # GSEC-MEDIUM-003 — the expiry outlives the job by a whole publish.
                ttl = int((restore.get("with") or {}).get("writer-lease-ttl-minutes") or 0)
                self.assertGreaterEqual(ttl, int(job.get("timeout-minutes")) + PUBLISH_MARGIN_MINUTES, label)
                last_publish = max(i for i, run in enumerate(runs) if "aria_kernel state publish" in run)
                # GSEC-LOW-001 — the release is unconditional and last.
                releases = [
                    (index, step) for index, step in enumerate(steps)
                    if step.get("uses") == "./.github/actions/release-aria-state-lease"
                ]
                self.assertEqual(len(releases), 1, label)
                release_index, release = releases[0]
                self.assertGreater(release_index, last_publish, label)
                self.assertEqual(str(release.get("if")).strip(), "always()", label)
                self.assertIn(token, json.dumps(release.get("with") or {}), label)
                # GSEC-LOW-002 — the token reaches only the steps that need it.
                self.assertNotIn("--export-env", text, label)
                for index, step in enumerate(steps):
                    carries = token in json.dumps(step.get("env") or {})
                    publishes = "aria_kernel state publish" in str(step.get("run") or "")
                    merges = step.get("id") == "merge"
                    if publishes:
                        self.assertTrue(carries, f"{label}:{step.get('name')} publishes without the token")
                    elif carries:
                        self.assertTrue(merges, f"{label}:{step.get('name')} holds the token it does not need")
                # A yielded restore checks nothing out, so every later step
                # that runs the kernel against the store must be closed by a
                # gate the yield closes.
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

    def test_the_restore_action_masks_the_token_and_never_exports_it(self) -> None:
        action = (REPO_ROOT / ".github/actions/restore-aria-state/action.yml").read_text(encoding="utf-8")
        self.assertIn("::add-mask::", action)
        self.assertIn("--token-file", action)
        self.assertNotIn("--export-env", action)
        self.assertNotIn(WRITER_LEASE_TOKEN_ENV, action.split("outputs:")[0])


if __name__ == "__main__":
    unittest.main()
