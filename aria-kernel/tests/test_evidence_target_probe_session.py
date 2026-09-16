"""The evidence-target proof runs on the decision's probe session, tri-state.

`_verified_evidence_target_sha` (ARIA-HIGH-022) proves that an
`evidence_target_sha` override exists and descends from the request's base.
Until 2026-09-12 it spawned its own unbounded `git cat-file` and
`git merge-base`, and the CLI's `--evidence-target-sha auto` resolved HEAD
with a third unbounded `git rev-parse` of its own. A git that did not
answer hung the submit child until the executor killed it; a git that
answered slowly was indistinguishable from a request pointing at a commit
that is not there — a GovernanceError, the request's fault, its requeue
budget charged.

Pinned here:

* the proof runs on the decision's `GitProbeSession` (bounded, retried,
  one clock with the ref classification that follows);
* git ANSWERING "no" stays the request's fault (unknown commit, not a
  descendant); git NOT answering is `EvidenceTargetUnavailable`, never a
  `GovernanceError`;
* a decision whose proof could not run rejects under
  `agent_evidence_verification_unavailable` only — the harness-class code
  the executor releases without charging the request — and its refs are
  graded through the same session, so none of them can read as the agent's
  disagreement with a tree nobody could open;
* `auto` resolves HEAD inside the kernel on that same session.
"""
from __future__ import annotations

import os
import shutil
import stat
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from aria_kernel import evidence_probe
from aria_kernel.agent_invocations import (
    EVIDENCE_TARGET_AUTO,
    EvidenceTargetUnavailable,
    _verified_evidence_target_sha,
    submit_claim_result,
)
from aria_kernel.evidence_probe import PROBE_TIMEOUT, GitProbeSession
from aria_kernel.evidence_trust import classify_evidence_ref
from aria_kernel.evidence_validator import (
    AGENT_EVIDENCE_VERIFICATION_UNAVAILABLE_CODE,
    EVIDENCE_VERIFICATION_UNAVAILABLE_CODES,
)
from aria_kernel.tool_registry import GovernanceError

_TESTS = Path(__file__).resolve().parent
if str(_TESTS) not in sys.path:
    sys.path.insert(0, str(_TESTS))

import test_agent_submit_result_e2e as _submit_e2e  # noqa: E402

_REAL_GIT = shutil.which("git")


def _short_session() -> GitProbeSession:
    return GitProbeSession(
        attempt_timeout_seconds=0.2, attempts=2, backoff_seconds=(0.01,), liveness_seconds=5.0,
    )


class _ScriptedGit:
    """A `git` on PATH that stalls on the subcommands named and delegates the rest."""

    def __init__(self, *stall_on: str) -> None:
        self._stall_on = stall_on

    def __enter__(self) -> "_ScriptedGit":
        self._dir = Path(tempfile.mkdtemp(prefix="aria-scripted-git-"))
        cases = "|".join(f"*{verb}*" for verb in self._stall_on)
        fake = self._dir / "git"
        fake.write_text(
            "#!/bin/sh\n"
            f'case " $* " in {cases}) exec sleep 5;; esac\n'
            f'exec "{_REAL_GIT}" "$@"\n',
            encoding="utf-8",
        )
        fake.chmod(fake.stat().st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)
        self._env = mock.patch.dict(
            os.environ, {"PATH": f"{self._dir}{os.pathsep}{os.environ.get('PATH', '')}"},
        )
        self._env.start()
        return self

    def __exit__(self, *exc: object) -> None:
        self._env.stop()
        shutil.rmtree(self._dir, ignore_errors=True)


