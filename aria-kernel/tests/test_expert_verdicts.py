"""Plan 031-R R2 — expert-verdict ledger tests.

What this suite pins:
- record_expert_verdicts appends a head-bound row; latest_verdict_for_change
  returns the most recent row for a change_id.
- assert_change_expert_approved fails closed when no row exists, the latest row
  is not approved, or its head_sha does not match the PR head (stale approval);
  passes only on an approved, head-matching row.
- enforce_expert_consensus_gate writes the ledger so the chokepoint can read it
  end-to-end.
"""
from __future__ import annotations

import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

from aria_kernel.expert_verdicts import (
    assert_change_expert_approved,
    latest_verdict_for_change,
    record_expert_verdicts,
)
from aria_kernel.tool_registry import GovernanceError, ensure_tools_dir


def _git(repo: Path, *args: str) -> str:
    return subprocess.run(["git", "-C", str(repo), *args],
                          capture_output=True, text=True, check=True).stdout.strip()


class ExpertVerdictLedgerTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="aria-verdicts-"))
        self.tools = self.tmp / "aria-tools"
        ensure_tools_dir(self.tools)

    def tearDown(self) -> None:
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _record(self, *, change_id="chg-1", head="head-1", approved=True, reason="") -> None:
        record_expert_verdicts(
            change_id=change_id, base_sha="base-1", head_sha=head,
            verdicts=[{"expert": "farm-expert", "verdict": "satisfied"}],
            approved=approved, reason=reason, base_dir=self.tools,
        )

    def test_missing_verdict_fails_closed(self) -> None:
        with self.assertRaises(GovernanceError) as cm:
            assert_change_expert_approved(change_id="nope", head_sha="h", base_dir=self.tools)
        self.assertIn("expert_consensus_verdict_missing", str(cm.exception))

    def test_not_approved_fails_closed(self) -> None:
        self._record(approved=False, reason="insufficient_reviewers")
        with self.assertRaises(GovernanceError) as cm:
            assert_change_expert_approved(change_id="chg-1", head_sha="head-1", base_dir=self.tools)
        self.assertIn("expert_consensus_not_approved", str(cm.exception))

    def test_head_drift_fails_closed(self) -> None:
        self._record(approved=True, head="head-OLD")
        with self.assertRaises(GovernanceError) as cm:
            assert_change_expert_approved(change_id="chg-1", head_sha="head-NEW", base_dir=self.tools)
        self.assertIn("expert_consensus_head_drift", str(cm.exception))

    def test_approved_head_match_passes(self) -> None:
        self._record(approved=True, head="head-1")
        row = assert_change_expert_approved(change_id="chg-1", head_sha="head-1", base_dir=self.tools)
        self.assertTrue(row["approved"])

    def test_latest_row_wins(self) -> None:
        self._record(approved=False, reason="low_confidence", head="head-1")
        self._record(approved=True, head="head-1")  # a later re-review approves
        row = latest_verdict_for_change(change_id="chg-1", base_dir=self.tools)
        self.assertTrue(row["approved"])


class GateWritesLedgerTests(unittest.TestCase):
    """The gate persists its verdict so the chokepoint reads it end-to-end."""

    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="aria-verdicts-gate-"))
        self.tools = self.tmp / "aria-tools"
        ensure_tools_dir(self.tools)
        self.repo = self.tmp / "repo"
        self.repo.mkdir()
        _git(self.repo, "init", "-q")
        _git(self.repo, "config", "user.email", "t@t")
        _git(self.repo, "config", "user.name", "t")
        (self.repo / "real.ts").write_text("a\nb\nc\n", encoding="utf-8")
        _git(self.repo, "add", "-A")
        _git(self.repo, "commit", "-q", "-m", "init")
        self.sha = _git(self.repo, "rev-parse", "HEAD")

    def tearDown(self) -> None:
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_gate_approval_lets_chokepoint_pass(self) -> None:
        from aria_kernel.expert_review_gate import enforce_expert_consensus_gate
        enforce_expert_consensus_gate(
            change_id="chg-e2e",
            verdicts=[
                {"expert": "farm-expert", "verdict": "satisfied", "confidence": 1.0,
                 "evidence_refs": ["real.ts:1"]},
                {"expert": "security-reviewer", "verdict": "satisfied", "confidence": 1.0,
                 "evidence_refs": ["real.ts:2"]},
            ],
            workspace_root=self.repo, head_sha=self.sha, base_dir=self.tools, base_sha=self.sha,
        )
        # The chokepoint can now read an approved, head-matching verdict.
        row = assert_change_expert_approved(
            change_id="chg-e2e", head_sha=self.sha, base_dir=self.tools,
        )
        self.assertTrue(row["approved"])


if __name__ == "__main__":
    unittest.main()
