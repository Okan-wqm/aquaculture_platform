"""ARIA-HIGH-350 — two defects the writer lease showed once it was live.

1. HOOKS ON DATA PUSHES. `state lease release --force-foreign` from the
   operator checkout /root/aria-8b (no node_modules) failed with
   `state_writer_lease_release_failed: ... refused 3 release pushes`. The
   push ran from the repository root, so husky's pre-push code gate ran on a
   DATA push and died on `ts-node: not found` — and the error said only
   "refused". Every kernel git operation on an aria/state* branch is now
   hook-free by construction, and a refused push says what git said.
2. A CANCELLED HOLDER WEDGED THE LEASE. Executor run 37231079995 was
   cancelled at 22:18Z; GitHub ran neither its publish nor its `always()`
   release, and its lease (TTL 650 min) held every writer off until 07:27Z.
   An acquirer that finds a held `gha:` lease now asks the Actions API about
   the recorded run attempt and reaps it by CAS when that attempt has
   concluded. No answer, no reap.

The fixtures are the single-writer suite's: a bare remote and two clones.
"""

from __future__ import annotations

import os
import stat
import subprocess
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest import mock

from aria_kernel import state_store
from aria_kernel import state_writer_lease as lease_module
from aria_kernel.state_writer_lease import (
    StateWriterLeaseBlocked,
    acquire_writer_lease,
    read_writer_lease,
    release_writer_lease,
)

from tests.test_state_single_writer import _TwoWriters, _git

EXECUTOR_OWNER = "gha:aria-agent-executor:executor:run=37231079995:attempt=1"


def _failing_hook_dir(base: Path) -> Path:
    """Every client-side hook the kernel could trip, each one failing loudly
    the way husky's pre-push did on the operator checkout."""
    hooks = base / "failing-hooks"
    hooks.mkdir()
    for name in ("pre-push", "pre-commit", "commit-msg", "prepare-commit-msg", "post-commit",
                 "post-checkout", "reference-transaction", "pre-auto-gc"):
        script = hooks / name
        script.write_text(f"#!/bin/sh\necho '.husky/{name}: ts-node: not found' >&2\nexit 127\n", encoding="utf-8")
        script.chmod(script.stat().st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)
    return hooks


class DataPushesRunNoHooks(_TwoWriters):
    def _arm_hooks(self, repo: Path) -> None:
        # Absolute, so the hooks resolve from the store worktree too — the
        # live repository's `.husky` is relative and resolved only from the
        # checkout, which is why aria/state publishes escaped it by luck.
        _git(repo, "config", "core.hooksPath", str(_failing_hook_dir(self.base / repo.name)))

    def setUp(self) -> None:
        super().setUp()
        (self.base / self.repo_long.name).mkdir(exist_ok=True)
        (self.base / self.repo_short.name).mkdir(exist_ok=True)

    def test_acquire_release_and_the_fenced_publish_ignore_the_repositorys_hooks(self) -> None:
        self._arm_hooks(self.repo_long)
        seed = self._store(self.repo_long)
        self._append(seed, "seed")
        self.assertTrue(self._publish(seed, "snap-seed")["published"])
        held = acquire_writer_lease(self.repo_long, ttl_minutes=120, owner="operator")
        store = self._store(self.repo_long)
        self._append(store, "operator-row")
        result = self._publish(store, "operator", token=held.token)
        self.assertTrue(result["published"], result)
        self.assertIn("operator-row", self._remote_cycle_ids(self.repo_long))
        self.assertTrue(release_writer_lease(self.repo_long, token=held.token)["released"])

    def test_a_force_foreign_release_from_a_checkout_without_node_modules_works(self) -> None:
        """The live failure, reproduced: the operator lane's checkout has a
        pre-push gate that cannot run."""
        acquire_writer_lease(self.repo_long, ttl_minutes=30, owner=EXECUTOR_OWNER, run_id="37231079995")
        self._arm_hooks(self.repo_short)
        with mock.patch.object(lease_module, "github_run_attempt_status",
                               side_effect=lease_module.RunStatusUnavailable("no API in this test")):
            released = release_writer_lease(self.repo_short, force_foreign_reason="executor cancelled at 22:18Z")
        self.assertTrue(released["released"], released)

    def test_a_refused_push_says_what_git_said(self) -> None:
        hook = self.remote / "hooks" / "pre-receive"
        hook.write_text("#!/bin/sh\necho 'GH013: Repository rule violations found for refs/heads/aria/state-lease' >&2\nexit 1\n",
                        encoding="utf-8")
        hook.chmod(0o755)
        with self.assertRaises(state_store.StateStoreError) as caught:
            acquire_writer_lease(self.repo_long, ttl_minutes=30, owner="operator")
        self.assertIn("state_writer_lease_push_failed", str(caught.exception))
        self.assertIn("GH013: Repository rule violations found", str(caught.exception))

    def test_every_store_git_call_is_hook_free_by_construction(self) -> None:
        seen: list[list[str]] = []
        real = subprocess.Popen

        def spy(argv, *args, **kwargs):
            if argv and argv[0] == "git":
                seen.append(list(argv))
            return real(argv, *args, **kwargs)

        with mock.patch.object(subprocess, "Popen", side_effect=spy):
            acquire_writer_lease(self.repo_long, ttl_minutes=30, owner="operator")
        self.assertTrue(seen)
        for argv in seen:
            self.assertEqual(argv[3:5], ["-c", "core.hooksPath=/dev/null"], argv)


