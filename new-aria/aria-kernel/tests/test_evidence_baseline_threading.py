"""An agent must not be blamed for a baseline its harness never supplied.

Observed live on 2026-08-09, on the first agent run to survive the runtime
fixes: the agent worked for ten minutes, passed pre-submit validation, and had
its result rejected with **44** `agent_evidence_not_repo_verified` reasons —
every single ref a real file it had genuinely read.

The cause was not the agent. `classify_evidence_ref` grades a ref
`repo_verified` only when its content matches the git blob at `target_sha`, and
the autonomy lane minted its requests with **no target_sha at all**. With none,
`_resolve_target_sha` returns None, the `repo_verified` branch is never
attempted, and every ref falls through to `worktree_candidate` — a grade that
asserts the agent's evidence disagrees with the committed tree.

The convergence lane already threaded the SHA and its helper says why in the
same words: *"without it EVERY real ref is worktree_candidate and convergence
can never complete."* One lane knew; the other did not.

So two things are fixed and pinned here: the autonomy lane threads the
baseline, and a MISSING baseline is no longer reported as unverified evidence.
Both remain rejections under `require_repo_verified` — nothing was verified —
but they now say whose gap it is.
"""
from __future__ import annotations

import inspect
import subprocess
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

from aria_kernel import autonomy_orchestrator
from aria_kernel.evidence_trust import classify_evidence_ref


def _repo_with_one_commit(root: Path) -> str:
    def git(*args: str) -> str:
        return subprocess.run(
            ["git", *args], cwd=str(root), text=True, capture_output=True, check=True
        ).stdout.strip()

    git("init", "-q")
    git("config", "user.email", "t@example.invalid")
    git("config", "user.name", "t")
    (root / "kept.py").write_text("line one\nline two\n", encoding="utf-8")
    git("add", "kept.py")
    git("commit", "-qm", "seed")
    return git("rev-parse", "HEAD")


class BaselineGradeTest(unittest.TestCase):
    def test_a_missing_baseline_is_not_reported_as_unverified_evidence(self) -> None:
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            _repo_with_one_commit(root)

            envelope = classify_evidence_ref("kept.py:1", workspace_root=root, target_sha=None)

        # The file is real and unmodified. Calling this `worktree_candidate`
        # would assert a disagreement that was never tested for.
        self.assertEqual(envelope.trust_grade, "baseline_unavailable")

    def test_the_same_ref_verifies_once_a_baseline_is_supplied(self) -> None:
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            sha = _repo_with_one_commit(root)

            envelope = classify_evidence_ref("kept.py:1", workspace_root=root, target_sha=sha)

        self.assertEqual(envelope.trust_grade, "repo_verified")

    def test_a_genuinely_modified_file_is_still_worktree_candidate(self) -> None:
        # The distinction must not swallow the case it was carved out of: with
        # a baseline present, evidence that disagrees with it is still the
        # agent's problem and must keep saying so.
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            sha = _repo_with_one_commit(root)
            (root / "kept.py").write_text("line one\nCHANGED\n", encoding="utf-8")

            envelope = classify_evidence_ref("kept.py:2", workspace_root=root, target_sha=sha)

        self.assertEqual(envelope.trust_grade, "worktree_candidate")

    def test_a_missing_file_is_still_missing(self) -> None:
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            _repo_with_one_commit(root)

            envelope = classify_evidence_ref("absent.py:1", workspace_root=root, target_sha=None)

        self.assertEqual(envelope.trust_grade, "missing")


class AutonomyLaneThreadsTheBaselineTest(unittest.TestCase):
    def test_the_drain_accepts_the_workspace_it_must_resolve_the_sha_from(self) -> None:
        params = inspect.signature(autonomy_orchestrator._drain_next_cycle_queue).parameters

        self.assertIn("workspace_root", params)

    def test_it_uses_the_same_helper_the_convergence_lane_uses(self) -> None:
        # One helper, both lanes. A second implementation is how the two came
        # to disagree in the first place.
        source = inspect.getsource(autonomy_orchestrator._drain_next_cycle_queue)

        self.assertIn("_resolve_workspace_head_sha", source)
        self.assertIn("target_sha=target_sha", source)


if __name__ == "__main__":
    unittest.main()
