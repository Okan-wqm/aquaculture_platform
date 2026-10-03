"""Kapalı Döngü D3 — accepted consensus becomes a durable, remembered finding.

Pins the missing half of the memory: a confirmed TRUE positive is promoted
exactly once per fingerprint into aria-findings/ (the same place the report
reader and the plan-candidate scanner now resolve via finding.findings_dir),
and the sampler stops re-judging settled fingerprints — symmetric with the
long-standing confirmed-FP suppression.

ARIA-HIGH-325 — what a promotion stands on: the adapter finding it promotes,
resolved by fingerprint from the raw-findings ledger, is the subject and the
location; the refs the judges cited must be admissible for the producing
tool (its declared scope, never ARIA's detector source outside it).
"""
from __future__ import annotations

import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path

from aria_kernel.feedback_store import (
    _promoted_fingerprints,
    append_jsonl,
    finding_fingerprint,
    raw_findings_path,
    record_operator_feedback,
)
from aria_kernel.finding import findings_dir
from aria_kernel.finding_promotion import promote_consensus_findings

from tests._helpers.rule_contracts import DEFAULT_RULE_CONTRACT, register_contracted_tool

_REPO_FILES = (
    "apps/target.ts",
    "web/modules/alpha/vite.config.ts",
    "web/modules/zeta/vite.config.ts",
    "tools/aria-adapters/bundle-budget-adapter.ts",
)


