from __future__ import annotations

import tempfile
import subprocess
import unittest
from pathlib import Path

from aria_kernel.evidence_trust import SELF_OUTPUT_PREFIXES, classify_evidence_ref


class EvidenceTrustTests(unittest.TestCase):
    def test_self_output_taxonomy_is_enterprise_wide(self) -> None:
        self.assertIn("aria-findings/", SELF_OUTPUT_PREFIXES)
        self.assertIn("aria-debts/", SELF_OUTPUT_PREFIXES)
        self.assertIn("aria-tools/", SELF_OUTPUT_PREFIXES)

    def test_non_git_repo_file_reports_a_missing_baseline(self) -> None:
        # A directory that is not a git repo has no baseline to verify
        # against, which is a different fact from "verified and did not
        # match". Both are refused by require_repo_verified; only one of them
        # is a statement about the agent.
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            path = root / "src" / "x.py"
            path.parent.mkdir(parents=True)
            path.write_text("one\ntwo\n", encoding="utf-8")
            envelope = classify_evidence_ref("src/x.py:2", workspace_root=root, source_hint="repo_source")
            self.assertEqual(envelope.canonical_ref, "src/x.py")
            self.assertEqual(envelope.line, 2)
            self.assertEqual(envelope.trust_grade, "baseline_unavailable")
            self.assertTrue(envelope.content_hash and envelope.content_hash.startswith("sha256:"))
            self.assertTrue(envelope.envelope_hash.startswith("sha256:"))

    def test_self_output_is_not_repo_verified(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            path = root / "aria-findings" / "F-001.json"
            path.parent.mkdir(parents=True)
            path.write_text("{}\n", encoding="utf-8")
            envelope = classify_evidence_ref("aria-findings/F-001.json", workspace_root=root)
            self.assertEqual(envelope.self_output_class, "aria_self_output")
            self.assertEqual(envelope.trust_grade, "self_output")

    def test_target_sha_requires_git_blob_for_repo_verified(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            subprocess.run(["git", "init", "-q"], cwd=root, check=True)
            subprocess.run(["git", "config", "user.email", "test@example.com"], cwd=root, check=True)
            subprocess.run(["git", "config", "user.name", "Test User"], cwd=root, check=True)
            committed = root / "src" / "committed.py"
            committed.parent.mkdir(parents=True)
            committed.write_text("print('ok')\n", encoding="utf-8")
            subprocess.run(["git", "add", "src/committed.py"], cwd=root, check=True)
            subprocess.run(["git", "commit", "-q", "-m", "seed"], cwd=root, check=True)
            target_sha = subprocess.run(
                ["git", "rev-parse", "HEAD"],
                cwd=root,
                text=True,
                capture_output=True,
                check=True,
            ).stdout.strip()
            untracked = root / "src" / "untracked.py"
            untracked.write_text("print('candidate')\n", encoding="utf-8")

            committed_env = classify_evidence_ref(
                "src/committed.py",
                workspace_root=root,
                target_sha=target_sha,
            )
            branch_env = classify_evidence_ref(
                "src/committed.py",
                workspace_root=root,
                target_sha="HEAD",
            )
            untracked_env = classify_evidence_ref(
                "src/untracked.py",
                workspace_root=root,
                target_sha=target_sha,
            )

            self.assertEqual(committed_env.trust_grade, "repo_verified")
            self.assertEqual(branch_env.trust_grade, "repo_verified")
            self.assertEqual(branch_env.target_sha, target_sha)
            self.assertEqual(untracked_env.trust_grade, "worktree_candidate")

    def test_target_sha_verifies_git_tree_for_directory_evidence(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            subprocess.run(["git", "init", "-q"], cwd=root, check=True)
            subprocess.run(["git", "config", "user.email", "test@example.com"], cwd=root, check=True)
            subprocess.run(["git", "config", "user.name", "Test User"], cwd=root, check=True)
            directory = root / "web" / "modules" / "missing-a"
            directory.mkdir(parents=True)
            (directory / "index.html").write_text("", encoding="utf-8")
            subprocess.run(["git", "add", "web/modules/missing-a/index.html"], cwd=root, check=True)
            subprocess.run(["git", "commit", "-q", "-m", "seed tree"], cwd=root, check=True)
            target_sha = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=root, text=True).strip()

            envelope = classify_evidence_ref(
                "web/modules/missing-a",
                workspace_root=root,
                target_sha=target_sha,
            )

            self.assertTrue(envelope.exists)
            self.assertEqual(envelope.trust_grade, "repo_verified")


if __name__ == "__main__":
    unittest.main()