class FakeRuns:
    """The Actions API, as the reaper sees it: (status, conclusion) per attempt."""

    def __init__(self, answers: dict[tuple[str, str], tuple[str, str | None]] | Exception) -> None:
        self.answers = answers
        self.asked: list[tuple[str, str]] = []

    def __call__(self, run_id: str, attempt: str) -> tuple[str, str | None]:
        self.asked.append((run_id, attempt))
        if isinstance(self.answers, Exception):
            raise self.answers
        return self.answers[(run_id, attempt)]


class ConcludedRunsAreReaped(_TwoWriters):
    def _held_by_the_cancelled_executor(self):
        return acquire_writer_lease(
            self.repo_long, ttl_minutes=650, owner=EXECUTOR_OWNER, run_id="37231079995",
        )

    def test_a_cancelled_runs_lease_is_reaped_by_cas_and_recorded(self) -> None:
        dead = self._held_by_the_cancelled_executor()
        runs = FakeRuns({("37231079995", "1"): ("completed", "cancelled")})
        taker = acquire_writer_lease(self.repo_short, ttl_minutes=95, owner="gha:aria-merge-runner:merge:run=9:attempt=1",
                                     run_status=runs)
        self.assertEqual(runs.asked, [("37231079995", "1")])
        self.assertEqual(taker.epoch, dead.epoch + 1)
        view = read_writer_lease(self.repo_long)
        self.assertEqual(view.lease.lease_id, taker.lease_id)
        self.assertEqual(view.reaped, {
            "lease_id": dead.lease_id, "owner": EXECUTOR_OWNER, "run_id": "37231079995",
            "run_attempt": "1", "status": "completed", "conclusion": "cancelled",
        })
        _git(self.repo_long, "fetch", "origin", "aria/state-lease")
        self.assertIn("reaped", _git(self.repo_long, "log", "-1", "--format=%s", "FETCH_HEAD"))
        self.assertFalse(view.held_by_token(dead.token))

    def test_every_concluded_outcome_reaps(self) -> None:
        for conclusion in ("success", "failure", "cancelled", "timed_out"):
            with self.subTest(conclusion=conclusion):
                self._held_by_the_cancelled_executor()
                runs = FakeRuns({("37231079995", "1"): ("completed", conclusion)})
                taker = acquire_writer_lease(self.repo_short, ttl_minutes=30, owner=f"taker-{conclusion}",
                                             run_status=runs)
                release_writer_lease(self.repo_short, token=taker.token)

    def test_a_running_holder_is_not_reaped(self) -> None:
        self._held_by_the_cancelled_executor()
        runs = FakeRuns({("37231079995", "1"): ("in_progress", None)})
        with self.assertRaises(StateWriterLeaseBlocked) as caught:
            acquire_writer_lease(self.repo_short, ttl_minutes=30, owner="taker", run_status=runs)
        self.assertIn("not reaped: run 37231079995 attempt 1 is in_progress", str(caught.exception))

    def test_no_api_answer_means_no_reap(self) -> None:
        self._held_by_the_cancelled_executor()
        runs = FakeRuns(lease_module.RunStatusUnavailable("HTTP 403 from the Actions API"))
        with self.assertRaises(StateWriterLeaseBlocked) as caught:
            acquire_writer_lease(self.repo_short, ttl_minutes=30, owner="taker", run_status=runs)
        self.assertIn("not reaped: run status unavailable: HTTP 403 from the Actions API", str(caught.exception))
        self.assertEqual(read_writer_lease(self.repo_long).lease.owner, EXECUTOR_OWNER)

    def test_a_local_or_operator_owner_is_never_reaped(self) -> None:
        acquire_writer_lease(self.repo_long, ttl_minutes=30, owner="local:host:root:/root/aria-8b")
        runs = FakeRuns({})
        with self.assertRaises(StateWriterLeaseBlocked) as caught:
            acquire_writer_lease(self.repo_short, ttl_minutes=30, owner="taker", run_status=runs)
        self.assertEqual(runs.asked, [], "a non-gha owner's liveness is not asked of GitHub")
        self.assertIn("not reaped: owner local:host:root:/root/aria-8b is not a GitHub run", str(caught.exception))

    def test_the_owners_attempt_is_the_one_asked_about(self) -> None:
        """A re-run is a new attempt of the same run id: the dead attempt's
        lease is reaped even while the new attempt runs."""
        acquire_writer_lease(self.repo_long, ttl_minutes=30, owner="gha:w:j:run=5:attempt=1", run_id="5")
        runs = FakeRuns({("5", "1"): ("completed", "cancelled"), ("5", "2"): ("in_progress", None)})
        acquire_writer_lease(self.repo_short, ttl_minutes=30, owner="gha:w:j:run=5:attempt=2", run_status=runs)
        self.assertEqual(runs.asked, [("5", "1")])

    def test_the_default_client_without_a_token_does_not_reap(self) -> None:
        from aria_kernel.state_writer_lease_runs import RunStatusUnavailable, github_run_attempt_status

        for key in ("GH_TOKEN", "GITHUB_TOKEN", "GITHUB_REPOSITORY"):
            os.environ.pop(key, None)

        def must_not_be_called(*_args, **_kwargs):
            raise AssertionError("no token, no request")

        with self.assertRaisesRegex(RunStatusUnavailable, "no GitHub token or repository"):
            github_run_attempt_status("37231079995", "1", opener=must_not_be_called)
        # And through the acquire: the default reader is reached, fails
        # closed, and the lease is not reaped.
        self._held_by_the_cancelled_executor()
        with self.assertRaises(StateWriterLeaseBlocked) as caught:
            acquire_writer_lease(self.repo_short, ttl_minutes=30, owner="taker")
        self.assertIn("not reaped: run status unavailable", str(caught.exception))

    def test_an_http_error_from_the_api_does_not_reap(self) -> None:
        import urllib.error

        from aria_kernel.state_writer_lease_runs import RunStatusUnavailable, github_run_attempt_status

        def forbidden(request, timeout):
            raise urllib.error.HTTPError(request.full_url, 403, "Forbidden", {}, None)

        with mock.patch.dict(os.environ, {"GH_TOKEN": "t", "GITHUB_REPOSITORY": "o/r"}), \
                self.assertRaisesRegex(RunStatusUnavailable, "HTTP 403"):
            github_run_attempt_status("1", "1", opener=forbidden)

    def test_the_default_client_reads_the_attempt_endpoint(self) -> None:
        calls: list[tuple[str, str]] = []

        class Response:
            status = 200

            def __enter__(self):
                return self

            def __exit__(self, *exc):
                return False

            def read(self):
                return b'{"status": "completed", "conclusion": "cancelled", "run_attempt": 1}'

        def opener(request, timeout):
            calls.append((request.full_url, request.get_header("Authorization")))
            return Response()

        from aria_kernel.state_writer_lease_runs import github_run_attempt_status

        with mock.patch.dict(os.environ, {"GH_TOKEN": "t0ken", "GITHUB_REPOSITORY": "Okan-wqm/aquaculture_platform"}):
            answer = github_run_attempt_status("37231079995", "1", opener=opener)
        self.assertEqual(answer, ("completed", "cancelled"))
        self.assertEqual(calls, [(
            "https://api.github.com/repos/Okan-wqm/aquaculture_platform/actions/runs/37231079995/attempts/1",
            "Bearer t0ken",
        )])

    def test_a_force_foreign_release_records_whether_the_run_had_concluded(self) -> None:
        self._held_by_the_cancelled_executor()
        runs = FakeRuns({("37231079995", "1"): ("completed", "cancelled")})
        with mock.patch.object(lease_module, "github_run_attempt_status", side_effect=runs):
            released = release_writer_lease(self.repo_short, force_foreign_reason="executor cancelled at 22:18Z")
        self.assertTrue(released["released"], released)
        reason = read_writer_lease(self.repo_long).release_reason
        self.assertIn("executor cancelled at 22:18Z", reason)
        self.assertIn("run 37231079995 attempt 1 concluded: cancelled", reason)

    def test_a_force_foreign_release_of_a_running_holder_says_so(self) -> None:
        self._held_by_the_cancelled_executor()
        runs = FakeRuns({("37231079995", "1"): ("in_progress", None)})
        with mock.patch.object(lease_module, "github_run_attempt_status", side_effect=runs):
            release_writer_lease(self.repo_short, force_foreign_reason="operator override")
        self.assertIn("run 37231079995 attempt 1 is in_progress (not concluded)",
                      read_writer_lease(self.repo_long).release_reason)

    def test_an_unexpired_lease_is_still_blocked_without_reaping_when_the_api_is_silent(self) -> None:
        later = datetime.now(timezone.utc) + timedelta(minutes=1)
        self._held_by_the_cancelled_executor()
        with self.assertRaises(StateWriterLeaseBlocked):
            acquire_writer_lease(
                self.repo_short, ttl_minutes=30, owner="taker", now=lambda: later,
                run_status=FakeRuns(lease_module.RunStatusUnavailable("timeout")),
            )
