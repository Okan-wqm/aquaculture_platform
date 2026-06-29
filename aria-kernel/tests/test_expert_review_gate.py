"""Plan 031 §031e + Plan 031-R R3 — expert-reviewer consensus gate tests.

What this suite pins:
- select_expert_reviewers routes to topic experts and tops a single-domain fix
  up to >=2 independent reviewers; min_reviewers<2 is rejected.
- evaluate_expert_consensus approves ONLY on: a base_sha present, >=2 distinct
  reviewers, unanimous satisfied, mean confidence >=0.80, EVERY reviewer citing
  >=1 evidence ref, and EVERY ref repo_verified at the base SHA.
- R3 hardening: missing base_sha, an empty evidence list, a worktree_candidate
  ref, a nonexistent line, and a nonexistent file are all rejected.
- enforce_expert_consensus_gate blocks the PR on any failure, escalates to
  HUMAN_REQUIRED on the hallucination (unverifiable) case, and logs a governance
  event every run.
"""
from __future__ import annotations

import json
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

from aria_kernel.expert_review_gate import (
    enforce_expert_consensus_gate,
    evaluate_expert_consensus,
    select_expert_reviewers,
)
from aria_kernel.human_required import list_human_required
from aria_kernel.tool_registry import GovernanceError, ensure_tools_dir


def _verdict(expert: str, *, verdict: str = "satisfied", confidence: float = 1.0,
             evidence_refs: list[str] | None = None) -> dict:
    row: dict = {"expert": expert, "verdict": verdict, "confidence": confidence}
    if evidence_refs is not None:
        row["evidence_refs"] = evidence_refs
    if verdict in ("blocked", "contradicted"):
        row["note"] = "rejected for test"
    return row


def _git(repo: Path, *args: str) -> str:
    return subprocess.run(["git", "-C", str(repo), *args],
                          capture_output=True, text=True, check=True).stdout.strip()


def _repo_with_committed_file(tmp: Path, rel: str, content: str) -> tuple[Path, str]:
    """Init a git repo with a committed file; return (repo, base_sha)."""
    repo = tmp / "repo"
    repo.mkdir()
    _git(repo, "init", "-q")
    _git(repo, "config", "user.email", "t@t")
    _git(repo, "config", "user.name", "t")
    (repo / rel).parent.mkdir(parents=True, exist_ok=True)
    (repo / rel).write_text(content, encoding="utf-8")
    _git(repo, "add", "-A")
    _git(repo, "commit", "-q", "-m", "init")
    return repo, _git(repo, "rev-parse", "HEAD")


class SelectExpertReviewersTests(unittest.TestCase):
    def test_single_domain_topped_up_to_two(self) -> None:
        experts = select_expert_reviewers(
            affected_files=["apps/farm-service/src/farm.service.ts"],
        )
        self.assertIn("farm-expert", experts)
        self.assertGreaterEqual(len(experts), 2)

    def test_min_reviewers_below_two_rejected(self) -> None:
        with self.assertRaises(GovernanceError):
            select_expert_reviewers(
                affected_files=["apps/farm-service/src/farm.service.ts"],
                min_reviewers=1,
            )


class EvaluateExpertConsensusTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="aria-expert-"))
        # real.ts has exactly 3 lines.
        self.repo, self.sha = _repo_with_committed_file(
            self.tmp, "real.ts", "export const a = 1;\nexport const b = 2;\nexport const c = 3;\n",
        )

    def tearDown(self) -> None:
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _two_good(self) -> list[dict]:
        return [
            _verdict("farm-expert", evidence_refs=["real.ts:1"]),
            _verdict("security-reviewer", evidence_refs=["real.ts:2"]),
        ]

    def test_approves_unanimous_repo_verified(self) -> None:
        result = evaluate_expert_consensus(
            verdicts=self._two_good(), workspace_root=self.repo, base_sha=self.sha,
        )
        self.assertTrue(result["approved"], msg=result)

    def test_base_sha_required(self) -> None:
        result = evaluate_expert_consensus(
            verdicts=self._two_good(), workspace_root=self.repo, base_sha=None,
        )
        self.assertFalse(result["approved"])
        self.assertEqual(result["reason"], "base_sha_required")

    def test_insufficient_reviewers(self) -> None:
        result = evaluate_expert_consensus(
            verdicts=[_verdict("farm-expert", evidence_refs=["real.ts:1"])],
            workspace_root=self.repo, base_sha=self.sha,
        )
        self.assertEqual(result["reason"], "insufficient_reviewers")

    def test_not_unanimous(self) -> None:
        result = evaluate_expert_consensus(
            verdicts=[
                _verdict("farm-expert", evidence_refs=["real.ts:1"]),
                _verdict("security-reviewer", verdict="blocked", evidence_refs=["real.ts:2"]),
            ],
            workspace_root=self.repo, base_sha=self.sha,
        )
        self.assertEqual(result["reason"], "not_unanimous_satisfied")

    def test_low_confidence(self) -> None:
        result = evaluate_expert_consensus(
            verdicts=[
                _verdict("farm-expert", confidence=0.5, evidence_refs=["real.ts:1"]),
                _verdict("security-reviewer", confidence=0.5, evidence_refs=["real.ts:2"]),
            ],
            workspace_root=self.repo, base_sha=self.sha,
        )
        self.assertEqual(result["reason"], "low_confidence")

    def test_missing_evidence_refs_rejected(self) -> None:
        result = evaluate_expert_consensus(
            verdicts=[
                _verdict("farm-expert", evidence_refs=["real.ts:1"]),
                _verdict("security-reviewer"),  # no evidence_refs at all
            ],
            workspace_root=self.repo, base_sha=self.sha,
        )
        self.assertFalse(result["approved"])
        self.assertEqual(result["reason"], "missing_evidence_refs")

    def test_worktree_candidate_rejected(self) -> None:
        # An uncommitted file exists on disk but is not in the git blob at base_sha.
        (self.repo / "uncommitted.ts").write_text("x\n", encoding="utf-8")
        result = evaluate_expert_consensus(
            verdicts=[
                _verdict("farm-expert", evidence_refs=["real.ts:1"]),
                _verdict("security-reviewer", evidence_refs=["uncommitted.ts:1"]),
            ],
            workspace_root=self.repo, base_sha=self.sha,
        )
        self.assertFalse(result["approved"])
        self.assertEqual(result["reason"], "evidence_not_repo_verified")
        self.assertEqual(result["unverifiable_refs"][0]["trust_grade"], "worktree_candidate")

    def test_nonexistent_line_rejected(self) -> None:
        result = evaluate_expert_consensus(
            verdicts=[
                _verdict("farm-expert", evidence_refs=["real.ts:1"]),
                _verdict("security-reviewer", evidence_refs=["real.ts:999"]),  # file has 3 lines
            ],
            workspace_root=self.repo, base_sha=self.sha,
        )
        self.assertFalse(result["approved"])
        self.assertEqual(result["reason"], "evidence_not_repo_verified")
        self.assertEqual(result["unverifiable_refs"][0]["trust_grade"], "invalid")

    def test_nonexistent_file_rejected(self) -> None:
        result = evaluate_expert_consensus(
            verdicts=[
                _verdict("farm-expert", evidence_refs=["real.ts:1"]),
                _verdict("security-reviewer", evidence_refs=["ghost/file.ts:1"]),
            ],
            workspace_root=self.repo, base_sha=self.sha,
        )
        self.assertFalse(result["approved"])
        self.assertEqual(result["unverifiable_refs"][0]["trust_grade"], "missing")


class EnforceExpertConsensusGateTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="aria-expert-gate-"))
        self.tools = self.tmp / "aria-tools"
        ensure_tools_dir(self.tools)
        self.repo, self.sha = _repo_with_committed_file(
            self.tmp, "real.ts", "a\nb\nc\n",
        )

    def tearDown(self) -> None:
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _governance_kinds(self) -> list[str]:
        gov = (self.tools / "governance.jsonl").read_text(encoding="utf-8")
        return [json.loads(line)["kind"] for line in gov.splitlines() if line.strip()]

    def test_approved_passes_and_logs(self) -> None:
        result = enforce_expert_consensus_gate(
            change_id="chg-ok",
            verdicts=[
                _verdict("farm-expert", evidence_refs=["real.ts:1"]),
                _verdict("security-reviewer", evidence_refs=["real.ts:2"]),
            ],
            workspace_root=self.repo, base_dir=self.tools, base_sha=self.sha,
        )
        self.assertTrue(result["approved"])
        self.assertIn("expert_consensus_check", self._governance_kinds())

    def test_hallucination_blocks_and_escalates(self) -> None:
        with self.assertRaises(GovernanceError) as cm:
            enforce_expert_consensus_gate(
                change_id="chg-halluc",
                verdicts=[
                    _verdict("farm-expert", evidence_refs=["real.ts:1"]),
                    _verdict("security-reviewer", evidence_refs=["ghost/file.ts:99"]),
                ],
                workspace_root=self.repo, base_dir=self.tools, base_sha=self.sha,
            )
        self.assertIn("expert_consensus_evidence_verified_failed", str(cm.exception))
        pending = list_human_required(base_dir=self.tools)
        self.assertEqual(len(pending), 1)
        self.assertEqual(pending[0]["context"]["kind"], "expert_consensus_hallucination")

    def test_missing_base_sha_blocks_without_escalation(self) -> None:
        with self.assertRaises(GovernanceError):
            enforce_expert_consensus_gate(
                change_id="chg-no-sha",
                verdicts=[
                    _verdict("farm-expert", evidence_refs=["real.ts:1"]),
                    _verdict("security-reviewer", evidence_refs=["real.ts:2"]),
                ],
                workspace_root=self.repo, base_dir=self.tools, base_sha=None,
            )
        self.assertEqual(list_human_required(base_dir=self.tools), [])


if __name__ == "__main__":
    unittest.main()
