from __future__ import annotations

import base64
import json
import tempfile
import unittest
from pathlib import Path

from aria_kernel import promote_tool, record_run, register_tool, run_discovery, run_cycle_diff, update_memory
from aria_kernel.adapter_calibration import generate_adapter_calibration_report
from aria_kernel.feedback_store import (
    finding_fingerprint,
    generate_ai_consensus,
    generate_judgment_sample,
    record_operator_feedback_batch,
    record_ai_feedback_file,
    record_operator_feedback,
)
from aria_kernel.fixture_runner import fixture_status_report, latest_fixture_status, refresh_fixture_suite, run_fixture_suite
from aria_kernel.goldset import propose_goldset
from aria_kernel.memory import list_memory
from aria_kernel.pr_tracking import observe_pr_event, plan_pr_impact
from aria_kernel.tool_health import evaluate_health

FAKE_RUNNER = Path(__file__).resolve().parent / "_helpers" / "fake_tool_runner.py"


def fake_tool_argv(output):
    encoded = base64.b64encode(json.dumps(output, separators=(",", ":")).encode("utf-8")).decode("ascii")
    return ["python3", FAKE_RUNNER.as_posix(), "--output-b64", encoded]


def tool_definition(**overrides):
    payload = {
        "tool_id": "learning-adapter",
        "kind": "adapter",
        "version": "1.0.0",
        "status": "SHADOW",
        "declared_scope": ["src/**/*.ts"],
        "output_schema": {"type": "object", "required": ["observations", "findings", "read_paths", "evidence_sources"]},
        "fixture_set": "fixtures/learning-adapter",
        "health_thresholds": {"max_cost_units": 10},
        "allowed_read_globs": ["src/**/*.ts"],
        "forbidden_read_globs": [],
        "claim_types": ["learning"],
        "owner": "platform",
        "runner": {
            "type": "subprocess",
            "argv": fake_tool_argv(
                {
                    "observations": [],
                    "findings": [],
                    "read_paths": ["src/app.ts"],
                    "evidence_sources": ["src/app.ts"],
                    "cost_units": 1,
                },
            ),
            "cwd": ".",
            "timeout_ms": 1000,
            "stdin_json": True,
        },
        "schema_version": 1,
    }
    payload.update(overrides)
    return payload


def run_envelope(**overrides):
    payload = {
        "run_id": "run-1",
        "tool_id": "learning-adapter",
        "cycle_id": "cycle-1",
        "status": "ok",
        "input_hash": "sha256:input",
        "output_hash": "sha256:output",
        "read_paths": ["src/app.ts"],
        "emitted_observations": [],
        "emitted_findings": [],
        "evidence_validation": {"valid": True, "evidence_sources": ["src/app.ts"]},
        "operator_feedback_refs": [],
        "duration_ms": 10,
        "cost_units": 1,
        "schema_version": 1,
    }
    payload.update(overrides)
    return payload


class IncrementalLearningTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name) / "workspace"
        self.root.mkdir()
        (self.root / "src").mkdir()
        (self.root / "src/app.ts").write_text("export const app = true;\n", encoding="utf-8")
        (self.root / "package.json").write_text('{"name":"fixture"}\n', encoding="utf-8")
        (self.root / "nx.json").write_text('{"affected":{}}\n', encoding="utf-8")
        self.tools_dir = Path(self.tmp.name) / "aria-tools"

    def tearDown(self):
        self.tmp.cleanup()

    def test_two_independent_ai_judges_create_consensus_and_precision_signal(self):
        register_tool(tool_definition(), base_dir=self.tools_dir)
        record_run(run_envelope(runner={"raw_findings_sample": [{"id": "f-1", "rule": "r", "path": "src/app.ts"}]}), base_dir=self.tools_dir)
        verdicts = {
            "verdicts": [
                {
                    "tool_id": "learning-adapter",
                    "run_id": "run-1",
                    "finding_id": "f-1",
                    "verdict": "true_positive",
                    "judge_id": "judge-a",
                    "model": "fixture",
                    "prompt_hash": "sha256:p",
                    "confidence": 0.9,
                    "rationale": "supported",
                    "evidence_refs": ["src/app.ts"],
                    "judgment_group_id": "g-1",
                },
                {
                    "tool_id": "learning-adapter",
                    "run_id": "run-1",
                    "finding_id": "f-1",
                    "verdict": "true_positive",
                    "judge_id": "judge-b",
                    "model": "fixture",
                    "prompt_hash": "sha256:p",
                    "confidence": 0.86,
                    "rationale": "supported independently",
                    "evidence_refs": ["src/app.ts"],
                    "judgment_group_id": "g-1",
                },
            ],
        }
        record_ai_feedback_file(file_payload=verdicts, base_dir=self.tools_dir)
        consensus = generate_ai_consensus(tool_id="learning-adapter", cycle_id="cycle-1", base_dir=self.tools_dir)
        self.assertEqual(consensus["consensus_count"], 1)
        metrics = evaluate_health("learning-adapter", base_dir=self.tools_dir)["metrics"]
        self.assertEqual(metrics["precision_status"], "ai_consensus_judged")
        self.assertEqual(metrics["ai_consensus_judged_samples"], 1)

    def test_single_or_duplicate_ai_judge_does_not_create_consensus(self):
        register_tool(tool_definition(), base_dir=self.tools_dir)
        record_run(run_envelope(runner={"raw_findings_sample": [{"id": "f-1", "rule": "r", "path": "src/app.ts"}]}), base_dir=self.tools_dir)
        record_ai_feedback_file(
            file_payload=[
                {
                    "tool_id": "learning-adapter",
                    "run_id": "run-1",
                    "finding_id": "f-1",
                    "verdict": "false_positive",
                    "judge_id": "judge-a",
                    "model": "fixture",
                    "prompt_hash": "sha256:p",
                    "confidence": 0.95,
                    "judgment_group_id": "g-1",
                },
                {
                    "tool_id": "learning-adapter",
                    "run_id": "run-1",
                    "finding_id": "f-1",
                    "verdict": "false_positive",
                    "judge_id": "judge-a",
                    "model": "fixture",
                    "prompt_hash": "sha256:p",
                    "confidence": 0.99,
                    "judgment_group_id": "g-1",
                },
            ],
            base_dir=self.tools_dir,
        )
        consensus = generate_ai_consensus(tool_id="learning-adapter", cycle_id="cycle-1", base_dir=self.tools_dir)
        self.assertEqual(consensus["consensus_count"], 0)
        self.assertEqual(consensus["uncertainties"][0]["reason"], "single_judge")

    def test_pr_impact_carries_forward_unrelated_belief_and_invalidates_changed_evidence(self):
        run_discovery(workspace_root=self.root, cycle_id="cycle-1", base_dir=self.tools_dir)
        run_cycle_diff(cycle_id="cycle-1", base_dir=self.tools_dir)
        update_memory(cycle_id="cycle-1", base_dir=self.tools_dir)

        observe_pr_event(
            payload={"pr_number": 1, "event": "opened", "changed_files": ["src/app.ts"], "head_sha": "h1", "base_sha": "b1"},
            base_dir=self.tools_dir,
        )
        unrelated = plan_pr_impact(cycle_id="cycle-pr-1", base_dir=self.tools_dir)
        carried_ids = {item["belief_id"] for item in unrelated["carried_forward_beliefs"]}
        self.assertIn("repo-has-node-package-manifest", carried_ids)

        observe_pr_event(
            payload={"pr_number": 1, "event": "synchronize", "changed_files": ["package.json"], "head_sha": "h2", "base_sha": "b1"},
            base_dir=self.tools_dir,
        )
        impacted = plan_pr_impact(cycle_id="cycle-pr-2", base_dir=self.tools_dir)
        impacted_ids = {item["belief_id"] for item in impacted["impacted_beliefs"]}
        self.assertIn("repo-has-node-package-manifest", impacted_ids)
        latest = {row["belief_id"]: row for row in list_memory(kind="beliefs", base_dir=self.tools_dir)}
        self.assertEqual(latest["repo-has-node-package-manifest"]["status"], "needs_revalidation")

    def test_fixture_content_change_makes_latest_pass_not_current(self):
        fixture_root = self.tools_dir / "fixtures/learning-adapter/cases"
        fixture_root.mkdir(parents=True)
        case = fixture_root / "clean.json"
        case.write_text(json.dumps({"input": {}, "expected": {"status": "ok", "max_findings": 0}}), encoding="utf-8")
        register_tool(tool_definition(runner=tool_definition()["runner"]), base_dir=self.tools_dir)
        result = run_fixture_suite("learning-adapter", workspace_root=self.root, cycle_id="fixture-1", base_dir=self.tools_dir)
        self.assertTrue(result["passed"])
        self.assertTrue(latest_fixture_status("learning-adapter", base_dir=self.tools_dir)["current_tool_passed"])
        case.write_text(json.dumps({"input": {}, "expected": {"status": "ok", "max_findings": 1}}), encoding="utf-8")
        status = latest_fixture_status("learning-adapter", base_dir=self.tools_dir)
        self.assertFalse(status["current_tool_passed"])
        self.assertFalse(status["fixture_matches"])
        report = fixture_status_report("learning-adapter", base_dir=self.tools_dir)
        self.assertEqual(report["status"], "stale_or_failed")
        refreshed = refresh_fixture_suite("learning-adapter", workspace_root=self.root, cycle_id="fixture-2", base_dir=self.tools_dir)
        self.assertEqual(refreshed["status"], "current")

    def test_confirmed_false_positive_fingerprint_is_not_resampled_while_unchanged(self):
        register_tool(tool_definition(), base_dir=self.tools_dir)
        finding = {"id": "f-1", "rule": "r", "path": "src/app.ts", "message": "same", "evidence": [{"path": "src/app.ts", "line": 1}]}
        fingerprint = finding_fingerprint("learning-adapter", finding)
        record_operator_feedback(
            tool_id="learning-adapter",
            run_id="old-run",
            finding_id="f-1",
            verdict="false_positive",
            severity="medium",
            note="known fp",
            finding_fingerprint=fingerprint,
            base_dir=self.tools_dir,
        )
        record_run(
            run_envelope(run_id="new-run", cycle_id="cycle-2", runner={"raw_findings_sample": [finding]}),
            base_dir=self.tools_dir,
        )
        sample = generate_judgment_sample(tool_id="learning-adapter", sample_size=5, cycle_id="cycle-2", base_dir=self.tools_dir)
        self.assertEqual(sample["status"], "empty")
        self.assertEqual(sample["sampled_count"], 0)

    def test_goldset_proposal_enforces_default_target_counts(self):
        register_tool(tool_definition(), base_dir=self.tools_dir)
        record_operator_feedback(
            tool_id="learning-adapter",
            run_id="run-1",
            finding_id="tp-1",
            verdict="true_positive",
            severity="medium",
            note="confirmed",
            base_dir=self.tools_dir,
        )
        blocked = propose_goldset(tool_id="learning-adapter", cycle_id="cycle-gold", base_dir=self.tools_dir)
        self.assertEqual(blocked["status"], "blocked")
        self.assertIn("insufficient_true_positive_gold_items", blocked["blocked_by"])
        ready = propose_goldset(
            tool_id="learning-adapter",
            cycle_id="cycle-gold",
            target_true_positives=1,
            target_known_false_positives=0,
            base_dir=self.tools_dir,
        )
        self.assertEqual(ready["status"], "ready")

    def test_zero_finding_adapter_can_promote_with_operator_approval(self):
        fixture_root = self.tools_dir / "fixtures/learning-adapter/cases"
        fixture_root.mkdir(parents=True)
        (fixture_root / "clean.json").write_text(
            json.dumps({"input": {}, "expected": {"status": "ok", "max_findings": 0}}),
            encoding="utf-8",
        )
        register_tool(tool_definition(), base_dir=self.tools_dir)
        run_fixture_suite("learning-adapter", workspace_root=self.root, cycle_id="fixture-zero", base_dir=self.tools_dir)
        for idx in range(5):
            record_run(
                run_envelope(
                    run_id=f"zero-{idx}",
                    cycle_id=f"cycle-{idx}",
                    runner={"raw_findings_count": 0, "raw_findings_sample": []},
                ),
                base_dir=self.tools_dir,
            )

        report = generate_adapter_calibration_report(tool_ids=["learning-adapter"], cycle_id="cal-zero", base_dir=self.tools_dir)
        self.assertEqual(report["reports"][0]["precision_status"], "no_findings_to_judge")
        # JJ-2a (ORPHAN-HIGH-732) — the blocker this asserts the absence of
        # was renamed with its meaning ("has a person judged it?" became
        # "is there anchor-grade evidence?"). Asserting the OLD name would
        # be a pin that can never fail; the zero-finding lane bypasses the
        # judged-precision question entirely, which is what is pinned here.
        self.assertNotIn("precision_not_anchor_judged", report["reports"][0]["blocked_by"])
        promoted = promote_tool(
            "learning-adapter",
            "ACTIVE",
            reason="operator approved zero-finding adapter",
            operator_approval_ref="ops-zero-ack",
            base_dir=self.tools_dir,
        )
        self.assertEqual(promoted["status"], "ACTIVE")

    def test_noisy_adapter_readiness_uses_stable_runs_not_zero_raw_findings(self):
        fixture_root = self.tools_dir / "fixtures/learning-adapter/cases"
        fixture_root.mkdir(parents=True)
        (fixture_root / "clean.json").write_text(
            json.dumps({"input": {}, "expected": {"status": "ok", "required_findings": ["r"]}}),
            encoding="utf-8",
        )
        register_tool(
            tool_definition(
                runner={
                    **tool_definition()["runner"],
                    "argv": fake_tool_argv(
                        {
                            "observations": [],
                            "findings": [{"id": "f-1", "rule": "r", "path": "src/app.ts", "evidence": [{"path": "src/app.ts", "line": 1}]}],
                            "read_paths": ["src/app.ts"],
                            "evidence_sources": ["src/app.ts"],
                            "cost_units": 1,
                        },
                    ),
                },
            ),
            base_dir=self.tools_dir,
        )
        run_fixture_suite("learning-adapter", workspace_root=self.root, cycle_id="fixture-noisy", base_dir=self.tools_dir)
        finding = {"id": "f-1", "rule": "r", "path": "src/app.ts", "message": "real", "evidence": [{"path": "src/app.ts", "line": 1}]}
        for idx in range(5):
            record_run(
                run_envelope(
                    run_id=f"noisy-{idx}",
                    cycle_id=f"cycle-{idx}",
                    runner={"raw_findings_count": 1, "raw_findings_sample": [finding]},
                    raw_findings=[finding],
                ),
                base_dir=self.tools_dir,
            )
        record_operator_feedback(
            tool_id="learning-adapter",
            run_id="noisy-0",
            finding_id="f-1",
            verdict="true_positive",
            severity="medium",
            note="confirmed",
            finding_fingerprint=finding_fingerprint("learning-adapter", finding),
            base_dir=self.tools_dir,
        )

        report = generate_adapter_calibration_report(tool_ids=["learning-adapter"], cycle_id="cal-noisy", base_dir=self.tools_dir)
        blocked_by = report["reports"][0]["blocked_by"]
        self.assertEqual(report["reports"][0]["precision_status"], "human_judged")
        self.assertNotIn("last_5_runs_not_clean", blocked_by)
        self.assertNotIn("last_5_runs_not_stable", blocked_by)
        self.assertTrue(report["reports"][0]["active_ready"])

    def test_raw_finding_ledger_and_batch_feedback_cover_more_than_run_sample_limit(self):
        register_tool(tool_definition(), base_dir=self.tools_dir)
        findings = [
            {"id": f"f-{idx}", "rule": "r", "path": "src/app.ts", "message": f"finding {idx}", "evidence": [{"path": "src/app.ts", "line": 1}]}
            for idx in range(60)
        ]
        record_run(
            run_envelope(
                run_id="raw-60",
                cycle_id="cycle-raw",
                runner={"raw_findings_count": 60, "raw_findings_sample": findings[:50]},
                raw_findings=findings,
            ),
            base_dir=self.tools_dir,
        )
        sample = generate_judgment_sample(tool_id="learning-adapter", sample_size=60, cycle_id="cycle-raw", base_dir=self.tools_dir)
        self.assertEqual(sample["sampled_count"], 50)
        batch = record_operator_feedback_batch(
            sample_id=sample["sample_id"],
            verdict_payload={
                "verdicts": [
                    {"finding_id": item["finding_id"], "verdict": "true_positive", "severity": "medium", "note": "batch"}
                    for item in sample["items"]
                ],
            },
            base_dir=self.tools_dir,
        )
        self.assertEqual(batch["recorded_count"], 50)
        self.assertTrue(all(row["finding_fingerprint"] for row in batch["feedback"]))


if __name__ == "__main__":
    unittest.main()
