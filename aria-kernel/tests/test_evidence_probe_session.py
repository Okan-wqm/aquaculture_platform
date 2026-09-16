"""One stalled git probe is retried; a workspace that cannot read the
baseline is the host's gap, not the agent's.

Two defects of the same class, both at the acceptance seam:

* The classifier's git probe carried a 5 s bound and NO retry, and the
  production seam (`validate_agent_response_evidence`) never sized it. One
  `git show` past 5 s on the loaded 2026-09-12 host therefore rejected a
  whole submission; `verification_unavailable` re-labelled the rejection
  honestly but the executor then re-dispatched the entire paid agent run
  for a probe a millisecond retry would have answered. Now every probe
  runs inside a `GitProbeSession`: an attempt bound, a bounded retry with
  backoff, and ONE liveness clock for the whole decision so a git that is
  really gone costs the decision one clock, not refs x attempts x bound.

* A non-zero git exit unrelated to the path — `bad object` when the
  request's target_sha was never fetched into this workspace, `not a git
  repository` — graded exactly like a path the tree does not carry:
  `worktree_candidate`, the agent-fault grade. The baseline is now resolved
  ONCE per decision with `git rev-parse --verify <sha>^{commit}` and a
  workspace that cannot read it grades `verification_unavailable`; a path
  that is genuinely absent from a readable baseline stays the agent's.
"""
from __future__ import annotations

import os
import shutil
import stat
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from aria_kernel import evidence_probe
from aria_kernel.evidence_probe import (
    BASELINE_UNREACHABLE,
    EVIDENCE_VERIFICATION_LIVENESS_SECONDS,
    GIT_PROBE_ATTEMPTS,
    GIT_PROBE_ATTEMPT_TIMEOUT_SECONDS,
    GIT_PROBE_BACKOFF_SECONDS,
    GIT_PROBE_WORST_CASE_SECONDS,
    PROBE_LIVENESS_BOUND_EXHAUSTED,
    PROBE_TIMEOUT,
    GitProbeSession,
)
from aria_kernel.evidence_trust import classify_evidence_ref
from aria_kernel.evidence_validator import validate_agent_response_evidence


_ATTEMPT_SECONDS = 0.2


def _repo_with_one_commit(root: Path) -> str:
    def git(*args: str) -> str:
        return subprocess.run(
            ["git", *args], cwd=str(root), text=True, capture_output=True, check=True,
        ).stdout.strip()

    git("init", "-q")
    git("config", "user.email", "t@example.invalid")
    git("config", "user.name", "t")
    (root / "kept.py").write_text("line one\nline two\n", encoding="utf-8")
    (root / "pkg").mkdir()
    (root / "pkg" / "a.ts").write_text("export const a = 1;\n", encoding="utf-8")
    git("add", "kept.py", "pkg/a.ts")
    git("commit", "-qm", "seed")
    return git("rev-parse", "HEAD")


class _FakeGit:
    """A `git` on PATH scripted by the test.

    ``stall_first_of`` names a subcommand whose FIRST invocation sleeps past
    every bound (the process is exec'd so the timeout kills the sleeper
    itself); every other invocation execs the real git. ``stall_all`` makes
    every invocation stall.
    """

    def __init__(self, *, stall_first_of: str | None = None, stall_all: bool = False) -> None:
        self._stall_first_of = stall_first_of
        self._stall_all = stall_all

    def __enter__(self) -> "_FakeGit":
        real_git = shutil.which("git")
        assert real_git, "a real git is required to script one"
        self._dir = Path(tempfile.mkdtemp(prefix="aria-fake-git-"))
        fake = self._dir / "git"
        marker = self._dir / "stalled-once"
        if self._stall_all:
            script = "#!/bin/sh\nexec sleep 5\n"
        else:
            script = (
                "#!/bin/sh\n"
                f'if [ "$1" = "{self._stall_first_of}" ] && [ ! -e "{marker}" ]; then\n'
                f'  : > "{marker}"\n'
                "  exec sleep 5\n"
                "fi\n"
                f'exec "{real_git}" "$@"\n'
            )
        fake.write_text(script, encoding="utf-8")
        fake.chmod(fake.stat().st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)
        self._env = mock.patch.dict(
            os.environ, {"PATH": f"{self._dir}{os.pathsep}{os.environ.get('PATH', '')}"},
        )
        self._env.start()
        return self

    def __exit__(self, *exc: object) -> None:
        self._env.stop()
        shutil.rmtree(self._dir, ignore_errors=True)


