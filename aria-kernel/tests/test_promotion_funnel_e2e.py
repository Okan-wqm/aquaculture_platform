"""ARIA-HIGH-004 — the learning funnel, joined end to end.

One production-shaped fixture flows through all eight stages
(``funnel_health.LEARNING_FUNNEL_STAGES``) by calling the producers the cycle
calls, in the cycle's order, and nothing else:

    run_tool (an adapter in its room, five SHADOW runs)       -> raw
    generate_judgment_sample + dispatch_judges_for_sample      -> judge_request
    judgment_bridge.record_judge_verdict_from_response,
    generate_ai_consensus, dispatch_arbiter_for_anchor_groups,
    the arbiter's verdict, generate_ai_consensus again         -> consensus (ANCHOR)
    finding_promotion.promote_consensus_findings               -> promoted
    fixture_runner.refresh_fixture_suite                       -> fixture_pass
    judge_calibration.compute_judge_calibration                -> judge_calibrated
    adapter_calibration.generate_adapter_calibration_report    -> adapter_calibrated
    promotion.promote_tool (readiness.adapter_active_readiness,
    tool_registry.transition_tool)                             -> adapter_active

``funnel_health.derive_learning_funnel_health`` must then join every stage by
the identities the producers stamped (request ids, run ids, fingerprint, tool
version, fixture run, calibration report ids, target commit) and name a stall
where work stops. The negative cases are the four the closure plan names:
a consensus without a fingerprint, a two-judge (non-anchor) consensus, a
stale fixture corpus, and an upstream stage of ten with nothing downstream.

Only the judges' answers and the operator's GitHub act are stand-ins (no
model, no network): the answers enter through the production bridge, the act
through the production approval seam (``tests._helpers.operator_acts``).
Fixture git repositories run under the hermetic git environment this test
package installs at import (``tests/__init__.py``: every GIT_* location
variable dropped).
"""
from __future__ import annotations

import json
import os
import shutil
import tempfile
import unittest
from pathlib import Path
from typing import Any

from aria_kernel.adapter_calibration import (
    active_transition_evidence,
    generate_adapter_calibration_report,
)
from aria_kernel.agent_invocations import list_agent_invocation_requests
from aria_kernel.feedback_store import (
    generate_ai_consensus,
    generate_judgment_sample,
    load_feedback,
    load_jsonl,
    promotions_path,
    record_operator_feedback,
)
from aria_kernel.finding_promotion import promote_consensus_findings
from aria_kernel.fixture_runner import refresh_fixture_suite
from aria_kernel.funnel_health import (
    LEARNING_FUNNEL_STAGES,
    derive_learning_funnel_health,
    learning_funnel_stalls,
)
from aria_kernel.judge_calibration import compute_judge_calibration
from aria_kernel.judge_fanout import dispatch_arbiter_for_anchor_groups, dispatch_judges_for_sample
from aria_kernel.judgment_bridge import record_judge_verdict_from_response
from aria_kernel.promotion import promote_tool
from aria_kernel.tool_registry import (
    GovernanceError,
    ensure_tools_dir,
    get_tool,
    register_tool,
    transition_tool,
)
from aria_kernel.tool_runner import run_tool

from tests._helpers.git_fixtures import commit_files, make_local_git_repo
from tests._helpers.operator_acts import github_operator_acts
from tests._helpers.rule_contracts import DEFAULT_RULE_CONTRACT

FAKE_RUNNER = Path(__file__).resolve().parent / "_helpers" / "fake_tool_runner.py"
TOOL_ID = "funnel-adapter"
FINDINGS_FILE = "rules/findings.json"
FIXTURE_DIR = f"tools/aria-adapters/fixtures/{TOOL_ID}"
SUBJECT = "apps/target.ts"
# The models the live fleet runs the three judges on (two distinct): the
# anchor rule asks how many distinct models agreed.
JUDGE_MODELS = {
    "aria-evidence-judge": "claude-opus-5",
    "aria-adversarial-judge": "claude-opus-5",
    "aria-consensus-arbiter": "fable",
}


def _findings(count: int) -> list[dict[str, Any]]:
    return [
        {
            "id": f"F-{index}", "rule": "rule-a", "severity": "high", "path": SUBJECT, "line": index,
            "message": f"finding {index}", "evidence": [{"path": SUBJECT, "line": index}],
        }
        for index in range(1, count + 1)
    ]


