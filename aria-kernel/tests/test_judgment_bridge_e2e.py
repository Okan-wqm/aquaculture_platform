"""End-to-end test for Plan 016 Faz C5/C6 — multi-judge consensus + Goldset/CI bridge."""
from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from aria_kernel.agent_invocations import claim_request, create_agent_invocation_request, submit_claim_result
from aria_kernel.feedback_store import load_feedback
from aria_kernel.judgment_bridge import (
    persist_supporting_payload,
    record_judge_verdict_from_response,
    run_consensus,
)
from aria_kernel.tool_registry import GovernanceError, ensure_tools_dir


def _seed_repo() -> Path:
    repo = Path(tempfile.mkdtemp(prefix="aria-c5c6-"))
    (repo / "src.txt").write_text("alpha\nbeta\ngamma\n", encoding="utf-8")
    return repo


def _judge_envelope_at(
    *,
    out_path: Path,
    request_id: str,
    claim_id: str,
    judge_agent: str,
    role: str,
    verdict: str,
    confidence: float = 0.9,
) -> Path:
    envelope = {
        "$schema": "aria/agent-response/v1",
        "request_id": request_id,
        "claim_id": claim_id,
        "agent_id": judge_agent,
        "role": role,
        "status": "submitted",
        "satisfaction_matrix": [],
        "evidence_refs": ["src.txt:1"],
        "details": {
            "verdict": {
                "verdict": verdict,
                "confidence": confidence,
                "judge_id": judge_agent,
                "rationale": f"{judge_agent} verdict for fixture finding",
                "evidence_refs": ["src.txt:1"],
                "judgment_group_id": "group-001",
                "severity": "medium",
            }
        },
    }
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(envelope), encoding="utf-8")
    return out_path