def _session(**overrides) -> GitProbeSession:
    kwargs = {
        "attempt_timeout_seconds": _ATTEMPT_SECONDS,
        "attempts": 3,
        "backoff_seconds": (0.01, 0.02),
        "liveness_seconds": 10.0,
    }
    kwargs.update(overrides)
    return GitProbeSession(**kwargs)


class TheBoundsAreLivenessGuards(unittest.TestCase):
    def test_one_ref_can_stall_through_every_retry_inside_the_decision_clock(self) -> None:
        # The decision's clock must at least hold ONE ref's full retry arc,
        # or the retry is a budget the clock overrides.
        one_ref_worst_case = (
            GIT_PROBE_ATTEMPTS * GIT_PROBE_ATTEMPT_TIMEOUT_SECONDS
            + sum(GIT_PROBE_BACKOFF_SECONDS)
        )
        self.assertGreaterEqual(EVIDENCE_VERIFICATION_LIVENESS_SECONDS, one_ref_worst_case)
        # The number a caller running ONE probe outside a decision (the
        # executor's pre-claim gate) prices into its own worst case.
        self.assertEqual(GIT_PROBE_WORST_CASE_SECONDS, one_ref_worst_case)
        self.assertGreaterEqual(GIT_PROBE_ATTEMPTS, 2, "a retry needs a second attempt")
        self.assertEqual(len(GIT_PROBE_BACKOFF_SECONDS), GIT_PROBE_ATTEMPTS - 1)

    def test_the_seam_uses_the_production_session_by_default(self) -> None:
        session = GitProbeSession()
        self.assertEqual(session.attempt_timeout_seconds, GIT_PROBE_ATTEMPT_TIMEOUT_SECONDS)
        self.assertEqual(session.attempts, GIT_PROBE_ATTEMPTS)
        self.assertEqual(session.liveness_seconds, EVIDENCE_VERIFICATION_LIVENESS_SECONDS)


class AStallIsRetried(unittest.TestCase):
    def setUp(self) -> None:
        self.root = Path(tempfile.mkdtemp(prefix="aria-probe-retry-"))
        self.sha = _repo_with_one_commit(self.root)

    def tearDown(self) -> None:
        shutil.rmtree(self.root, ignore_errors=True)

    def test_a_single_stalled_probe_followed_by_an_answer_grades_repo_verified(self) -> None:
        # The 2026-09-12 shape: ONE `git show` does not answer inside its
        # bound; the next one does. Before: verification_unavailable and a
        # re-dispatched run. Now: the retry answers and the ref verifies.
        session = _session()
        with _FakeGit(stall_first_of="show"):
            envelope = classify_evidence_ref(
                "kept.py:1", workspace_root=self.root, target_sha=self.sha,
                probe_session=session,
            )
        self.assertEqual(envelope.trust_grade, "repo_verified")
        self.assertEqual(session.stalled_attempts, 1)
        self.assertEqual(session.probes_refused_after_bound, 0)

    def test_a_git_that_never_answers_is_unavailable_after_every_retry(self) -> None:
        session = _session()
        with _FakeGit(stall_all=True):
            envelope = classify_evidence_ref(
                "kept.py:1", workspace_root=self.root, target_sha=self.sha,
                probe_session=session,
            )
        self.assertEqual(envelope.trust_grade, "verification_unavailable")
        # The baseline probe is the first one to run and it exhausted its
        # attempts; no path probe was spawned against an unreadable baseline.
        self.assertEqual(session.stalled_attempts, session.attempts)
        baseline = session.resolve_baseline(self.root, self.sha)
        self.assertFalse(baseline.readable)
        self.assertEqual(baseline.unavailable_reason, PROBE_TIMEOUT)

    def test_the_backoff_is_taken_between_attempts_and_clipped_to_the_clock(self) -> None:
        pauses: list[float] = []
        session = _session(backoff_seconds=(0.03, 0.05), liveness_seconds=10.0)
        with _FakeGit(stall_all=True), mock.patch.object(
            evidence_probe.time, "sleep", side_effect=pauses.append,
        ):
            outcome = session.run(["git", "rev-parse", "HEAD"], cwd=self.root)
        self.assertFalse(outcome.answered)
        self.assertEqual(outcome.attempts, 3)
        self.assertEqual(pauses, [0.03, 0.05])


