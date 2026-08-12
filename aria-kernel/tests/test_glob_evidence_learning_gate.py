"""E5/M1 — glob evidence unblocks belief learning.

Live proof of the defect: every one of the four belief-emitting adapters
cites glob evidence (apps/**/*.ts, libs/event-contracts/src/schemas/
*.schema.ts), the classifier graded a glob "missing", require_repo_verified
rejected it, and ARIA learned 0 beliefs from any tool (beliefs.jsonl held
only 3 hardcoded discovery beliefs). A belief is a proposition about a
CLASS of files, so a glob matching real committed files is honest belief
evidence. A FINDING must still cite one concrete file:line.
"""
from __future__ import annotations

import subprocess
import tempfile
import unittest
from pathlib import Path

from aria_kernel.evidence_trust import EvidencePolicy, classify_evidence_ref
from aria_kernel.tool_registry import GovernanceError


class GlobEvidenceTrustTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.repo = Path(self.tmp.name) / "repo"
        (self.repo / "apps" / "farm-service" / "src").mkdir(parents=True)
        (self.repo / "apps" / "farm-service" / "src" / "a.entity.ts").write_text("export class A {}\n")
        (self.repo / "apps" / "farm-service" / "src" / "b.entity.ts").write_text("export class B {}\n")
        subprocess.run(["git", "init", "-q", str(self.repo)], check=True)
        subprocess.run(["git", "-C", str(self.repo), "add", "-A"], check=True)
        subprocess.run(
            ["git", "-C", str(self.repo), "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "seed"],
            check=True,
        )

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def _classify(self, ref: str):
        return classify_evidence_ref(
            ref, workspace_root=self.repo, context="memory_belief", target_sha="HEAD"
        )

    def test_committed_glob_is_repo_glob_verified(self) -> None:
        env = self._classify("apps/farm-service/src/*.entity.ts")
        self.assertEqual(env.trust_grade, "repo_glob_verified")
        self.assertTrue(env.is_glob)
        self.assertEqual(env.glob_match_count, 2)
        # Belief policy accepts it; finding policy does NOT.
        EvidencePolicy.require_repo_or_glob_verified(env)  # no raise
        with self.assertRaises(GovernanceError):
            EvidencePolicy.require_repo_verified(env)

    def test_glob_matching_only_uncommitted_is_not_verified(self) -> None:
        (self.repo / "apps" / "farm-service" / "src" / "c.new.ts").write_text("x\n")
        env = self._classify("apps/farm-service/src/*.new.ts")
        self.assertNotEqual(env.trust_grade, "repo_glob_verified")

    def test_empty_glob_is_distinct_from_missing(self) -> None:
        env = self._classify("apps/does-not-exist/**/*.ts")
        self.assertEqual(env.trust_grade, "empty_glob")

    def test_concrete_file_still_repo_verified(self) -> None:
        env = self._classify("apps/farm-service/src/a.entity.ts")
        self.assertEqual(env.trust_grade, "repo_verified")
        self.assertFalse(env.is_glob)
        EvidencePolicy.require_repo_verified(env)  # findings still pass


class BeliefLearnsFromGlobTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.repo = Path(self.tmp.name) / "repo"
        (self.repo / "apps" / "svc" / "src").mkdir(parents=True)
        (self.repo / "apps" / "svc" / "src" / "x.entity.ts").write_text("export class X {}\n")
        subprocess.run(["git", "init", "-q", str(self.repo)], check=True)
        subprocess.run(["git", "-C", str(self.repo), "add", "-A"], check=True)
        subprocess.run(
            ["git", "-C", str(self.repo), "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "seed"],
            check=True,
        )

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def test_validate_repo_evidence_accepts_glob_for_belief(self) -> None:
        from aria_kernel.memory import validate_repo_evidence

        # Pre-E5 this raised evidence_ref_not_repo_verified:...:missing.
        validate_repo_evidence(
            ["apps/svc/src/*.entity.ts"], workspace_root=self.repo
        )  # no raise = belief evidence admitted

    def test_validate_repo_evidence_still_rejects_bare_missing(self) -> None:
        from aria_kernel.memory import validate_repo_evidence

        with self.assertRaises(GovernanceError):
            validate_repo_evidence(
                ["apps/svc/src/ghost.ts"], workspace_root=self.repo
            )


if __name__ == "__main__":
    unittest.main()
