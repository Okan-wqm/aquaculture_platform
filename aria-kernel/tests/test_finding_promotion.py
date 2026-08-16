"""Kapalı Döngü D3 — accepted consensus becomes a durable, remembered finding.

Pins the missing half of the memory: a confirmed TRUE positive is promoted
exactly once per fingerprint into aria-findings/ (the same place the report
reader and the plan-candidate scanner now resolve via finding.findings_dir),
and the sampler stops re-judging settled fingerprints — symmetric with the
long-standing confirmed-FP suppression.
"""
from __future__ import annotations

import subprocess
import tempfile
import unittest
from pathlib import Path

from aria_kernel.feedback_store import (
    _promoted_fingerprints,
    record_operator_feedback,
)
from aria_kernel.finding import findings_dir
from aria_kernel.finding_promotion import promote_consensus_findings


class FindingPromotionTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.repo = Path(self.tmp.name) / "repo"
        (self.repo / "apps").mkdir(parents=True)
        (self.repo / "apps" / "target.ts").write_text("export const x = 1;\n")
        subprocess.run(["git", "init", "-q", str(self.repo)], check=True)
        subprocess.run(
            ["git", "-C", str(self.repo), "add", "-A"], check=True
        )
        subprocess.run(
            [
                "git", "-C", str(self.repo),
                "-c", "user.email=t@t", "-c", "user.name=t",
                "commit", "-qm", "seed",
            ],
            check=True,
        )
        self.tools = Path(self.tmp.name) / "aria-tools"

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def _consensus_row(self, fingerprint: str, *, refs: list[str], verdict: str = "true_positive") -> None:
        record_operator_feedback(
            tool_id="tool-a",
            run_id="run-1",
            finding_id="f-1",
            verdict=verdict,
            severity="high",
            note="AI consensus from 2 independent judges",
            source_type="ai_consensus",
            judge_id="aria-consensus-arbiter",
            confidence=0.9,
            judgment_group_id="judge:tool-a:run-1:f-1",
            finding_fingerprint=fingerprint,
            evidence_refs=refs,
            base_dir=self.tools,
        )

    def test_true_positive_promotes_once_and_lands_where_readers_look(self) -> None:
        self._consensus_row("fp-1", refs=["apps/target.ts:1"])
        first = promote_consensus_findings(repo_root=self.repo, base_dir=self.tools)
        self.assertEqual(first["promoted_count"], 1)
        docs = list(findings_dir(self.repo).glob("F-*.json"))
        self.assertEqual(len(docs), 1)
        # Idempotent: the fingerprint is settled; nothing re-promotes.
        second = promote_consensus_findings(repo_root=self.repo, base_dir=self.tools)
        self.assertEqual(second["promoted_count"], 0)
        self.assertIn("fp-1", _promoted_fingerprints(self.tools))

    def test_false_positive_and_missing_evidence_do_not_promote(self) -> None:
        self._consensus_row("fp-fp", refs=["apps/target.ts:1"], verdict="false_positive")
        self._consensus_row("fp-ghost", refs=["apps/does-not-exist.ts:1"])
        result = promote_consensus_findings(repo_root=self.repo, base_dir=self.tools)
        self.assertEqual(result["promoted_count"], 0)
        self.assertEqual(
            [row["reason"] for row in result["skipped"]],
            ["no_repo_verified_evidence"],
        )

    def test_sampler_skips_settled_fingerprints(self) -> None:
        # Deliberate-break of the K4 asymmetry: a promoted fingerprint must
        # be invisible to judgment sampling, exactly like a confirmed FP.
        from aria_kernel.feedback_store import _sampleable_raw_findings, append_jsonl, raw_findings_path

        self._consensus_row("fp-settled", refs=["apps/target.ts:1"])
        promote_consensus_findings(repo_root=self.repo, base_dir=self.tools)
        append_jsonl(
            raw_findings_path(self.tools),
            {
                "schema_version": 1,
                "tool_id": "tool-a",
                "run_id": "run-2",
                "cycle_id": "cyc-x",
                "finding_id": "f-2",
                "finding_fingerprint": "fp-settled",
                "status": "raw",
                "finding": {
                    "id": "f-2",
                    "rule": "some_rule",
                    "path": "apps/target.ts",
                    "message": "m",
                    "severity": "medium",
                },
            },
        )
        candidates = _sampleable_raw_findings(
            tool_id="tool-a", cycle_id=None, base_dir=self.tools
        )
        self.assertEqual(candidates, [])


if __name__ == "__main__":
    unittest.main()
