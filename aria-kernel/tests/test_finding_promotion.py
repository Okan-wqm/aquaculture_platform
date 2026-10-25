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

F2.3 (PLAN-v2 §2 'Bulgu kabul çıtası') — ONE acceptance bar: a consensus row
promotes only when it is ground truth (``feedback_store.is_ground_truth_row``,
the anchor) AND every ref it stands on is repo_verified by ``evidence_trust``
at the row's own ``target_sha``. The seam is fail-closed per row: a row that
fails the bar is refused by name and never stops a later row.
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
from aria_kernel import finding_promotion
from aria_kernel.finding_promotion import promote_consensus_findings
from aria_kernel.tool_registry import GovernanceError

from tests._helpers.rule_contracts import DEFAULT_RULE_CONTRACT, register_contracted_tool

_REPO_FILES = (
    "apps/target.ts",
    "web/modules/alpha/vite.config.ts",
    "web/modules/zeta/vite.config.ts",
    "tools/aria-adapters/bundle-budget-adapter.ts",
)

# The default target of a fixture consensus row: the commit setUp seeded.
_AT_FIXTURE_HEAD = "at-fixture-head"


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
        # The commit the judges judged: every consensus row is minted at it.
        self.head = self._git("rev-parse", "HEAD")
        self.tools = Path(self.tmp.name) / "aria-tools"
        # The producing tools, registered with their rule contracts the way
        # the cycle's manifest sync registers the shipped adapters.
        register_contracted_tool(self.tools, "tool-a", rules={"some_rule": dict(DEFAULT_RULE_CONTRACT)}, declared_scope=["apps/**"])

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def _git(self, *args: str) -> str:
        return subprocess.run(
            ["git", "-C", str(self.repo), "-c", "user.email=t@t", "-c", "user.name=t", *args],
            check=True, capture_output=True, text=True,
        ).stdout.strip()

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
                       tool_id: str = "tool-a", severity: str = "high", finding_id: str = "f-1",
                       judge_count: int = 3, judges_voted: int = 3,
                       target_sha: str | None = _AT_FIXTURE_HEAD) -> None:
        """A consensus row as the mint writes it. The default is an ANCHOR
        (three distinct seats agreed, nobody dissented) minted at the
        fixture's commit — the only row the one acceptance bar admits; the
        F2.3 tests below lower one leg at a time."""
        record_operator_feedback(
            tool_id=tool_id,
            run_id="run-1",
            finding_id=finding_id,
            verdict=verdict,
            severity=severity,
            note=f"AI consensus from {judges_voted} judges",
            source_type="ai_consensus",
            judge_id="aria-consensus-arbiter",
            confidence=0.9,
            judgment_group_id=f"judge:{tool_id}:run-1:{finding_id}",
            finding_fingerprint=fingerprint,
            evidence_refs=refs,
            judge_count=judge_count,
            judges_voted=judges_voted,
            observers=[
                {"judge_id": "aria-evidence-judge", "model": "claude-opus-5"},
                {"judge_id": "aria-adversarial-judge", "model": "claude-opus-5"},
                {"judge_id": "aria-consensus-arbiter", "model": "fable"},
            ][:judges_voted],
            target_sha=self.head if target_sha == _AT_FIXTURE_HEAD else target_sha,
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
        # F2.3 — the missing file is refused by the ONE evidence bar
        # (evidence_trust at target_sha), named with the ref it refused.
        (skip,) = result["skipped"]
        self.assertEqual(
            (skip["finding_fingerprint"], skip["reason"], set(skip.get("refused") or {})),
            (ghost, "evidence_not_verified_at_target_sha", {"apps/does-not-exist.ts:1"}),
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


class PromotionTakesClaimTypeAndSeverityFromTheContract(_PromotionCase):
    """ARIA-MEDIUM-326 — promotion stamped every finding wrong_code and folded
    critical into HIGH. The rule's manifest contract decides both."""

    def _promote_one(self, *, tool_id: str, rule: str, contract: dict, severity: str) -> dict:
        register_contracted_tool(self.tools, tool_id, rules={rule: contract}, declared_scope=["apps/**"])
        fingerprint = self._seed(tool_id=tool_id, rule=rule)
        self._consensus_row(fingerprint, tool_id=tool_id, refs=["apps/target.ts:1"], severity=severity)
        result = promote_consensus_findings(repo_root=self.repo, base_dir=self.tools)
        self.assertEqual(result["promoted_count"], 1, result["skipped"])
        (doc,) = self._promoted_docs()
        return doc

    def test_a_test_gap_promotion_is_an_absence_in_scope(self) -> None:
        doc = self._promote_one(
            tool_id="test-gap-adapter", rule="security_source_without_security_test",
            contract=dict(DEFAULT_RULE_CONTRACT, claim_type="absence_in_scope", severity_cap="HIGH"),
            severity="high",
        )
        self.assertEqual((doc["claim_type"], doc["severity"]), ("absence_in_scope", "HIGH"))

    def test_a_critical_consensus_stays_critical(self) -> None:
        doc = self._promote_one(
            tool_id="tenant-scoping-adapter", rule="tenant_repository_unscoped_read",
            contract=dict(DEFAULT_RULE_CONTRACT, severity_cap="CRITICAL"),
            severity="critical",
        )
        self.assertEqual((doc["claim_type"], doc["severity"]), ("wrong_code", "CRITICAL"))

    def test_the_cap_bounds_the_severity(self) -> None:
        doc = self._promote_one(
            tool_id="bundle-budget-adapter", rule="bundle_budget_not_enforced",
            contract=dict(DEFAULT_RULE_CONTRACT, claim_type="absence_in_scope", severity_cap="LOW"),
            severity="high",
        )
        self.assertEqual((doc["claim_type"], doc["severity"]), ("absence_in_scope", "LOW"))

    def test_doc_staleness_is_a_currency_gap_stating_its_defect(self) -> None:
        contract = dict(DEFAULT_RULE_CONTRACT, claim_type="currency_gap", severity_cap="MEDIUM",
                        defect_claim="A document describes a path that no longer exists.")
        doc = self._promote_one(tool_id="doc-staleness-adapter", rule="doc_references_missing_path",
                                contract=contract, severity="medium")
        self.assertEqual((doc["claim_type"], doc["severity"]), ("currency_gap", "MEDIUM"))
        self.assertIn("A document describes a path that no longer exists.", doc["claim_summary"])

class OneAcceptanceBar(_PromotionCase):
    """F2.3 — promotion requires is_ground_truth_row AND evidence verified at
    the row's target_sha (evidence_trust), fail-closed per row.

    New API pinned here (the seam's refusal vocabulary, beside the existing
    ``inadmissible_evidence`` shape): ``not_ground_truth`` for a row the anchor
    rule rejects, and ``evidence_not_verified_at_target_sha`` with
    ``refused: {ref: trust_grade}`` for a row whose evidence the committed
    tree at its target does not hold."""

    def _refusal(self, result: dict, fingerprint: str) -> dict:
        refusals = [skip for skip in result["skipped"] if skip.get("finding_fingerprint") == fingerprint]
        self.assertEqual(len(refusals), 1, result["skipped"])
        return refusals[0]

    def test_a_two_judge_consensus_is_not_ground_truth_and_does_not_promote(self) -> None:
        fingerprint = self._seed()
        self._consensus_row(fingerprint, refs=["apps/target.ts:1"], judge_count=2, judges_voted=2)
        result = promote_consensus_findings(repo_root=self.repo, base_dir=self.tools)
        self.assertEqual(result["promoted_count"], 0)
        self.assertEqual(self._promoted_docs(), [])
        self.assertEqual(self._refusal(result, fingerprint)["reason"], "not_ground_truth")

    def test_a_weighted_majority_over_a_dissenter_does_not_promote(self) -> None:
        # Two of three agreed: the arbiter minted to refute the pair dissented.
        # The majority settles the adapter-precision lane, never a finding.
        fingerprint = self._seed()
        self._consensus_row(fingerprint, refs=["apps/target.ts:1"], judge_count=2, judges_voted=3)
        result = promote_consensus_findings(repo_root=self.repo, base_dir=self.tools)
        self.assertEqual(result["promoted_count"], 0)
        self.assertEqual(self._promoted_docs(), [])
        self.assertEqual(self._refusal(result, fingerprint)["reason"], "not_ground_truth")

    def test_evidence_present_in_the_worktree_but_not_at_target_sha_does_not_promote(self) -> None:
        # The judges judged self.head; the subject file was committed AFTER it.
        # The working tree (and HEAD) hold it, the judged commit does not.
        judged = self.head
        (self.repo / "apps/later.ts").write_text("export const later = 1;\n")
        self._git("add", "apps/later.ts")
        self._git("commit", "-qm", "later")
        fingerprint = self._seed(path="apps/later.ts", finding_id="f-later")
        self._consensus_row(fingerprint, refs=["apps/later.ts:1"], finding_id="f-later", target_sha=judged)
        result = promote_consensus_findings(repo_root=self.repo, base_dir=self.tools)
        self.assertEqual(result["promoted_count"], 0)
        self.assertEqual(self._promoted_docs(), [])
        refusal = self._refusal(result, fingerprint)
        self.assertEqual(refusal["reason"], "evidence_not_verified_at_target_sha")
        self.assertEqual(set(refusal.get("refused") or {}), {"apps/later.ts:1"})

    def test_a_row_that_names_no_target_sha_fails_closed(self) -> None:
        # Unknown is never green: with no commit to verify at, nothing was verified.
        fingerprint = self._seed()
        self._consensus_row(fingerprint, refs=["apps/target.ts:1"], target_sha=None)
        result = promote_consensus_findings(repo_root=self.repo, base_dir=self.tools)
        self.assertEqual(result["promoted_count"], 0)
        self.assertEqual(self._refusal(result, fingerprint)["reason"], "evidence_not_verified_at_target_sha")

    def test_one_bad_ref_refuses_its_row_by_name_and_the_next_row_still_promotes(self) -> None:
        # The first row cites a file that exists in the working tree only
        # (never committed): the old working-tree precheck admitted it and the
        # emission raised, aborting every later promotion of the batch.
        (self.repo / "apps/untracked.ts").write_text("export const u = 1;\n")
        bad = self._seed(path="apps/untracked.ts", finding_id="f-bad")
        self._consensus_row(bad, refs=["apps/untracked.ts:1"], finding_id="f-bad")
        good = self._seed(finding_id="f-good")
        self._consensus_row(good, refs=["apps/target.ts:1"], finding_id="f-good")
        try:
            result = promote_consensus_findings(repo_root=self.repo, base_dir=self.tools)
        except GovernanceError as exc:
            self.fail(f"one bad ref stopped the whole promotion batch: {exc}")
        self.assertEqual([row["finding_fingerprint"] for row in result["promoted"]], [good])
        refusal = self._refusal(result, bad)
        self.assertEqual(refusal["reason"], "evidence_not_verified_at_target_sha")
        self.assertEqual(set(refusal.get("refused") or {}), {"apps/untracked.ts:1"})

    def test_the_promoter_keeps_no_evidence_check_of_its_own(self) -> None:
        # One owner: evidence existence is evidence_trust's at target_sha; the
        # working-tree is_file copy is deleted, not left beside it.
        self.assertFalse(hasattr(finding_promotion, "_repo_file_refs"))


if __name__ == "__main__":
    unittest.main()