class TheDecisionHasOneClock(unittest.TestCase):
    def setUp(self) -> None:
        self.root = Path(tempfile.mkdtemp(prefix="aria-probe-clock-"))
        self.sha = _repo_with_one_commit(self.root)

    def tearDown(self) -> None:
        shutil.rmtree(self.root, ignore_errors=True)

    def test_refs_after_the_clock_runs_out_are_refused_without_a_spawn(self) -> None:
        # A submission of many refs against a git that is gone must cost the
        # decision ONE clock, not refs x attempts x bound.
        session = _session(liveness_seconds=_ATTEMPT_SECONDS * 2)
        refs = ["kept.py:1", "pkg/a.ts:1", "pkg", "kept.py:2"]
        with _FakeGit(stall_all=True), mock.patch.object(
            evidence_probe.subprocess, "run", wraps=evidence_probe.subprocess.run,
        ) as spawned:
            grades = [
                classify_evidence_ref(
                    ref, workspace_root=self.root, target_sha=self.sha,
                    probe_session=session,
                ).trust_grade
                for ref in refs
            ]
        self.assertEqual(set(grades), {"verification_unavailable"})
        # The clock held at most a couple of attempts; every later probe
        # was refused before a process was started.
        self.assertLessEqual(spawned.call_count, 2)
        self.assertGreaterEqual(session.probes_refused_after_bound, 1)

    def test_an_exhausted_clock_names_itself(self) -> None:
        session = _session(liveness_seconds=0.0)
        outcome = session.run(["git", "rev-parse", "HEAD"], cwd=self.root)
        self.assertFalse(outcome.answered)
        self.assertEqual(outcome.unavailable_reason, PROBE_LIVENESS_BOUND_EXHAUSTED)
        self.assertEqual(outcome.attempts, 0)

    def test_the_baseline_is_resolved_once_per_decision(self) -> None:
        session = _session()
        with mock.patch.object(
            evidence_probe.subprocess, "run", wraps=evidence_probe.subprocess.run,
        ) as spawned:
            for ref in ("kept.py:1", "pkg/a.ts:1", "pkg"):
                classify_evidence_ref(
                    ref, workspace_root=self.root, target_sha=self.sha,
                    probe_session=session,
                )
        rev_parses = [
            call for call in spawned.call_args_list
            if call.args[0][:2] == ["git", "rev-parse"]
        ]
        self.assertEqual(len(rev_parses), 1)

    def test_a_name_resolved_once_answers_for_the_id_it_resolved_to(self) -> None:
        # A decision that resolves `HEAD` and then grades every ref against
        # the id it got back (the finding emitter's shape) asks git once:
        # the readable resolution is cached under the resolved id as well.
        session = _session()
        with mock.patch.object(
            evidence_probe.subprocess, "run", wraps=evidence_probe.subprocess.run,
        ) as spawned:
            head = session.resolve_baseline(self.root, "HEAD")
            again = session.resolve_baseline(self.root, head.commit_sha)
        self.assertEqual(head.commit_sha, self.sha)
        self.assertTrue(again.readable)
        self.assertEqual(again.commit_sha, self.sha)
        self.assertEqual(spawned.call_count, 1)

    def test_the_validator_threads_one_session_through_a_submission(self) -> None:
        sessions: list[GitProbeSession] = []
        real_classify = classify_evidence_ref

        def spy(ref, **kwargs):
            sessions.append(kwargs.get("probe_session"))
            return real_classify(ref, **kwargs)

        response = {
            "evidence_refs": ["kept.py:1", "pkg/a.ts:1"],
            "satisfaction_matrix": [{"id": "S1", "evidence_refs": ["kept.py:2"]}],
        }
        with mock.patch("aria_kernel.evidence_validator.classify_evidence_ref", new=spy):
            result = validate_agent_response_evidence(
                response=response, workspace_root=self.root,
                request={"target_sha": self.sha, "allowed_scope": ["**"]},
            )
        self.assertTrue(result["valid"], result["errors"])
        self.assertEqual(len(sessions), 3)
        self.assertTrue(all(s is not None for s in sessions))
        self.assertEqual(len({id(s) for s in sessions}), 1)


