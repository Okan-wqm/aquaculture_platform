"""plan_coverage.compute_plan_coverage — London-school pins (no subprocess).

The wrapper's contract: NEVER raise for environmental problems; exit 0/1 from
the witness is "computed" (covered/gaps), everything else — missing
toolchain, timeout, non-zero-non-one exit, garbage stdout — becomes
verdict="environment_unable", which the evaluator escalates to
HUMAN_REQUIRED. A fake runner injects each case.
"""
from __future__ import annotations

import json
import subprocess
import tempfile
import unittest
from pathlib import Path

from aria_kernel.plan_convergence import _validate_cross_review_risk
from aria_kernel.plan_coverage import build_synthetic_risk, compute_plan_coverage

PLAN_CONTENT = {
    "schema_version": 2,
    "title": "t",
    "summary": "s",
    "affected_surfaces": [{"paths": ["libs/farm-shared/src/index.ts"]}],
    "key_changes": ["x"],
    "validation_commands": [],
    "evidence_refs": ["docs/aria/SPEC.md"],
    "coverage": {"waivers": [{"node": "project:x", "reason": "verified"}]},
}

WITNESS_REPORT = {
    "schema_version": 1,
    "verdict": "gaps",
    "closure": {
        "projects": [{"name": "farm-service", "root": "apps/farm-service", "reason": "reverse_dependent"}],
        "event_consumers": [],
        "migration_couplings": [],
    },
    "uncovered": [{"node_id": "project:farm-service", "kind": "nx_project", "why": "reverse dependent"}],
    "waived": [{"node_id": "project:x", "reason": "verified"}],
    "unmapped_paths": ["docs/adr/041.md"],
    "inputs_hash": "abc",
}


class _FakeRunner:
    """Scripted runner: git rev-parse first, then the witness call."""

    def __init__(self, witness_result):
        self.witness_result = witness_result
        self.calls: list[list[str]] = []

    def __call__(self, cmd, cwd, timeout_seconds):
        self.calls.append(list(cmd))
        if cmd[:2] == ["git", "rev-parse"]:
            return subprocess.CompletedProcess(cmd, 0, stdout="a" * 40 + "\n", stderr="")
        result = self.witness_result
        if isinstance(result, Exception):
            raise result
        return result


class PlanCoverageWrapperTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.workspace = Path(self.tmp.name) / "ws"
        self.workspace.mkdir()
        self.tools = Path(self.tmp.name) / "aria-tools"

    def tearDown(self):
        self.tmp.cleanup()

    def compute(self, runner):
        return compute_plan_coverage(
            plan_content=PLAN_CONTENT,
            plan_id="plan-1",
            round_number=1,
            target_revision_id="rev-0",
            target_plan_content_hash="sha256:" + "0" * 64,
            workspace_root=self.workspace,
            base_dir=self.tools,
            runner=runner,
        )

    def test_gaps_report_produces_round_scoped_valid_risks_and_manifest(self):
        runner = _FakeRunner(
            subprocess.CompletedProcess([], 1, stdout=json.dumps(WITNESS_REPORT), stderr=""),
        )
        payload = self.compute(runner)
        self.assertEqual(payload["verdict"], "gaps")
        self.assertEqual(len(payload["synthetic_risks"]), 1)
        risk = payload["synthetic_risks"][0]
        self.assertTrue(risk["risk_id"].startswith("COV-R1-"))
        self.assertEqual(risk["risk_category"], "coverage_gap")
        self.assertEqual(risk["severity"], "material")
        # Must pass the kernel's cross-review risk schema exactly.
        _validate_cross_review_risk(risk)
        manifest = self.tools / "coverage" / "plan-1-r1.json"
        self.assertTrue(manifest.exists())
        self.assertEqual(json.loads(manifest.read_text())["verdict"], "gaps")
        self.assertTrue(payload["closure_manifest_hash"].startswith("sha256:"))
        self.assertEqual(payload["computed_at_sha"], "a" * 40)
        # The witness received the plan's waivers.
        witness_call = runner.calls[-1]
        input_path = Path(witness_call[witness_call.index("--input") + 1])
        witness_input = json.loads(input_path.read_text())
        self.assertEqual(witness_input["waivers"], [{"node": "project:x", "reason": "verified"}])

    def test_clean_report_is_covered_with_waivers(self):
        clean = {**WITNESS_REPORT, "verdict": "covered_with_waivers", "uncovered": []}
        runner = _FakeRunner(subprocess.CompletedProcess([], 0, stdout=json.dumps(clean), stderr=""))
        payload = self.compute(runner)
        self.assertEqual(payload["verdict"], "covered_with_waivers")
        self.assertEqual(payload["synthetic_risks"], [])
        self.assertEqual(payload["closure_summary"]["waived"], 1)

    def test_missing_toolchain_is_environment_unable(self):
        payload = self.compute(_FakeRunner(FileNotFoundError("npx not found")))
        self.assertEqual(payload["verdict"], "environment_unable")
        self.assertIn("toolchain_missing", payload["witness"]["error"])

    def test_timeout_is_environment_unable(self):
        payload = self.compute(_FakeRunner(subprocess.TimeoutExpired(cmd="npx", timeout=180)))
        self.assertEqual(payload["verdict"], "environment_unable")
        self.assertIn("timeout", payload["witness"]["error"])

    def test_environment_exit_code_is_environment_unable(self):
        runner = _FakeRunner(subprocess.CompletedProcess([], 2, stdout="", stderr="nx graph unavailable"))
        payload = self.compute(runner)
        self.assertEqual(payload["verdict"], "environment_unable")
        self.assertIn("witness_environment_exit_2", payload["witness"]["error"])

    def test_garbage_stdout_is_environment_unable_not_covered(self):
        runner = _FakeRunner(subprocess.CompletedProcess([], 0, stdout="not json at all", stderr=""))
        payload = self.compute(runner)
        self.assertEqual(payload["verdict"], "environment_unable")
        self.assertIn("witness_output_unparseable", payload["witness"]["error"])

    def test_synthetic_risk_ids_differ_across_rounds_for_same_node(self):
        node = {"node_id": "project:farm-service", "kind": "nx_project", "why": "w"}
        r1 = build_synthetic_risk(node, round_number=1, closure_manifest_path="aria-tools/coverage/p-r1.json")
        r2 = build_synthetic_risk(node, round_number=2, closure_manifest_path="aria-tools/coverage/p-r2.json")
        self.assertNotEqual(r1["risk_id"], r2["risk_id"])
        self.assertTrue(r1["risk_id"].startswith("COV-R1-"))
        self.assertTrue(r2["risk_id"].startswith("COV-R2-"))


if __name__ == "__main__":
    unittest.main()