def _tool() -> dict[str, Any]:
    scope = ["apps/**", "rules/**"]
    return {
        "tool_id": TOOL_ID,
        "kind": "adapter",
        "version": "1.0.0",
        "status": "SHADOW",
        "declared_scope": scope,
        "output_schema": {
            "type": "object",
            "required": ["observations", "findings", "read_paths", "evidence_sources"],
        },
        "fixture_set": FIXTURE_DIR,
        "health_thresholds": {"precision_min": 0.85},
        "allowed_read_globs": scope,
        "forbidden_read_globs": [],
        "claim_types": ["wrong_code"],
        "owner": "platform",
        "rules": {"rule-a": dict(DEFAULT_RULE_CONTRACT)},
        "runner": {
            "type": "subprocess",
            "argv": ["python3", FAKE_RUNNER.as_posix(), "--findings-file", FINDINGS_FILE],
            "cwd": ".",
            "timeout_ms": 60_000,
            "stdin_json": True,
        },
        "schema_version": 1,
    }


def _without_fingerprint(request: dict[str, Any]) -> dict[str, Any]:
    return {key: value for key, value in request.items() if key != "finding_fingerprint"}


class _Funnel:
    """One workspace, one store, one adapter: the funnel driven by its producers."""

    def __init__(self, parent: Path, *, findings: int = 5) -> None:
        self.workspace = make_local_git_repo(parent, name="workspace", initial_commit=False)
        self.tools = self.workspace / ".aria-state-store" / "tools"
        ensure_tools_dir(self.tools)
        self.head = commit_files(self.workspace, {
            SUBJECT: "".join(f"export const x{index} = {index};\n" for index in range(1, findings + 3)),
            FINDINGS_FILE: json.dumps(_findings(findings)),
            f"{FIXTURE_DIR}/cases/baseline.json": json.dumps(
                {"input": {}, "expected": {"status": "ok", "max_findings": findings}},
            ),
        })
        register_tool(_tool(), base_dir=self.tools)

    # -- raw -----------------------------------------------------------------
    def run_adapter(self, runs: int) -> None:
        for index in range(runs):
            envelope = run_tool(
                TOOL_ID, {}, f"cycle-{index}", workspace_root=self.workspace, base_dir=self.tools,
            )["envelope"]
            if envelope["status"] != "ok":
                raise AssertionError(f"adapter run {index} did not complete: {envelope.get('runner')}")

    # -- judge_request -------------------------------------------------------
    def mint_judges(self) -> list[dict[str, Any]]:
        sample = generate_judgment_sample(tool_id=TOOL_ID, sample_size=100, base_dir=self.tools)
        dispatch_judges_for_sample(
            sample=sample, base_dir=self.tools, target_sha=self.head, repo_root=self.workspace,
        )
        return self.requests()

    def requests(self, role: str | None = None) -> list[dict[str, Any]]:
        return list_agent_invocation_requests(base_dir=self.tools, role=role)

    # -- consensus -----------------------------------------------------------
    def answer(self, request: dict[str, Any], *, verdict: str = "true_positive") -> None:
        """A judge's accepted answer, folded by the production bridge."""
        matrix = [
            {"id": item["id"], "verdict": "satisfied", "evidence_refs": [f"{SUBJECT}:1"]}
            for item in request.get("must_satisfy") or [] if isinstance(item, dict)
        ]
        # WP-J fix round — independent seats write independent prose (the
        # settle path's diversity leg refuses a panel that echoes), so each
        # seat answers in its own words about the same cited line.
        _rationales = {
            "aria-evidence-judge": "the cited line performs the operation on the tenant context",
            "aria-adversarial-judge": "reading the same line from the guard's side confirms the claim",
            "aria-consensus-arbiter": "an independent pass over the call site agrees with the pair",
        }
        record_judge_verdict_from_response(
            request=request,
            response={
                "role": request["role"],
                "request_id": request["request_id"],
                "satisfaction_matrix": matrix,
                "details": {
                    "agent_subagent_type": request["target_agent"],
                    "agent_dispatch_model": JUDGE_MODELS[request["target_agent"]],
                    "verdict": {
                        "verdict": verdict, "confidence": 0.95, "severity": "high",
                        "rationale": _rationales.get(
                            request["target_agent"],
                            "the cited line performs the operation",
                        ),
                        "evidence_refs": [f"{SUBJECT}:1"],
                    },
                },
            },
            base_dir=self.tools,
        )

    def judge_pair(self, *, strip_fingerprint: bool = False) -> None:
        """The two fan-out judges answer and their consensus settles (2 judges).

        ``strip_fingerprint`` answers through a pre-ORPHAN-HIGH-765 envelope:
        a mint that carried no fingerprint."""
        for request in self.mint_judges():
            self.answer(_without_fingerprint(request) if strip_fingerprint else request)
        generate_ai_consensus(tool_id=TOOL_ID, base_dir=self.tools)

    def judge_anchor(self, *, strip_fingerprint: bool = False) -> None:
        """The arbiter the anchor arm mints answers; the consensus re-settles at 3."""
        dispatch_arbiter_for_anchor_groups(tool_id=TOOL_ID, base_dir=self.tools, target_sha=self.head)
        for request in self.requests(role="consensus_arbitration"):
            self.answer(_without_fingerprint(request) if strip_fingerprint else request)
        generate_ai_consensus(tool_id=TOOL_ID, base_dir=self.tools)

    # -- promoted ------------------------------------------------------------
    def promote_findings(self) -> dict[str, Any]:
        return promote_consensus_findings(repo_root=self.workspace, base_dir=self.tools)

    # -- fixture_pass ----------------------------------------------------------
    def refresh_fixtures(self) -> dict[str, Any]:
        return refresh_fixture_suite(
            TOOL_ID, workspace_root=self.workspace, cycle_id="cycle-fixtures", base_dir=self.tools,
        )

    # -- judge_calibrated -------------------------------------------------------
    def label_and_calibrate(self) -> dict[str, Any]:
        """The operator's labels (the `feedback record` verb's producer) are the
        truth the anchor judges did not form; the calibration scores them."""
        for request in self.requests(role="evidence_judgment"):
            record_operator_feedback(
                tool_id=TOOL_ID, run_id=request["run_id"], finding_id=request["finding_id"],
                verdict="true_positive", severity="high", note="operator label", source_type="human",
                judgment_group_id=request["judgment_group_id"],
                finding_fingerprint=request["finding_fingerprint"], base_dir=self.tools,
            )
        return compute_judge_calibration(base_dir=self.tools, target_sha=self.head)

    # -- adapter_calibrated -------------------------------------------------------
    def calibrate_adapter(self) -> dict[str, Any]:
        return generate_adapter_calibration_report(
            tool_ids=[TOOL_ID], base_dir=self.tools, cycle_id="cycle-calibration", target_sha=self.head,
        )

    # -- adapter_active -----------------------------------------------------------
    def promote_active(self) -> dict[str, Any]:
        with github_operator_acts() as github:
            approval = github.approve("tool_promote", {"tool": TOOL_ID, "target": "ACTIVE"})
            return promote_tool(
                TOOL_ID, "ACTIVE", reason="learning funnel e2e", operator_approval_ref=approval,
                base_dir=self.tools,
            )

    def health(self, target_sha: str | None = None):
        return derive_learning_funnel_health(base_dir=self.tools, target_sha=target_sha or self.head)