class AnUnreadableBaselineIsTheHostsGap(unittest.TestCase):
    def setUp(self) -> None:
        self.root = Path(tempfile.mkdtemp(prefix="aria-probe-baseline-"))
        self.sha = _repo_with_one_commit(self.root)

    def tearDown(self) -> None:
        shutil.rmtree(self.root, ignore_errors=True)

    def test_a_commit_the_workspace_never_fetched_grades_verification_unavailable(self) -> None:
        # `bad object`: a well-formed sha that is not in this object store —
        # the request's target was minted elsewhere and never fetched here.
        absent_sha = "0123456789abcdef0123456789abcdef01234567"
        session = _session()
        envelope = classify_evidence_ref(
            "kept.py:1", workspace_root=self.root, target_sha=absent_sha,
            probe_session=session,
        )
        self.assertEqual(envelope.trust_grade, "verification_unavailable")
        self.assertEqual(envelope.target_sha, absent_sha)
        baseline = session.resolve_baseline(self.root, absent_sha)
        self.assertEqual(baseline.unavailable_reason, BASELINE_UNREACHABLE)
        self.assertEqual(session.stalled_attempts, 0)

    def test_a_directory_that_is_not_a_repository_grades_verification_unavailable(self) -> None:
        plain = Path(tempfile.mkdtemp(prefix="aria-probe-norepo-"))
        try:
            (plain / "kept.py").write_text("line one\n", encoding="utf-8")
            (plain / "pkg").mkdir()
            (plain / "pkg" / "a.ts").write_text("x\n", encoding="utf-8")
            session = _session()
            with mock.patch.dict(os.environ, {"GIT_CEILING_DIRECTORIES": str(plain.parent)}):
                grades = {
                    ref: classify_evidence_ref(
                        ref, workspace_root=plain, target_sha=self.sha,
                        probe_session=session,
                    ).trust_grade
                    for ref in ("kept.py:1", "pkg", "pkg/*.ts")
                }
        finally:
            shutil.rmtree(plain, ignore_errors=True)
        self.assertEqual(
            grades,
            {
                "kept.py:1": "verification_unavailable",
                "pkg": "verification_unavailable",
                "pkg/*.ts": "verification_unavailable",
            },
        )

    def test_a_path_absent_from_a_readable_baseline_stays_the_agents(self) -> None:
        # The distinction must not swallow the case it was carved out of:
        # the tree WAS read, and it does not carry this file.
        (self.root / "untracked.py").write_text("print('x')\n", encoding="utf-8")
        (self.root / "kept.py").write_text("line one\nCHANGED\n", encoding="utf-8")
        session = _session()
        untracked = classify_evidence_ref(
            "untracked.py:1", workspace_root=self.root, target_sha=self.sha,
            probe_session=session,
        )
        changed = classify_evidence_ref(
            "kept.py:2", workspace_root=self.root, target_sha=self.sha,
            probe_session=session,
        )
        self.assertEqual(untracked.trust_grade, "worktree_candidate")
        self.assertEqual(changed.trust_grade, "worktree_candidate")
        self.assertEqual(session.stalled_attempts, 0)

    def test_the_validator_names_the_unreadable_baseline_as_unavailable(self) -> None:
        absent_sha = "0123456789abcdef0123456789abcdef01234567"
        response = {
            "evidence_refs": ["kept.py:1"],
            "satisfaction_matrix": [{"id": "S1", "evidence_refs": ["kept.py:1"]}],
        }
        result = validate_agent_response_evidence(
            response=response, workspace_root=self.root,
            request={"target_sha": absent_sha, "allowed_scope": ["**"]},
        )
        self.assertFalse(result["valid"])
        self.assertEqual(
            {e.get("code") for e in result["errors"]},
            {"agent_evidence_verification_unavailable"},
        )


if __name__ == "__main__":
    unittest.main()