def _repo(root: Path) -> tuple[str, str]:
    """base -> head, with one file changed at head. Returns (base, head)."""
    def git(*args: str) -> str:
        return subprocess.run(
            ["git", "-c", "commit.gpgsign=false", *args],
            cwd=str(root), text=True, capture_output=True, check=True,
        ).stdout.strip()

    git("init", "-q", "--initial-branch=main")
    git("config", "user.email", "t@example.invalid")
    git("config", "user.name", "t")
    (root / "touched.py").write_text("BASE = 1\n", encoding="utf-8")
    git("add", "touched.py")
    git("commit", "-qm", "base")
    base = git("rev-parse", "HEAD")
    (root / "touched.py").write_text("BASE = 1\nFIX = 2\n", encoding="utf-8")
    git("add", "touched.py")
    git("commit", "-qm", "fix")
    return base, git("rev-parse", "HEAD")


class TheProofIsTriState(unittest.TestCase):
    def setUp(self) -> None:
        self.root = Path(tempfile.mkdtemp(prefix="aria-target-proof-"))
        self.base, self.head = _repo(self.root)

    def tearDown(self) -> None:
        shutil.rmtree(self.root, ignore_errors=True)

    def _prove(self, override: str, session: GitProbeSession | None = None) -> str | None:
        return _verified_evidence_target_sha(
            workspace_root=self.root,
            request={"target_sha": self.base},
            override=override,
            probes=session if session is not None else _short_session(),
        )

    def test_a_descendant_is_proven_on_the_session(self) -> None:
        session = _short_session()
        self.assertEqual(self._prove(self.head, session), self.head)
        # The session now knows the target; the classification that follows
        # asks git nothing more about it.
        self.assertTrue(session.resolve_baseline(self.root, self.head).readable)

    def test_auto_resolves_head_inside_the_kernel(self) -> None:
        self.assertEqual(self._prove(EVIDENCE_TARGET_AUTO), self.head)

    def test_auto_in_a_directory_that_is_no_repository_degrades_to_the_base(self) -> None:
        # git ANSWERS that there is no HEAD here: the request's base stays
        # the anchor (`None`), the pre-existing fail-closed degrade.
        empty = Path(tempfile.mkdtemp(prefix="aria-no-repo-"))
        try:
            self.assertIsNone(_verified_evidence_target_sha(
                workspace_root=empty, request={"target_sha": self.base},
                override=EVIDENCE_TARGET_AUTO, probes=_short_session(),
            ))
        finally:
            shutil.rmtree(empty, ignore_errors=True)

    def test_git_answering_no_stays_the_requests_fault(self) -> None:
        with self.assertRaisesRegex(GovernanceError, "unknown_commit"):
            self._prove("f" * 40)
        # A commit that exists but does not descend from base: the base is
        # `head`'s ancestor, not the other way round.
        with self.assertRaisesRegex(GovernanceError, "not_descendant_of_base"):
            _verified_evidence_target_sha(
                workspace_root=self.root, request={"target_sha": self.head},
                override=self.base, probes=_short_session(),
            )

    def test_git_not_answering_the_existence_probe_is_unavailable_and_remembered(self) -> None:
        session = _short_session()
        with _ScriptedGit("rev-parse"):
            with self.assertRaises(EvidenceTargetUnavailable) as caught:
                self._prove(self.head, session)
            self.assertNotIsInstance(caught.exception, GovernanceError)
            self.assertEqual(caught.exception.requested, self.head)
            self.assertEqual(caught.exception.reason, PROBE_TIMEOUT)
            # The same session, asked to grade a ref at that target, inherits
            # the non-answer: nothing is compared, nothing reads as the
            # agent's disagreement.
            envelope = classify_evidence_ref(
                "touched.py:2", workspace_root=self.root, target_sha=self.head, probe_session=session,
            )
        self.assertEqual(envelope.trust_grade, "verification_unavailable")
        self.assertGreater(session.stalled_attempts, 0)

    def test_git_not_answering_the_descent_probe_is_unavailable(self) -> None:
        with _ScriptedGit("merge-base"):
            with self.assertRaises(EvidenceTargetUnavailable) as caught:
                self._prove(self.head)
        self.assertEqual(caught.exception.requested, self.head)
        self.assertEqual(caught.exception.reason, PROBE_TIMEOUT)

    def test_the_default_session_is_the_production_one(self) -> None:
        # A caller that passes no session gets the production bounds — the
        # same `GitProbeSession` defaults every decision uses.
        with mock.patch.object(evidence_probe.GitProbeSession, "run", autospec=True) as run:
            run.return_value = evidence_probe.ProbeOutcome(
                answered=True, returncode=0, stdout=(self.head + "\n").encode(), stderr="",
                unavailable_reason=None, attempts=1,
            )
            self.assertEqual(_verified_evidence_target_sha(
                workspace_root=self.root, request={}, override=self.head,
            ), self.head)
        session = run.call_args.args[0]
        self.assertEqual(session.attempt_timeout_seconds, evidence_probe.GIT_PROBE_ATTEMPT_TIMEOUT_SECONDS)
        self.assertEqual(session.attempts, evidence_probe.GIT_PROBE_ATTEMPTS)