class _FunnelCase(unittest.TestCase):
    def setUp(self) -> None:
        self._saved_env = {
            key: os.environ.get(key)
            for key in ("ARIA_TOOLS_DIR", "ARIA_REPO_ROOT", "ARIA_CONSENSUS_PROMOTION_ACK")
        }
        os.environ.pop("ARIA_TOOLS_DIR", None)
        os.environ.pop("ARIA_REPO_ROOT", None)
        # ARIA-AUDIT-015 — consensus promotion is operator-gated; the recorded
        # acknowledgment the gate resolves (as test_finding_promotion does).
        os.environ["ARIA_CONSENSUS_PROMOTION_ACK"] = "operator-approved-tests"
        self.parent = Path(tempfile.mkdtemp(prefix="aria-h004-"))

    def tearDown(self) -> None:
        for key, value in self._saved_env.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value
        shutil.rmtree(self.parent, ignore_errors=True)


class LearningFunnelEndToEndTests(_FunnelCase):
    def test_one_fixture_flows_through_all_eight_stages(self) -> None:
        """One flow, in the cycle's order; the ACTIVE gate's refusals are
        exercised on the way, while the tool is still SHADOW."""
        funnel = _Funnel(self.parent)
        funnel.run_adapter(5)
        # The cycle's order: the pair's consensus is promoted in the tick it
        # settles; the arbiter that makes it an ANCHOR answers on a later one.
        funnel.judge_pair()
        first = funnel.promote_findings()
        self.assertEqual(first["promoted_count"], 5, first["skipped"])
        # Negative: a two-judge agreement is not ground truth. Promotion is
        # deliberately not anchor-gated (a promoted finding is a work item);
        # the LEARNING funnel is, so nothing advances past the requests yet.
        pair = funnel.health().counts
        self.assertEqual((pair["judge_request"], pair["consensus"], pair["promoted"]), (5, 0, 0))
        funnel.judge_anchor()
        funnel.refresh_fixtures()
        calibration = funnel.label_and_calibrate()
        self._active_refuses_missing_stale_and_mismatched_evidence(funnel)

        report = funnel.calibrate_adapter()
        self.assertEqual(report["status"], "active_ready", report["reports"][0]["blocked_by"])
        promoted_tool = funnel.promote_active()
        self.assertEqual(promoted_tool["status"], "ACTIVE")

        health = funnel.health()
        self.assertEqual(dict(health.counts), {
            "raw": 5, "judge_request": 5, "consensus": 5, "promoted": 5,
            "fixture_pass": 1, "judge_calibrated": 1, "adapter_calibrated": 1, "adapter_active": 1,
        })
        self.assertEqual(tuple(health.counts), LEARNING_FUNNEL_STAGES)
        self.assertEqual(dict(health.historical_counts), dict(health.counts))
        self.assertIsNone(health.stalled_at)
        self.assertEqual(health.blockers, ())
        fixture_ref = report["reports"][0]["fixture_status"]["latest"]["execution_run_id"]
        for ref in (
            f"adapter-calibration:{report['report_id']}",
            f"judge-calibration:{calibration['calibration_report_id']}",
            f"fixture-runs:{fixture_ref}",
            f"registry:{TOOL_ID}@1.0.0",
        ):
            self.assertIn(ref, health.evidence_refs)

        # The identities the join stood on are stamped by the producers.
        anchors = [
            row for row in load_feedback(base_dir=funnel.tools)
            if row.get("source_type") == "ai_consensus" and row.get("judge_count") == 3
        ]
        self.assertEqual(len(anchors), 5)
        requests = {row["request_id"]: row for row in funnel.requests()}
        for anchor in anchors:
            self.assertEqual(anchor["target_sha"], funnel.head)
            self.assertEqual(len(anchor["request_ids"]), 3)
            self.assertEqual(
                {requests[request_id]["finding_fingerprint"] for request_id in anchor["request_ids"]},
                {anchor["finding_fingerprint"]},
            )
        promotions = load_jsonl(promotions_path(funnel.tools))
        self.assertEqual({row["target_sha"] for row in promotions}, {funnel.head})
        self.assertTrue(all(row["request_ids"] for row in promotions))
        self.assertEqual(calibration["target_sha"], funnel.head)
        self.assertIsNone(calibration["judgment_group_prefix"])
        transition = get_tool(TOOL_ID, funnel.tools)["last_transition"]
        self.assertEqual(transition["active_evidence"], {
            "calibration_report_ref": report["report_id"],
            "calibration_report_hash": report["ledger_hash"],
            "readiness_verdict_hash": report["reports"][0]["verdict_hash"],
            "fixture_run_refs": [fixture_ref],
            "tool_version": "1.0.0",
            "target_sha": funnel.head,
        })

        # Idempotent promotion replay: nothing re-promotes, nothing moves.
        replay = funnel.promote_findings()
        self.assertEqual(replay["promoted_count"], 0)
        self.assertEqual(dict(funnel.health().counts), dict(health.counts))

        # Bound to the target: at another commit nothing past the raw pool
        # was judged, while the history still holds every stage.
        other = commit_files(funnel.workspace, {"apps/other.ts": "export const y = 1;\n"})
        elsewhere = funnel.health(other)
        self.assertEqual(elsewhere.counts["raw"], 5)
        self.assertEqual(
            {stage: elsewhere.counts[stage] for stage in LEARNING_FUNNEL_STAGES[1:]},
            dict.fromkeys(LEARNING_FUNNEL_STAGES[1:], 0),
        )
        self.assertEqual(dict(elsewhere.historical_counts), dict(health.counts))

    def _active_refuses_missing_stale_and_mismatched_evidence(self, funnel: _Funnel) -> None:
        def transition(evidence: Any) -> None:
            transition_tool(
                TOOL_ID, "ACTIVE", reason="evidence gate", base_dir=funnel.tools,
                precision=1.0, evidence_chains_valid=True, active_evidence=evidence,
            )

        # No calibration report measured the tool yet.
        with self.assertRaisesRegex(GovernanceError, "active_evidence_calibration_report_missing"):
            active_transition_evidence(TOOL_ID, base_dir=funnel.tools)
        with self.assertRaisesRegex(GovernanceError, "active_evidence_missing"):
            transition(None)

        # A report with no commit binds nothing.
        generate_adapter_calibration_report(tool_ids=[TOOL_ID], base_dir=funnel.tools, cycle_id="cycle-unbound")
        with self.assertRaisesRegex(GovernanceError, "active_evidence_calibration_report_target_unbound"):
            transition(active_transition_evidence(TOOL_ID, base_dir=funnel.tools))

        funnel.calibrate_adapter()
        evidence = active_transition_evidence(TOOL_ID, base_dir=funnel.tools)
        for field, forged, reason in (
            ("readiness_verdict_hash", "sha256:" + "0" * 64, "readiness_verdict_hash_mismatch"),
            ("calibration_report_hash", "sha256:" + "1" * 64, "calibration_report_hash_mismatch"),
            ("calibration_report_ref", "acal-forged", "calibration_report_not_newest"),
            ("target_sha", "f" * 40, "target_sha_mismatch"),
            ("tool_version", "9.9.9", "tool_changed_since_calibration"),
            ("fixture_run_refs", ["exec-forged"], "fixture_run_mismatch"),
        ):
            with self.subTest(field=field):
                with self.assertRaisesRegex(GovernanceError, f"active_evidence_{reason}"):
                    transition({**evidence, field: forged})

        # Stale: the corpus the verdict's fixture run measured changed under
        # it. The suite no longer counts as a fixture pass, and the gate
        # refuses the evidence that stood on it.
        extra_case = funnel.workspace / FIXTURE_DIR / "cases" / "second.json"
        extra_case.write_text(json.dumps({"input": {}, "expected": {"status": "ok"}}), encoding="utf-8")
        with self.assertRaisesRegex(GovernanceError, "active_evidence_fixture_run_stale"):
            transition(evidence)
        stale = funnel.health()
        self.assertEqual((stale.counts["promoted"], stale.counts["fixture_pass"]), (5, 0))
        extra_case.unlink()
        self.assertEqual(funnel.health().counts["fixture_pass"], 1)
        self.assertEqual(get_tool(TOOL_ID, funnel.tools)["status"], "SHADOW")


