"""Plan 031 Faz 031e — expert-reviewer consensus gate tests.

What this suite pins:
- select_expert_reviewers routes affected files to topic-relevant experts and
  tops a single-domain fix up to >=2 independent reviewers; min_reviewers<2 is
  rejected (the independence rule).
- evaluate_expert_consensus approves only on >=2 distinct reviewers + unanimous
  satisfied + mean confidence >=0.80 + every evidence_ref resolving in the repo.
- A hallucinated evidence_ref (a file:line that does not exist) yields
  evidence_not_repo_verified — a reviewer that dreams cannot approve a fix.
- enforce_expert_consensus_gate raises to block the PR on any failure, escalates
  to HUMAN_REQUIRED specifically on the hallucination case, and emits an
  expert_consensus_check governance event on every run.
"""
from __future__ import annotations

import json
import shutil
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


class SelectExpertReviewersTests(unittest.TestCase):
    def test_single_domain_topped_up_to_two(self) -> None:
        experts = select_expert_reviewers(
            affected_files=["apps/farm-service/src/farm.service.ts"],
        )
        self.assertIn("farm-expert", experts)
        self.assertGreaterEqual(len(experts), 2)

    def test_multi_domain_already_independent(self) -> None:
        experts = select_expert_reviewers(
            affected_files=[
                "apps/auth-service/src/jwt.guard.ts",
                "apps/farm-service/src/farm.service.ts",
            ],
        )
        self.assertGreaterEqual(len({*experts}), 2)
        self.assertIn("farm-expert", experts)

    def test_min_reviewers_below_two_rejected(self) -> None:
        with self.assertRaises(GovernanceError):
            select_expert_reviewers(
                affected_files=["apps/farm-service/src/farm.service.ts"],
                min_reviewers=1,
            )


class EvaluateExpertConsensusTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="aria-expert-"))
        self.repo = self.tmp / "repo"
        self.repo.mkdir()
        (self.repo / "real.ts").write_text("export const x = 1;\n", encoding="utf-8")

    def tearDown(self) -> None:
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_approves_unanimous_verified(self) -> None:
        result = evaluate_expert_consensus(
            verdicts=[
                _verdict("farm-expert", evidence_refs=["real.ts:1"]),
                _verdict("security-reviewer", evidence_refs=["real.ts:1"]),
            ],
            workspace_root=self.repo,
        )
        self.assertTrue(result["approved"], msg=result)

    def test_insufficient_reviewers(self) -> None:
        result = evaluate_expert_consensus(
            verdicts=[_verdict("farm-expert", evidence_refs=["real.ts:1"])],
            workspace_root=self.repo,
        )
        self.assertFalse(result["approved"])
        self.assertEqual(result["reason"], "insufficient_reviewers")

    def test_not_unanimous(self) -> None:
        result = evaluate_expert_consensus(
            verdicts=[
                _verdict("farm-expert", evidence_refs=["real.ts:1"]),
                _verdict("security-reviewer", verdict="blocked",
                         evidence_refs=["real.ts:1"]),
            ],
            workspace_root=self.repo,
        )
        self.assertFalse(result["approved"])
        self.assertEqual(result["reason"], "not_unanimous_satisfied")

    def test_low_confidence(self) -> None:
        result = evaluate_expert_consensus(
            verdicts=[
                _verdict("farm-expert", confidence=0.5, evidence_refs=["real.ts:1"]),
                _verdict("security-reviewer", confidence=0.5,
                         evidence_refs=["real.ts:1"]),
            ],
            workspace_root=self.repo,
        )
        self.assertFalse(result["approved"])
        self.assertEqual(result["reason"], "low_confidence")

    def test_hallucinated_evidence_rejected(self) -> None:
        result = evaluate_expert_consensus(
            verdicts=[
                _verdict("farm-expert", evidence_refs=["real.ts:1"]),
                _verdict("security-reviewer",
                         evidence_refs=["does/not/exist.ts:42"]),
            ],
            workspace_root=self.repo,
        )
        self.assertFalse(result["approved"])
        self.assertEqual(result["reason"], "evidence_not_repo_verified")
        self.assertEqual(result["unverifiable_refs"][0]["trust_grade"], "missing")


class EnforceExpertConsensusGateTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="aria-expert-gate-"))
        self.tools = self.tmp / "aria-tools"
        ensure_tools_dir(self.tools)
        self.repo = self.tmp / "repo"
        self.repo.mkdir()
        (self.repo / "real.ts").write_text("export const x = 1;\n", encoding="utf-8")

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
                _verdict("security-reviewer", evidence_refs=["real.ts:1"]),
            ],
            workspace_root=self.repo,
            base_dir=self.tools,
        )
        self.assertTrue(result["approved"])
        self.assertIn("expert_consensus_check", self._governance_kinds())

    def test_hallucination_blocks_and_escalates(self) -> None:
        with self.assertRaises(GovernanceError) as cm:
            enforce_expert_consensus_gate(
                change_id="chg-halluc",
                verdicts=[
                    _verdict("farm-expert", evidence_refs=["real.ts:1"]),
                    _verdict("security-reviewer",
                             evidence_refs=["ghost/file.ts:99"]),
                ],
                workspace_root=self.repo,
                base_dir=self.tools,
            )
        self.assertIn("expert_consensus_evidence_verified_failed", str(cm.exception))
        pending = list_human_required(base_dir=self.tools)
        self.assertEqual(len(pending), 1)
        self.assertEqual(pending[0]["context"]["kind"], "expert_consensus_hallucination")

    def test_insufficient_reviewers_blocks_without_escalation(self) -> None:
        with self.assertRaises(GovernanceError):
            enforce_expert_consensus_gate(
                change_id="chg-one",
                verdicts=[_verdict("farm-expert", evidence_refs=["real.ts:1"])],
                workspace_root=self.repo,
                base_dir=self.tools,
            )
        # Structural failure (not hallucination) → no HUMAN_REQUIRED escalation.
        self.assertEqual(list_human_required(base_dir=self.tools), [])


if __name__ == "__main__":
    unittest.main()