class TheDecisionRejectsUnderTheHarnessCode(unittest.TestCase):
    """Uses the submit fixture; only git's answers differ."""

    def setUp(self) -> None:
        self.e2e = _submit_e2e.SubmitResultE2ETests()
        self.e2e.setUp()

    def tearDown(self) -> None:
        self.e2e.tearDown()

    def _submit(self, *, nonce: str, override: str) -> dict:
        request, claim = self.e2e._claim(nonce=nonce)
        out = self.e2e._good_envelope(request=request, claim=claim)
        transcript = self.e2e._transcript_artifact(request, claim)
        # The decision constructs its session by name at call time; a short
        # one stands in so the stall costs the test a second, not 93 of them.
        with mock.patch.object(evidence_probe, "GitProbeSession", new=lambda **kw: _short_session()):
            return submit_claim_result(
                claim_id=claim["claim_id"],
                agent_id="judge-worker-001",
                lease_token=claim["lease_token"],
                output_path=out,
                workspace_root=self.e2e.repo,
                base_dir=self.e2e.tools,
                evidence_target_sha=override,
                **self.e2e._binding_kwargs(request, transcript),
            )

    def _head(self) -> str:
        return subprocess.run(
            ["git", "rev-parse", "HEAD"], cwd=str(self.e2e.repo), text=True, capture_output=True, check=True,
        ).stdout.strip()

    def test_a_proof_that_could_not_run_rejects_with_only_unavailable_codes(self) -> None:
        head = self._head()
        with _ScriptedGit("rev-parse"):
            result = self._submit(nonce="-target-unavailable", override=head)
        self.assertEqual(result["status"], "rejected")
        self.assertTrue(result["rejection_codes"])
        self.assertEqual(len(result["rejection_codes"]), len(result["reasons"]))
        self.assertTrue(set(result["rejection_codes"]) <= EVIDENCE_VERIFICATION_UNAVAILABLE_CODES)
        self.assertIn(AGENT_EVIDENCE_VERIFICATION_UNAVAILABLE_CODE, result["rejection_codes"])
        self.assertTrue(any("evidence_target_sha_unavailable" in r for r in result["reasons"]))

    def test_a_descent_proof_that_could_not_run_rejects_the_same_way(self) -> None:
        head = self._head()
        with _ScriptedGit("merge-base"):
            result = self._submit(nonce="-descent-unavailable", override=head)
        self.assertEqual(result["status"], "rejected")
        self.assertTrue(set(result["rejection_codes"]) <= EVIDENCE_VERIFICATION_UNAVAILABLE_CODES)

    def test_auto_at_head_is_accepted_when_git_answers(self) -> None:
        result = self._submit(nonce="-auto", override=EVIDENCE_TARGET_AUTO)
        self.assertEqual(result["status"], "accepted", result.get("reasons"))


if __name__ == "__main__":
    unittest.main()
