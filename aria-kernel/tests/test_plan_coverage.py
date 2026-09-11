"""Coverage wrapper controls and a native Git/TypeScript/Nx producer control.

PlanCoverageWrapperTests uses a declared runner substitute for computed reports
and unavailable toolchains. NativePlanCoverageTests executes the actual witness,
checks its graph and manifest, and records the real plan coverage event.
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


class NativePlanCoverageTests(unittest.TestCase):
    def test_nested_plan_surfaces_reach_real_witness_and_native_coverage_record(self) -> None:
        from datetime import datetime, timedelta, timezone
        import hashlib
        import os
        from unittest.mock import patch
        from aria_kernel.ledger import load_declared_jsonl
        from aria_kernel.plan_convergence import (
            content_hash, plan_status, record_coverage, record_critique,
            request_critics, start_plan,
        )
        from aria_kernel.runtime_profile import set_profile
        from aria_kernel.tool_registry import ensure_tools_binding
        from tests._helpers.git_fixtures import make_repo_with_initial_commit

        fixture_directory = tempfile.TemporaryDirectory(prefix="aria-native-coverage-")
        self.addCleanup(fixture_directory.cleanup)
        fixture = Path(fixture_directory.name)
        tools = fixture / "store" / "tools"
        selected_repo = Path(__file__).resolve().parents[2]
        source_path = "libs/interval-core/src/index.ts"
        note_path = "docs/coverage-note.md"
        native_tool_paths = ("tools/gates/plan-coverage-witness.ts", "tools/gates/tsconfig.json")
        native_tool_bytes = {path: (selected_repo / path).read_bytes() for path in native_tool_paths}
        files = {
            ".gitignore": "/node_modules\n.nx/\naria-debts/\n",
            "package.json": json.dumps({"name": "native-coverage-fixture", "private": True}),
            "nx.json": json.dumps({"neverConnectToCloud": True, "plugins": []}),
            "libs/interval-core/project.json": json.dumps({
                "name": "interval-core", "root": "libs/interval-core", "projectType": "library", "targets": {},
            }),
            "apps/farm-service/project.json": json.dumps({
                "name": "farm-service", "root": "apps/farm-service", "projectType": "application",
                "implicitDependencies": ["interval-core"], "targets": {},
            }),
            source_path: "export const interval = 30;\n",
            "apps/farm-service/src/index.ts": "export const unit = 'seconds';\n",
            note_path: "This documentation path has no owning Nx project.\n",
            ".claude/agents/farm-expert.md": "---\nname: farm-expert\ndescription: Fixture reviewer.\n---\nOwns `apps/farm-service/**`.\n",
            **{path: data.decode("utf-8") for path, data in native_tool_bytes.items()},
        }
        environment_values = {name: value for name, value in os.environ.items()
            if not name.startswith(("ARIA_", "NX_", "npm_config_", "NPM_CONFIG_"))
            and name != "NODE_OPTIONS"}
        witness_tmp = fixture / "witness-tmp"
        witness_tmp.mkdir()
        environment_values.update({
            "ARIA_TOOLS_DIR": str(tools), "ARIA_REPO_STATE_ROOT": str(fixture / "repo-state"),
            "ARIA_STATE_STORE_ROOT": str(fixture / "state-store"),
            "ARIA_WORKSPACE_BASE": str(fixture / "workspaces"),
            "NX_DAEMON": "false", "NX_ISOLATE_PLUGINS": "false", "NX_SKIP_NX_CACHE": "true",
            "NX_CACHE_DIRECTORY": str(fixture / "nx-cache"),
            "NX_WORKSPACE_DATA_DIRECTORY": str(fixture / "nx-data"),
            "npm_config_cache": str(fixture / "npm-cache"), "npm_config_offline": "true",
            "TMPDIR": str(witness_tmp),
        })
        environment = patch.dict(os.environ, environment_values, clear=True)
        environment.start()
        self.addCleanup(environment.stop)
        repo = make_repo_with_initial_commit(fixture / "source", files)
        installed = Path("/var/aqua-saas/node_modules")
        for package in ("nx", "typescript", "ts-node"):
            self.assertTrue((installed / package / "package.json").is_file())
        (repo / "node_modules").symlink_to(installed, target_is_directory=True)
        head = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=repo, text=True).strip()
        self.assertEqual(subprocess.check_output(["git", "status", "--porcelain"], cwd=repo), b"")
        for path, expected_bytes in native_tool_bytes.items():
            self.assertEqual((repo / path).read_bytes(), expected_bytes)
            self.assertEqual(subprocess.check_output(["git", "show", head + ":" + path], cwd=repo), expected_bytes)
        ensure_tools_binding(tools, workspace_root=repo)
        set_profile("strict", operator_approval_ref="test:native-plan-coverage", base_dir=tools)
        plan_id = "plan-native-nested-coverage"
        plan_content = {
            "schema_version": 2, "title": "Inspect interval dependency coverage",
            "summary": "The source owner and its dependent need separate coverage.",
            "affected_surfaces": [{"paths": [source_path]}, {"paths": [note_path]}],
            "key_changes": ["inspect the declared interval source"],
            "validation_commands": [], "evidence_refs": [source_path + ":1"],
            "coverage": {"waivers": []},
        }
        start_plan(plan_id=plan_id, initial_revision_id="rev-0", plan_content=plan_content, base_dir=tools)
        latest = plan_status(plan_id=plan_id, base_dir=tools)["latest_revision"]
        task = {
            "task_id": "coverage-task-1", "task_packet_hash": content_hash({"task": "coverage-task-1"}),
            "target_agent": "farm-expert", "target_revision_id": latest["revision_id"],
            "target_plan_content_hash": latest["content_hash"],
            "sla_deadline": (datetime.now(timezone.utc) + timedelta(minutes=10)).isoformat(),
        }
        request_critics(plan_id=plan_id, request={"round_number": 1,
            "target_revision_id": latest["revision_id"], "target_plan_content_hash": latest["content_hash"],
            "tasks": [task]}, base_dir=tools)
        record_critique(plan_id=plan_id, critique={
            "task_packet_hash": task["task_packet_hash"], "target_revision_id": latest["revision_id"],
            "target_plan_content_hash": latest["content_hash"], "reviewer": "farm-expert", "risks": [],
            "critique_content_hash": content_hash({"reviewer": "farm-expert", "risks": []}),
        }, workspace_root=repo, base_dir=tools)
        self.assertEqual(plan_status(plan_id=plan_id, base_dir=tools)["state"], "CRITIQUED")
        events_path = tools / "plans" / "events.jsonl"
        before = load_declared_jsonl(events_path, expected_surface="plan_convergence_events")
        self.assertEqual(before[0]["payload"]["plan_content"]["affected_surfaces"], plan_content["affected_surfaces"])
        payload = compute_plan_coverage(plan_content=plan_content, plan_id=plan_id, round_number=1,
            target_revision_id=latest["revision_id"], target_plan_content_hash=latest["content_hash"],
            workspace_root=repo, base_dir=tools)
        self.assertIn(payload["witness"].get("exit_code"), (0, 1), payload)
        self.assertEqual(payload["witness"]["tool"], native_tool_paths[0])
        self.assertEqual(payload["computed_at_sha"], head)
        generated_graphs = list(witness_tmp.glob("plan-coverage-*/nx-graph.json"))
        self.assertEqual(len(generated_graphs), 1)
        graph = json.loads(generated_graphs[0].read_text())["graph"]
        self.assertEqual(graph["nodes"]["interval-core"]["data"]["root"], "libs/interval-core")
        self.assertEqual(graph["nodes"]["farm-service"]["data"]["root"], "apps/farm-service")
        self.assertTrue(any(edge["target"] == "interval-core"
            for edge in graph["dependencies"]["farm-service"]))
        manifest_path = tools / "coverage" / (plan_id + "-r1.json")
        manifest_bytes = manifest_path.read_bytes()
        self.assertEqual(payload["closure_manifest_hash"], "sha256:" + hashlib.sha256(manifest_bytes).hexdigest())
        self.assertEqual(load_declared_jsonl(events_path, expected_surface="plan_convergence_events"), before)
        # First intended regression: the real dependent must not disappear
        # because the wrapper stringified a normal nested affected surface.
        self.assertEqual(payload["verdict"], "gaps", payload)
        witness_input = json.loads((tools / "coverage" / (plan_id + "-r1-input.json")).read_text())
        self.assertEqual(witness_input["affected_paths"], [source_path, note_path])
        report = json.loads(manifest_bytes)
        self.assertEqual({row["name"] for row in report["closure"]["projects"]}, {"interval-core", "farm-service"})
        self.assertEqual(report["unmapped_paths"], [note_path])
        self.assertEqual([row["node_id"] for row in payload["uncovered"]], ["project:farm-service"])
        self.assertEqual(payload["closure_summary"]["projects"], 2)
        self.assertEqual(payload["closure_summary"]["unmapped_paths"], 1)
        self.assertEqual(len(payload["synthetic_risks"]), 1)
        recorded = record_coverage(plan_id=plan_id, coverage=payload, base_dir=tools)
        native_after = load_declared_jsonl(events_path, expected_surface="plan_convergence_events")
        self.assertEqual(native_after[:-1], before)
        self.assertEqual(native_after[-1], recorded["event"])
        self.assertEqual(native_after[-1]["event_type"], "coverage_computed")
        self.assertEqual(native_after[-1]["payload"], payload)
        self.assertEqual(plan_status(plan_id=plan_id, base_dir=tools)["coverage_by_round"][1], payload)
        self.assertEqual(manifest_path.read_bytes(), manifest_bytes)



if __name__ == "__main__":
    unittest.main()