class LearningFunnelNegativeTests(_FunnelCase):
    def test_a_stall_is_named_where_work_stops_and_no_fingerprint_advances_nothing(self) -> None:
        funnel = _Funnel(self.parent, findings=10)
        funnel.run_adapter(1)
        idle = funnel.health()
        self.assertEqual((idle.counts["raw"], idle.counts["judge_request"]), (10, 0))
        self.assertEqual(idle.blockers, ("learning_funnel_stalled:raw->judge_request",))
        self.assertEqual(idle.stalled_at, "judge_request")

        # Every judge answers through an envelope that carried no fingerprint:
        # the consensus rows cannot name the finding they settle.
        funnel.judge_pair(strip_fingerprint=True)
        funnel.judge_anchor(strip_fingerprint=True)
        result = funnel.promote_findings()
        self.assertEqual(result["promoted_count"], 0)
        self.assertEqual({skip["reason"] for skip in result["skipped"]}, {"missing_finding_fingerprint"})
        stuck = funnel.health()
        self.assertEqual(
            (stuck.counts["judge_request"], stuck.counts["consensus"], stuck.counts["promoted"]), (10, 0, 0),
        )
        self.assertEqual(stuck.blockers, ("learning_funnel_stalled:judge_request->consensus",))
        self.assertEqual(stuck.stalled_at, "consensus")

    def test_the_stall_rule_names_every_dry_successor_of_a_fed_stage(self) -> None:
        counts = dict.fromkeys(LEARNING_FUNNEL_STAGES, 0)
        # Nine promoted with no fixture pass is a small night, not a stall.
        counts.update({"raw": 40, "judge_request": 12, "consensus": 9, "promoted": 9})
        self.assertEqual(learning_funnel_stalls(counts), ())
        counts.update({"consensus": 0})
        self.assertEqual(learning_funnel_stalls(counts), ("learning_funnel_stalled:judge_request->consensus",))
        counts.update({"promoted": 10})
        self.assertEqual(learning_funnel_stalls(counts), (
            "learning_funnel_stalled:judge_request->consensus",
            "learning_funnel_stalled:promoted->fixture_pass",
        ))

    def test_the_target_must_be_a_commit(self) -> None:
        with self.assertRaisesRegex(ValueError, "full git object id"):
            derive_learning_funnel_health(base_dir=self.parent / "tools", target_sha="HEAD")


if __name__ == "__main__":
    unittest.main()
