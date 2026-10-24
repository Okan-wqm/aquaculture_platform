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

import dataclasses
import json
import shutil
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from aria_kernel import implementation_safety as safety
from aria_kernel.agent_routing import ROUTING_TABLE_REL, load_routing_table
from aria_kernel.expert_review_gate import (
    REVIEW_PANEL_REQUIRED_CHECKS,
    enforce_expert_consensus_gate,
    evaluate_expert_consensus,
    request_implementation_expert_reviews,
    select_expert_reviewers,
)
from aria_kernel.human_required import list_human_required
from aria_kernel.tool_registry import GovernanceError, ensure_tools_dir
from tests._helpers.pre_merge_evidence import fixture_pre_merge_evidence


def _verdict(expert: str, *, verdict: str = "satisfied", confidence: float = 1.0,
             evidence_refs: list[str] | None = None) -> dict:
    row: dict = {"expert": expert, "verdict": verdict, "confidence": confidence}
    if evidence_refs is not None:
        row["evidence_refs"] = evidence_refs
    if verdict in ("blocked", "contradicted"):
        row["note"] = "rejected for test"
    return row


_REPO_ROOT = Path(__file__).resolve().parents[2]


class SelectExpertReviewersTests(unittest.TestCase):
    # The live routing table, the one path -> agent map (SE-2).
    routing = load_routing_table(_REPO_ROOT)

    def test_single_domain_topped_up_to_two(self) -> None:
        experts = select_expert_reviewers(
            affected_files=["apps/farm-service/src/farm.service.ts"], routing=self.routing,
        )
        self.assertIn("farm-expert", experts)
        self.assertGreaterEqual(len(experts), 2)

    def test_multi_domain_already_independent(self) -> None:
        experts = select_expert_reviewers(
            affected_files=[
                "apps/auth-service/src/jwt.guard.ts",
                "apps/farm-service/src/farm.service.ts",
            ],
            routing=self.routing,
        )
        self.assertGreaterEqual(len({*experts}), 2)
        self.assertIn("farm-expert", experts)

    def test_min_reviewers_below_two_rejected(self) -> None:
        with self.assertRaises(GovernanceError):
            select_expert_reviewers(
                affected_files=["apps/farm-service/src/farm.service.ts"],
                routing=self.routing,
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
        pending = list_human_required(base_dir=self.tools).rows
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
        self.assertEqual(list_human_required(base_dir=self.tools).rows, [])


_FARM_SOURCE = "apps/farm-service/src/sample-interval.ts"
# The implementation checks the panel requires beside
# readonly_paths_untouched_at_merge; they hold in both cases below.
_IMPLEMENTATION_CHECKS = REVIEW_PANEL_REQUIRED_CHECKS - {"readonly_paths_untouched_at_merge"}


class ReviewPanelReadsOnlyAnUneditedTableTests(unittest.TestCase):
    """ARIA-LOW-858 — the panel is chosen only from a routing table the PR head did not change.

    ``request_implementation_expert_reviews`` reads the routing table from the
    PR-head workspace. A head that edits the table (a routing input, a member
    of the derived authority set, ADR-049) fails
    ``readonly_paths_untouched_at_merge``, and the gate refuses before it
    reads the table, so the edited table never picks the reviewers of the
    change that edited it. The report comes from the registry's one producer
    over the real read-only check; only the four implementation checks are
    held passing, as the native claim-time capture has them.
    """

    def setUp(self) -> None:
        directory = tempfile.TemporaryDirectory(prefix="aria-review-panel-table-")
        self.addCleanup(directory.cleanup)
        self.workspace = Path(directory.name)
        table = self.workspace / ROUTING_TABLE_REL
        table.parent.mkdir(parents=True)
        live = (_REPO_ROOT / ROUTING_TABLE_REL).read_text(encoding="utf-8")
        self.assertIn("| `apps/farm-service/**` | farm-expert | |", live)
        # The PR head's edit: its own farm change is reviewed by an agent it chose.
        table.write_text(live.replace("| `apps/farm-service/**` | farm-expert | |",
                                      "| `apps/farm-service/**` | planted-reviewer | |"), encoding="utf-8")

    def _request(self, affected_paths: tuple[str, ...]):  # noqa: ANN202 — (requested ids, table loads, minted targets)
        fields = ("repo_identity", "snapshot_hash", "pr_row_hash", "planned_row_hash", "committed_row_hash",
                  "request_id", "claim_id", "request_row_hash", "claim_row_hash", "result_row_hash",
                  "implementation_event_hash", "change_id", "plan_id")
        evidence = fixture_pre_merge_evidence(
            (), head_sha="a" * 40, base_sha="b" * 40, **{field: f"{field}-x" for field in fields})
        context = safety.HardFailContext(
            workspace_root=self.workspace, affected_paths=affected_paths,
            diff_text="diff --git a/x b/x\n", pre_merge_evidence=evidence,
        )
        registry = tuple(
            dataclasses.replace(entry, check=lambda _context, name=entry.name: safety._passed(name))
            if entry.name in _IMPLEMENTATION_CHECKS else entry
            for entry in safety.HARD_FAIL_CHECKS
            if entry.name in _IMPLEMENTATION_CHECKS | {"readonly_paths_untouched_at_merge"}
        )
        with patch.object(safety, "HARD_FAIL_CHECKS", registry):
            report = safety.run_hard_fail_checks(context, gate=safety.GATE_PRE_MERGE)
        minted: list[str] = []

        def mint(*, target_agent: str, **_request: object) -> dict[str, str]:
            minted.append(target_agent)
            return {"request_id": f"AIR-{target_agent}"}

        with patch("aria_kernel.expert_review_gate.load_routing_table", wraps=load_routing_table) as loads, \
                patch("aria_kernel.agent_invocations.create_agent_invocation_request", side_effect=mint), \
                patch("aria_kernel.request_admission.admit_request", return_value=None):
            requested = request_implementation_expert_reviews(context, report, base_dir=None, cycle_id=None)
        return requested, loads, minted, {result.name: result for result in report.results}

    def test_a_head_that_edits_the_routing_table_is_refused_before_the_table_is_read(self) -> None:
        requested, loads, minted, results = self._request((ROUTING_TABLE_REL, _FARM_SOURCE))
        self.assertFalse(results["readonly_paths_untouched_at_merge"].passed)
        self.assertTrue(all(results[name].passed for name in _IMPLEMENTATION_CHECKS))
        self.assertEqual(requested, ())
        loads.assert_not_called()
        self.assertNotIn("planted-reviewer", minted)

    def test_a_head_that_changes_no_read_only_path_is_reviewed_from_its_table(self) -> None:
        # The control: the same gate reads the table and mints the panel once
        # the read-only check holds, so the refusal above is that check's.
        requested, loads, minted, results = self._request((_FARM_SOURCE,))
        self.assertTrue(results["readonly_paths_untouched_at_merge"].passed)
        loads.assert_called_once_with(self.workspace)
        self.assertEqual(requested, tuple(f"AIR-{agent}" for agent in minted))
        self.assertIn("planted-reviewer", minted)


    def test_every_required_check_is_one_the_claim_time_report_carries(self) -> None:
        # The report is the GATE_PRE_MERGE perimeter's; a name from another
        # gate (forbidden_scope_normalized is pre-PR-open) never passes in it
        # and would silence every panel (ARIA-HIGH-217).
        pre_merge = {entry.name for entry in safety.HARD_FAIL_CHECKS if entry.gate == safety.GATE_PRE_MERGE}
        self.assertLessEqual(REVIEW_PANEL_REQUIRED_CHECKS, pre_merge)
        self.assertIn("readonly_paths_untouched_at_merge", REVIEW_PANEL_REQUIRED_CHECKS)


if __name__ == "__main__":
    unittest.main()
