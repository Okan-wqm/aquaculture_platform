"""Kapalı Döngü D4 — per-rule health, quarantine, and the repair channel.

Seven of the first night's ten verdicts were false positives all naming the
same mechanical matcher defect, and those diagnoses went nowhere: no
per-rule FP rate existed, nothing could silence one broken rule of a
healthy adapter, and "the judges say this matcher is broken" produced no
work item. These tests pin the closed loop: ground-truth-only stats,
threshold quarantine, sampler exclusion, and the one-per-rule defect
finding.
"""
from __future__ import annotations

import subprocess
import tempfile
import unittest
from pathlib import Path

from aria_kernel.feedback_store import (
    ANCHOR_MIN_JUDGE_COUNT,
    _sampleable_raw_findings,
    append_jsonl,
    raw_findings_path,
    record_operator_feedback,
)
from aria_kernel.rule_health import (
    commit_rule_defect_findings,
    quarantined_rules,
    rule_stats,
)


class RuleHealthTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.tools = Path(self.tmp.name) / "aria-tools"

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def _raw(self, fingerprint: str, rule: str, finding_id: str = "f-1", run_id: str = "run-1") -> None:
        append_jsonl(
            raw_findings_path(self.tools),
            {
                "schema_version": 1,
                "tool_id": "security-boundary-adapter",
                "run_id": run_id,
                "cycle_id": "cyc-1",
                "finding_id": finding_id,
                "finding_fingerprint": fingerprint,
                "status": "raw",
                "finding": {
                    "id": finding_id,
                    "rule": rule,
                    "path": "apps/x.ts",
                    "message": "m",
                    "severity": "medium",
                },
            },
        )

    def _verdict(
        self,
        fingerprint: str,
        verdict: str,
        *,
        source: str = "ai_consensus",
        n: int = 1,
        judges: int = ANCHOR_MIN_JUDGE_COUNT,
    ) -> None:
        for i in range(n):
            record_operator_feedback(
                tool_id="security-boundary-adapter",
                run_id=f"run-{fingerprint}-{i}",
                finding_id=f"f-{fingerprint}-{i}",
                verdict=verdict,
                severity="medium",
                note="gt",
                source_type=source,
                judge_id="aria-consensus-arbiter",
                finding_fingerprint=fingerprint,
                judgment_group_id=f"judge:t:{fingerprint}:{i}",
                judge_count=judges if source == "ai_consensus" else None,
                judges_voted=judges if source == "ai_consensus" else None,
                # G-2 — the receipt an anchor now needs. Only consensus
                # rows at anchor grade carry it; a 2-judge row settles
                # precision and never truth, so it needs none.
                observers=(
                    [
                        {"judge_id": "aria-evidence-judge", "model": "claude-opus-5"},
                        {"judge_id": "aria-adversarial-judge", "model": "claude-opus-5"},
                        {"judge_id": "aria-consensus-arbiter", "model": "fable"},
                    ][:judges]
                    if source == "ai_consensus" and judges >= 3
                    else None
                ),
                base_dir=self.tools,
            )

    def test_stats_count_only_ground_truth(self) -> None:
        """JJ-1 (ORPHAN-HIGH-731) REWROTE this pin.

        It used to read "ai_consensus counts, ai_judge does not", which
        blessed every 2-judge pair as ground truth. The successor truth is
        narrower: an ANCHOR consensus counts, a 2-judge consensus does not,
        and a lone judge still does not. Both rejected rows are asserted so
        a regression to either looseness fails here.
        """
        self._raw("fp-a", "public_write_endpoint_without_allowlist")
        self._verdict("fp-a", "false_positive", source="ai_consensus")
        self._verdict("fp-a", "false_positive", source="ai_judge")  # not GT
        self._verdict("fp-a", "false_positive", source="ai_consensus", judges=2)
        stats = rule_stats(self.tools)
        key = ("security-boundary-adapter", "public_write_endpoint_without_allowlist")
        self.assertEqual(stats[key]["false_positive"], 1)
        self.assertEqual(stats[key]["judged"], 1)

    def test_two_judge_consensus_cannot_quarantine_a_rule(self) -> None:
        """Deliberate breakage: the volume that used to quarantine a rule no
        longer does when it is carried by unexamined pairs. Three 2-judge
        false positives are three opinions from two judges, not evidence."""
        self._raw("fp-pair", "pair_only_rule")
        self._verdict("fp-pair", "false_positive", n=3, judges=2)
        self.assertEqual(quarantined_rules(self.tools), set())
        self._verdict("fp-pair", "false_positive", n=3)
        self.assertEqual(
            quarantined_rules(self.tools),
            {("security-boundary-adapter", "pair_only_rule")},
        )

    def test_quarantine_needs_volume_and_fp_rate(self) -> None:
        self._raw("fp-b", "noisy_rule")
        self._verdict("fp-b", "false_positive", n=2)
        self.assertEqual(quarantined_rules(self.tools), set())  # judged < 3
        self._verdict("fp-b", "false_positive", n=1)
        self.assertEqual(
            quarantined_rules(self.tools),
            {("security-boundary-adapter", "noisy_rule")},
        )

    def test_sampler_excludes_quarantined_rule(self) -> None:
        self._raw("fp-c", "noisy_rule", finding_id="f-c")
        self._verdict("fp-c", "false_positive", n=3)
        self._raw("fp-d", "noisy_rule", finding_id="f-d", run_id="run-9")
        candidates = _sampleable_raw_findings(
            tool_id="security-boundary-adapter", cycle_id=None, base_dir=self.tools
        )
        self.assertEqual(candidates, [])

    def test_defect_finding_committed_once_per_rule(self) -> None:
        repo = Path(self.tmp.name) / "repo"
        (repo / "tools" / "aria-adapters").mkdir(parents=True)
        (repo / "tools" / "aria-adapters" / "security-boundary-adapter.ts").write_text("// adapter\n")
        subprocess.run(["git", "init", "-q", str(repo)], check=True)
        subprocess.run(["git", "-C", str(repo), "add", "-A"], check=True)
        subprocess.run(
            ["git", "-C", str(repo), "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "seed"],
            check=True,
        )
        self._raw("fp-e", "noisy_rule")
        self._verdict("fp-e", "false_positive", n=3)
        first = commit_rule_defect_findings(repo_root=repo, base_dir=self.tools)
        self.assertEqual(first["committed_count"], 1)
        again = commit_rule_defect_findings(repo_root=repo, base_dir=self.tools)
        self.assertEqual(again["committed_count"], 0)


if __name__ == "__main__":
    unittest.main()
