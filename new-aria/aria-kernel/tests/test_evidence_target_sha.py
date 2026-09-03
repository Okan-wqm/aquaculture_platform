"""Layer-4 fix — evidence refs verify as repo_verified against the plan's SHA.

Live-diagnosed 2026-07-03 (cycle 28656402488): after ORPHAN-312 the challenger
cited the REAL code (web/modules/hr-module/.../LeavesPage.tsx:346), but the
evidence-validator still REJECTED it — the challenger request carried
target_sha=None, so classify_evidence_ref graded every real file as
worktree_candidate (not repo_verified) and EvidencePolicy.require_repo_verified
rejected it. Without a target_sha threaded through the envelopes, convergence
can NEVER complete regardless of evidence correctness. This suite pins:
target_sha=HEAD => repo_verified; None => worktree_candidate; and every
convergence envelope forwards target_sha.
"""
from __future__ import annotations

import inspect
import subprocess
import tempfile
import unittest
from pathlib import Path

from aria_kernel.convergence_drainer import _resolve_workspace_head_sha
from aria_kernel.convergent_planning_bridge import issue_challenger_envelope
from aria_kernel.cross_review_bridge import (
    issue_completeness_critic_envelope,
    issue_cross_review_envelope,
    issue_primary_envelope,
)
from aria_kernel.evidence_trust import classify_evidence_ref
from tests._helpers.git_fixtures import make_local_git_repo


class TargetShaGrading(unittest.TestCase):
    def _repo_with_committed_file(self, tmp: Path) -> tuple[Path, str]:
        repo = make_local_git_repo(tmp, name="ws")
        f = repo / "web" / "modules" / "hr-module" / "src" / "pages" / "leaves"
        f.mkdir(parents=True)
        (f / "LeavesPage.tsx").write_text("\n".join(f"line {i}" for i in range(1, 400)), encoding="utf-8")
        subprocess.run(["git", "add", "-A"], cwd=repo, check=True, capture_output=True)
        subprocess.run(["git", "commit", "-q", "-m", "add leaves page"], cwd=repo, check=True, capture_output=True)
        head = subprocess.run(
            ["git", "rev-parse", "HEAD"], cwd=repo, text=True, capture_output=True, check=True,
        ).stdout.strip()
        return repo, head

    def test_head_sha_makes_real_ref_repo_verified(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            repo, head = self._repo_with_committed_file(Path(tmp))
            env = classify_evidence_ref(
                "web/modules/hr-module/src/pages/leaves/LeavesPage.tsx:346",
                workspace_root=repo,
                target_sha=head,
            )
            self.assertEqual(env.trust_grade, "repo_verified")

    def test_no_target_sha_is_reported_as_a_missing_baseline(self) -> None:
        # This test was written to DOCUMENT the live bug — its original comment
        # read "no target_sha => real, valid file => rejected" — not to bless
        # it. The rejection is still correct (nothing was verified), but the
        # grade no longer accuses the agent of evidence that disagrees with the
        # committed tree when no comparison was ever attempted. See
        # ORPHAN-HIGH-594: a blameless agent had 44 refs rejected this way.
        with tempfile.TemporaryDirectory() as tmp:
            repo, _ = self._repo_with_committed_file(Path(tmp))
            env = classify_evidence_ref(
                "web/modules/hr-module/src/pages/leaves/LeavesPage.tsx:346",
                workspace_root=repo,
                target_sha=None,
            )
            self.assertEqual(env.trust_grade, "baseline_unavailable")

    def test_resolve_workspace_head_sha(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            repo, head = self._repo_with_committed_file(Path(tmp))
            self.assertEqual(_resolve_workspace_head_sha(repo), head)

    def test_resolve_head_sha_none_outside_git(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            self.assertIsNone(_resolve_workspace_head_sha(Path(tmp)))


class EnvelopesForwardTargetSha(unittest.TestCase):
    def test_all_four_convergence_envelopes_accept_target_sha(self) -> None:
        for fn in (
            issue_challenger_envelope,
            issue_primary_envelope,
            issue_cross_review_envelope,
            issue_completeness_critic_envelope,
        ):
            self.assertIn(
                "target_sha", inspect.signature(fn).parameters, fn.__name__,
            )

    def test_drainer_threads_target_sha_to_every_mint(self) -> None:
        from aria_kernel import convergence_drainer
        src = inspect.getsource(convergence_drainer.run_convergence_drainer)
        self.assertIn("target_sha = _resolve_workspace_head_sha(workspace_root)", src)
        # CL-1 (ORPHAN-725): the resumable step has one mint per state
        # branch — the invariant is DERIVED, not a magic number: every
        # issue_* envelope mint in the source forwards target_sha.
        mint_count = sum(src.count(f"{name}(") for name in (
            "issue_challenger_envelope",
            "issue_cross_review_envelope",
            "issue_primary_envelope",
            "issue_completeness_critic_envelope",
        ))
        self.assertGreaterEqual(mint_count, 4)
        self.assertEqual(src.count("target_sha=target_sha"), mint_count)


if __name__ == "__main__":
    unittest.main()