class _PromotionCase(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        # ARIA-AUDIT-015: consensus promotion is operator-gated; tests
        # provision the recorded acknowledgment the gate resolves.
        self._saved_ack = os.environ.pop("ARIA_CONSENSUS_PROMOTION_ACK", None)
        os.environ["ARIA_CONSENSUS_PROMOTION_ACK"] = "operator-approved-tests"
        self.addCleanup(
            (lambda v: (lambda: os.environ.__setitem__("ARIA_CONSENSUS_PROMOTION_ACK", v) if v else os.environ.pop("ARIA_CONSENSUS_PROMOTION_ACK", None)))(self._saved_ack)
        )
        self.repo = Path(self.tmp.name) / "repo"
        for rel in _REPO_FILES:
            (self.repo / rel).parent.mkdir(parents=True, exist_ok=True)
            (self.repo / rel).write_text("export const x = 1;\nexport const y = 2;\nexport const z = 3;\n")
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
        # The producing tools, registered with their rule contracts the way
        # the cycle's manifest sync registers the shipped adapters.
        register_contracted_tool(self.tools, "tool-a", rules={"some_rule": dict(DEFAULT_RULE_CONTRACT)}, declared_scope=["apps/**"])

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def _seed(self, *, tool_id: str = "tool-a", rule: str = "some_rule", path: str = "apps/target.ts",
              line: int = 1, finding_id: str = "f-1") -> str:
        """Record the adapter finding a consensus row judges; returns its fingerprint."""
        finding = {
            "id": finding_id, "rule": rule, "severity": "high", "path": path, "line": line,
            "message": "m", "evidence": [{"path": path, "line": line}],
        }
        fingerprint = finding_fingerprint(tool_id, finding)
        append_jsonl(
            raw_findings_path(self.tools),
            {
                "schema_version": 1, "tool_id": tool_id, "run_id": "run-1", "cycle_id": "cyc-x",
                "finding_id": finding_id, "finding_fingerprint": fingerprint, "status": "raw",
                "finding": finding,
            },
        )
        return fingerprint

    def _consensus_row(self, fingerprint: str, *, refs: list[str], verdict: str = "true_positive",
                       tool_id: str = "tool-a", severity: str = "high") -> None:
        record_operator_feedback(
            tool_id=tool_id,
            run_id="run-1",
            finding_id="f-1",
            verdict=verdict,
            severity=severity,
            note="AI consensus from 2 independent judges",
            source_type="ai_consensus",
            judge_id="aria-consensus-arbiter",
            confidence=0.9,
            judgment_group_id=f"judge:{tool_id}:run-1:f-1",
            finding_fingerprint=fingerprint,
            evidence_refs=refs,
            # JJ-1 — every consensus row must state its judge backing.
            # TWO here on purpose: finding promotion is deliberately NOT
            # anchor-gated (a promoted finding is a reviewable work item,
            # not ground truth), so this row proves the two lanes stayed
            # separate rather than silently converging on the anchor floor.
            judge_count=2,
            judges_voted=2,
            base_dir=self.tools,
        )

    def _promoted_docs(self) -> list[dict]:
        return [json.loads(path.read_text()) for path in sorted(findings_dir(self.repo).glob("F-*.json"))]


class FindingPromotionTests(_PromotionCase):
    def test_true_positive_promotes_once_and_lands_where_readers_look(self) -> None:
        fingerprint = self._seed()
        self._consensus_row(fingerprint, refs=["apps/target.ts:1"])
        first = promote_consensus_findings(repo_root=self.repo, base_dir=self.tools)
        self.assertEqual(first["promoted_count"], 1)
        docs = list(findings_dir(self.repo).glob("F-*.json"))
        self.assertEqual(len(docs), 1)
        # Idempotent: the fingerprint is settled; nothing re-promotes.
        second = promote_consensus_findings(repo_root=self.repo, base_dir=self.tools)
        self.assertEqual(second["promoted_count"], 0)
        self.assertIn(fingerprint, _promoted_fingerprints(self.tools))

    def test_false_positive_and_missing_evidence_do_not_promote(self) -> None:
        self._consensus_row(self._seed(), refs=["apps/target.ts:1"], verdict="false_positive")
        ghost = self._seed(path="apps/does-not-exist.ts", finding_id="f-ghost")
        self._consensus_row(ghost, refs=["apps/does-not-exist.ts:1"])
        result = promote_consensus_findings(repo_root=self.repo, base_dir=self.tools)
        self.assertEqual(result["promoted_count"], 0)
        self.assertEqual(
            [row["reason"] for row in result["skipped"]],
            ["no_repo_verified_evidence"],
        )

    def test_empty_fingerprint_skips_visibly_not_silently(self) -> None:
        # ORPHAN-HIGH-765 — a consensus row settled from pre-threading judge
        # verdicts carries an empty fingerprint and can never promote. The
        # skip must be RECORDED with its reason: an invisible skip is
        # indistinguishable from "nothing to promote", which is the silence
        # that hid 24,788 live raw findings promoting to zero for months.
        self._consensus_row("", refs=["apps/target.ts:1"])
        result = promote_consensus_findings(repo_root=self.repo, base_dir=self.tools)
        self.assertEqual(result["promoted_count"], 0)
        self.assertEqual(len(result["skipped"]), 1)
        self.assertEqual(result["skipped"][0]["reason"], "missing_finding_fingerprint")
        self.assertEqual(result["skipped"][0]["judgment_group_id"], "judge:tool-a:run-1:f-1")
        self.assertEqual(list(findings_dir(self.repo).glob("F-*.json")), [])

    def test_sampler_skips_settled_fingerprints(self) -> None:
        # Deliberate-break of the K4 asymmetry: a promoted fingerprint must
        # be invisible to judgment sampling, exactly like a confirmed FP.
        from aria_kernel.feedback_store import _sampleable_raw_findings

        fingerprint = self._seed()
        self._consensus_row(fingerprint, refs=["apps/target.ts:1"])
        promote_consensus_findings(repo_root=self.repo, base_dir=self.tools)
        append_jsonl(
            raw_findings_path(self.tools),
            {
                "schema_version": 1,
                "tool_id": "tool-a",
                "run_id": "run-2",
                "cycle_id": "cyc-x",
                "finding_id": "f-2",
                "finding_fingerprint": fingerprint,
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


class PromotionStandsOnTheSubjectAndAdmissibleEvidence(_PromotionCase):
    """ARIA-HIGH-325 — the location is the adapter finding's own path, and
    ARIA's detector source never supports a promotion."""

    def setUp(self) -> None:
        super().setUp()
        register_contracted_tool(
            self.tools, "bundle-budget-adapter",
            rules={"bundle_budget_not_enforced": dict(DEFAULT_RULE_CONTRACT, claim_type="absence_in_scope", severity_cap="LOW")},
            declared_scope=["web/**/*.{ts,tsx,js,json}"],
        )

    def test_the_summary_names_the_subject_not_the_first_ref(self) -> None:
        fingerprint = self._seed(
            tool_id="bundle-budget-adapter", rule="bundle_budget_not_enforced",
            path="web/modules/zeta/vite.config.ts", finding_id="bundle-budget:not-enforced:web/modules/zeta",
        )
        self._consensus_row(
            fingerprint, tool_id="bundle-budget-adapter",
            refs=["web/modules/alpha/vite.config.ts:1", "web/modules/zeta/vite.config.ts:3"],
        )
        result = promote_consensus_findings(repo_root=self.repo, base_dir=self.tools)
        self.assertEqual(result["promoted_count"], 1, result["skipped"])
        (doc,) = self._promoted_docs()
        self.assertIn("at web/modules/zeta/vite.config.ts:1 ", doc["claim_summary"])
        self.assertNotIn("web/modules/alpha", doc["claim_summary"])

    def test_a_detector_source_ref_is_never_promotion_evidence(self) -> None:
        fingerprint = self._seed(
            tool_id="bundle-budget-adapter", rule="bundle_budget_not_enforced",
            path="web/modules/zeta/vite.config.ts", finding_id="bundle-budget:not-enforced:web/modules/zeta",
        )
        self._consensus_row(
            fingerprint, tool_id="bundle-budget-adapter",
            refs=["tools/aria-adapters/bundle-budget-adapter.ts:1", "web/modules/zeta/vite.config.ts:1"],
        )
        result = promote_consensus_findings(repo_root=self.repo, base_dir=self.tools)
        self.assertEqual(result["promoted_count"], 0)
        self.assertEqual(self._promoted_docs(), [])
        (skip,) = result["skipped"]
        self.assertEqual(skip["reason"], "inadmissible_evidence")
        self.assertEqual(skip["refused"], {"tools/aria-adapters/bundle-budget-adapter.ts:1": "aria_detector_source"})

    def test_a_consensus_whose_adapter_finding_is_unknown_is_not_promoted(self) -> None:
        self._consensus_row("finding:not-in-any-ledger", refs=["apps/target.ts:1"])
        result = promote_consensus_findings(repo_root=self.repo, base_dir=self.tools)
        self.assertEqual([row["reason"] for row in result["skipped"]], ["adapter_finding_unresolved"])

    def test_a_rule_with_no_contract_is_not_promoted(self) -> None:
        fingerprint = self._seed(rule="rule_nobody_declared")
        self._consensus_row(fingerprint, refs=["apps/target.ts:1"])
        result = promote_consensus_findings(repo_root=self.repo, base_dir=self.tools)
        self.assertEqual([row["reason"] for row in result["skipped"]], ["rule_contract_undeclared"])


if __name__ == "__main__":
    unittest.main()