class JudgmentBridgeE2ETests(unittest.TestCase):
    def setUp(self) -> None:
        self.repo = _seed_repo()
        self.tools = self.repo / "aria-tools"
        ensure_tools_dir(self.tools)

    def tearDown(self) -> None:
        import shutil

        shutil.rmtree(self.repo, ignore_errors=True)

    def _claim_judge(self, *, target_agent: str, role: str) -> tuple[dict, dict]:
        request = create_agent_invocation_request(
            target_agent=target_agent,
            role=role,
            suggested_prompt=f"validate F-001 for {target_agent}",
            convergence_id="conv-c5c6-001",
            base_dir=self.tools,
        )
        # Inject the legacy request fields the bridge needs.
        from aria_kernel.ledger import load_jsonl, rewrite_jsonl
        path = self.tools / "agent-invocations" / "requests.jsonl"
        rows = load_jsonl(path)
        rows[-1]["tool_id"] = "demo-adapter"
        rows[-1]["run_id"] = "run-001"
        rows[-1]["finding_id"] = "F-001"
        rewrite_jsonl(path, rows)
        request = rows[-1]

        claim = claim_request(
            request_id=request["request_id"],
            agent_id=f"{target_agent}-worker",
            base_dir=self.tools,
        )
        return request, claim

    def test_two_judges_then_consensus_passes(self) -> None:
        # Judge 1: evidence -> true_positive
        ev_request, ev_claim = self._claim_judge(
            target_agent="aria-evidence-judge", role="evidence_judgment"
        )
        ev_out = self.tools / "agent-invocations" / "outputs" / "evidence.json"
        _judge_envelope_at(
            out_path=ev_out,
            request_id=ev_request["request_id"],
            claim_id=ev_claim["claim_id"],
            judge_agent="aria-evidence-judge",
            role="evidence_judgment",
            verdict="true_positive",
            confidence=0.92,
        )
        ev_result = submit_claim_result(
            claim_id=ev_claim["claim_id"],
            agent_id=ev_claim["agent_id"],
            lease_token=ev_claim["lease_token"],
            output_path=ev_out,
            workspace_root=self.repo,
            base_dir=self.tools,
        )
        self.assertEqual(ev_result["status"], "accepted", ev_result)
        self.assertIsNotNone(ev_result["bridged"]["judge_feedback"])

        # Judge 2: adversarial -> true_positive (agreement)
        ad_request, ad_claim = self._claim_judge(
            target_agent="aria-adversarial-judge", role="adversarial_judgment"
        )
        ad_out = self.tools / "agent-invocations" / "outputs" / "adversarial.json"
        _judge_envelope_at(
            out_path=ad_out,
            request_id=ad_request["request_id"],
            claim_id=ad_claim["claim_id"],
            judge_agent="aria-adversarial-judge",
            role="adversarial_judgment",
            verdict="true_positive",
            confidence=0.88,
        )
        ad_result = submit_claim_result(
            claim_id=ad_claim["claim_id"],
            agent_id=ad_claim["agent_id"],
            lease_token=ad_claim["lease_token"],
            output_path=ad_out,
            workspace_root=self.repo,
            base_dir=self.tools,
        )
        self.assertEqual(ad_result["status"], "accepted", ad_result)
        self.assertIsNotNone(ad_result["bridged"]["judge_feedback"])

        # Now there should be two ai_judge feedback rows for the same finding.
        ai_rows = [
            r for r in load_feedback(tool_id="demo-adapter", base_dir=self.tools)
            if r.get("source_type") == "ai_judge"
        ]
        self.assertEqual(len(ai_rows), 2)

        # Run consensus — both judges agree at high confidence -> pass.
        result = run_consensus(
            tool_id="demo-adapter",
            cycle_id=None,
            min_confidence=0.80,
            base_dir=self.tools,
        )
        consensus_rows = result.get("consensus") or []
        self.assertGreaterEqual(len(consensus_rows), 1, result)
        # Verify a governance event was recorded for the consensus run.
        gov = (self.tools / "governance.jsonl").read_text(encoding="utf-8").splitlines()
        kinds = {json.loads(line).get("kind") for line in gov if line.strip()}
        self.assertIn("agent_consensus_computed", kinds)

    def test_judges_disagree_yields_uncertainty(self) -> None:
        ev_req, ev_claim = self._claim_judge(
            target_agent="aria-evidence-judge", role="evidence_judgment"
        )
        ev_out = self.tools / "agent-invocations" / "outputs" / "ev.json"
        _judge_envelope_at(
            out_path=ev_out,
            request_id=ev_req["request_id"],
            claim_id=ev_claim["claim_id"],
            judge_agent="aria-evidence-judge",
            role="evidence_judgment",
            verdict="true_positive",
            confidence=0.92,
        )
        submit_claim_result(
            claim_id=ev_claim["claim_id"], agent_id=ev_claim["agent_id"],
            lease_token=ev_claim["lease_token"], output_path=ev_out,
            workspace_root=self.repo, base_dir=self.tools,
        )

        ad_req, ad_claim = self._claim_judge(
            target_agent="aria-adversarial-judge", role="adversarial_judgment"
        )
        ad_out = self.tools / "agent-invocations" / "outputs" / "ad.json"
        _judge_envelope_at(
            out_path=ad_out,
            request_id=ad_req["request_id"],
            claim_id=ad_claim["claim_id"],
            judge_agent="aria-adversarial-judge",
            role="adversarial_judgment",
            verdict="false_positive",  # disagreement
            confidence=0.85,
        )
        submit_claim_result(
            claim_id=ad_claim["claim_id"], agent_id=ad_claim["agent_id"],
            lease_token=ad_claim["lease_token"], output_path=ad_out,
            workspace_root=self.repo, base_dir=self.tools,
        )
        result = run_consensus(
            tool_id="demo-adapter", cycle_id=None, min_confidence=0.80, base_dir=self.tools
        )
        # Uncertainties must surface the disagreement.
        uncertainties = result.get("uncertainties") or []
        reasons = {u.get("reason") for u in uncertainties}
        self.assertIn("judge_disagreement", reasons)


class JudgeBridgeUnitTests(unittest.TestCase):
    def setUp(self) -> None:
        self.repo = _seed_repo()
        self.tools = self.repo / "aria-tools"
        ensure_tools_dir(self.tools)

    def tearDown(self) -> None:
        import shutil

        shutil.rmtree(self.repo, ignore_errors=True)

    def test_non_judge_role_is_noop(self) -> None:
        request = {"request_id": "req-x", "tool_id": "T", "run_id": "R", "finding_id": "F-001"}
        response = {"role": "primary_plan", "agent_id": "x", "details": {}}
        result = record_judge_verdict_from_response(
            request=request, response=response, base_dir=self.tools
        )
        self.assertIsNone(result)

    def test_missing_tool_context_raises(self) -> None:
        request = {"request_id": "req-x"}
        response = {
            "role": "evidence_judgment",
            "agent_id": "aria-evidence-judge",
            "details": {"verdict": {"verdict": "true_positive", "confidence": 0.9}},
        }
        with self.assertRaisesRegex(GovernanceError, "tool_id"):
            record_judge_verdict_from_response(
                request=request, response=response, base_dir=self.tools
            )

    def test_unknown_verdict_value_raises(self) -> None:
        request = {"request_id": "req-x", "tool_id": "T", "run_id": "R", "finding_id": "F-001"}
        response = {
            "role": "evidence_judgment",
            "agent_id": "aria-evidence-judge",
            "details": {"verdict": {"verdict": "maybe", "confidence": 0.9}},
        }
        with self.assertRaisesRegex(GovernanceError, "verdict"):
            record_judge_verdict_from_response(
                request=request, response=response, base_dir=self.tools
            )


class GoldsetSupportingPayloadTests(unittest.TestCase):
    def setUp(self) -> None:
        self.repo = _seed_repo()
        self.tools = self.repo / "aria-tools"
        ensure_tools_dir(self.tools)

    def tearDown(self) -> None:
        import shutil

        shutil.rmtree(self.repo, ignore_errors=True)

    def test_goldset_proposal_persisted_to_pipeline_dir(self) -> None:
        request = {"request_id": "req-goldset-001"}
        response = {
            "request_id": "req-goldset-001",
            "role": "goldset_curation",
            "details": {
                "proposal": {"tool_id": "T", "fixtures": [{"evidence_refs": ["src.txt:1"]}]},
            },
        }
        persisted = persist_supporting_payload(
            request=request, response=response, base_dir=self.tools
        )
        self.assertIsNotNone(persisted)
        path = self.tools / "judgment-pipeline" / "goldset_curation" / "req-goldset-001.json"
        self.assertTrue(path.exists())
        self.assertEqual(
            json.loads(path.read_text())["fixtures"][0]["evidence_refs"], ["src.txt:1"]
        )

    def test_change_intelligence_impact_map_persisted(self) -> None:
        request = {"request_id": "req-ci-001"}
        response = {
            "request_id": "req-ci-001",
            "role": "change_intelligence",
            "details": {
                "impact_map": {
                    "beliefs_needs_revalidation": ["belief-a"],
                    "findings_needs_revalidation": [],
                    "fixtures_requires_rerun": [],
                    "confirmed_unchanged": ["F-001"],
                }
            },
        }
        persisted = persist_supporting_payload(
            request=request, response=response, base_dir=self.tools
        )
        self.assertIsNotNone(persisted)
        path = self.tools / "judgment-pipeline" / "change_intelligence" / "req-ci-001.json"
        self.assertTrue(path.exists())

    def test_supporting_role_missing_payload_raises(self) -> None:
        request = {"request_id": "req-x"}
        response = {"request_id": "req-x", "role": "goldset_curation", "details": {}}
        with self.assertRaisesRegex(GovernanceError, "details.proposal"):
            persist_supporting_payload(request=request, response=response, base_dir=self.tools)


if __name__ == "__main__":
    unittest.main()
