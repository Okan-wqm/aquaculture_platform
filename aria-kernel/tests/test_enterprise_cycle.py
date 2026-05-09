from __future__ import annotations

import json
import subprocess
import sys
import tempfile
import tomllib
import unittest
from contextlib import redirect_stderr, redirect_stdout
from io import StringIO
from pathlib import Path

from aria_kernel import (
    OUTPUT_CONTRACT_COMPAT_REMOVAL_VERSION,
    record_proposal,
    record_run,
    record_research_source,
    register_tool,
    generate_judgment_sample,
    run_cycle,
    run_cycle_diff,
    run_discovery,
    run_reflection,
    run_tool,
    update_memory,
    verify_integrity,
    withdraw_belief,
)
from aria_kernel.constants import OUTPUT_CONTRACT_COMPAT_FINDING_ID
from aria_kernel.cli import main
from aria_kernel.feedback_store import record_operator_feedback
from aria_kernel.ledger import append_jsonl
from aria_kernel.memory import list_memory, validate_repo_evidence
from aria_kernel.pressure import explain_pressure, run_pressure
from aria_kernel.tool_registry import GovernanceError, transition_tool, get_tool


def register_active_for_test(tool, base_dir):
    """Plan 023 v3 §C-3 — test fixture helper (mirrors test_tool_governance).

    register_tool now rejects first-time registrations at ACTIVE / CALIBRATE
    / QUARANTINED. Route ACTIVE through SHADOW + transition_tool, route
    QUARANTINED through SHADOW + quarantine_tool, and let initial-lifecycle
    states pass through register_tool unchanged.
    """
    target = tool.get("status", "ACTIVE")
    if target in ("DRAFT", "SANDBOX", "SHADOW"):
        return register_tool(tool, base_dir=base_dir)
    if target not in ("ACTIVE", "CALIBRATE", "QUARANTINED"):
        return register_tool(tool, base_dir=base_dir)
    initial = {**tool, "status": "SHADOW"}
    register_tool(initial, base_dir=base_dir)
    if target == "QUARANTINED":
        from aria_kernel.quarantine import quarantine_tool
        return quarantine_tool(
            tool["tool_id"], "test fixture quarantine", base_dir=base_dir,
        )
    return transition_tool(
        tool["tool_id"],
        target_status=target,
        reason="test fixture promotion",
        precision=1.0,
        critical_false_positives=0,
        evidence_chains_valid=True,
        operator_approval=True,
        base_dir=base_dir,
    )


def fake_tool_argv(output):
    return [sys.executable, "-c", f"import json; print({json.dumps(json.dumps(output))})"]


def echo_input_tool_argv():
    script = (
        "import json, sys; "
        "payload=json.load(sys.stdin); "
        "out={'observations':[{'id':'obs-1','type':'fixture','details':payload}],"
        "'findings':[],'read_paths':['src/app.ts'],'evidence_sources':[],"
        "'cost_units':1,'metadata':{'fixture':True}}; "
        "print(json.dumps(out))"
    )
    return [sys.executable, "-c", script]


def tool_output(**overrides):
    payload = {
        "observations": [{"id": "obs-1", "type": "fixture"}],
        "findings": [{"id": "finding-1", "evidence": [{"path": "src/app.ts", "line": 1}]}],
        "read_paths": ["src/app.ts"],
        "evidence_sources": ["src/app.ts"],
        "cost_units": 1,
        "metadata": {"fixture": True},
    }
    payload.update(overrides)
    return payload


def shadow_tool():
    return {
        "tool_id": "fixture-shadow-tool",
        "kind": "adapter",
        "version": "1.0.0",
        "status": "SHADOW",
        "declared_scope": ["src/**/*.ts"],
        "output_schema": {
            "type": "object",
            "required": ["observations", "findings", "read_paths", "evidence_sources"],
        },
        "fixture_set": "fixtures/fixture-shadow-tool",
        "health_thresholds": {"max_cost_units": 10},
        "allowed_read_globs": ["src/**/*.ts"],
        "forbidden_read_globs": [],
        "claim_types": ["fixture"],
        "owner": "platform",
        "runner": {
            "type": "subprocess",
            "argv": fake_tool_argv(tool_output()),
            "cwd": ".",
            "timeout_ms": 1000,
            "stdin_json": True,
        },
        "schema_version": 1,
    }


def candidate_tool(confidence=0.7):
    tool = shadow_tool()
    tool["tool_id"] = "candidate-tool"
    tool["runner"] = {
        "type": "subprocess",
        "argv": fake_tool_argv(
            tool_output(
                belief_candidates=[
                    {
                        "belief_id": "candidate:repo-shape",
                        "claim": "fixture repo exposes a candidate shape belief",
                        "confidence": confidence,
                        "evidence_refs": ["src/app.ts"],
                        "source_tool_id": "candidate-tool",
                    },
                ],
            ),
        ),
        "cwd": ".",
        "timeout_ms": 1000,
        "stdin_json": True,
    }
    return tool


def self_output_tool():
    tool = shadow_tool()
    tool["tool_id"] = "self-output-tool"
    tool["runner"] = {
        "type": "subprocess",
        "argv": fake_tool_argv(tool_output(evidence_sources=["aria-tools/runs.jsonl"])),
        "cwd": ".",
        "timeout_ms": 1000,
        "stdin_json": True,
    }
    return tool


class EnterpriseCycleTests(unittest.TestCase):
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

    def init_git_repo(self):
        subprocess.run(["git", "init"], cwd=self.root, check=True, capture_output=True)
        subprocess.run(["git", "config", "user.email", "aria@example.test"], cwd=self.root, check=True, capture_output=True)
        subprocess.run(["git", "config", "user.name", "ARIA Test"], cwd=self.root, check=True, capture_output=True)
        subprocess.run(["git", "add", "."], cwd=self.root, check=True, capture_output=True)
        subprocess.run(["git", "commit", "-m", "initial"], cwd=self.root, check=True, capture_output=True)

    def test_discovery_writes_fates_and_completion_proof(self):
        result = run_discovery(workspace_root=self.root, cycle_id="cycle-1", base_dir=self.tools_dir)
        self.assertTrue(result["completion_proof"]["complete"])
        paths = {row["path"] for row in result["fates"]}
        self.assertIn("src/app.ts", paths)
        self.assertTrue((self.tools_dir / "discovery/cycle-1/FATES.json").exists())
        self.assertTrue((self.tools_dir / "discovery/cycle-1/SNAPSHOT.json").exists())

    def test_committed_snapshot_blocks_dirty_git_workspace(self):
        self.init_git_repo()
        (self.root / "src/untracked.ts").write_text("export const dirty = true;\n", encoding="utf-8")
        stderr = StringIO()
        with redirect_stderr(stderr):
            result = run_discovery(workspace_root=self.root, cycle_id="cycle-dirty", base_dir=self.tools_dir)
        self.assertIn("warning: committed snapshot ignores", stderr.getvalue())
        self.assertFalse(result["completion_proof"]["dirty_snapshot"])
        governance = (self.tools_dir / "governance.jsonl").read_text(encoding="utf-8")
        self.assertIn("discovery_dirty_tree_skipped", governance)

    def test_working_tree_snapshot_includes_untracked_files(self):
        self.init_git_repo()
        (self.root / "src/untracked.ts").write_text("export const dirty = true;\n", encoding="utf-8")
        result = run_discovery(
            workspace_root=self.root,
            cycle_id="cycle-working-tree",
            base_dir=self.tools_dir,
            snapshot_mode="working-tree",
        )
        paths = {row["path"] for row in result["fates"]}
        self.assertIn("src/untracked.ts", paths)
        self.assertTrue(result["completion_proof"]["dirty_snapshot"])
        git_tracked = subprocess.check_output(["git", "ls-files"], cwd=self.root, text=True).splitlines()
        working_tree = subprocess.check_output(["git", "ls-files", "-co", "--exclude-standard"], cwd=self.root, text=True).splitlines()
        counts = result["completion_proof"]["file_counts"]
        self.assertEqual(counts["git_tracked"], len(git_tracked))
        self.assertEqual(counts["working_tree"], len(working_tree))
        self.assertEqual(counts["allowed"], len([row for row in result["fates"] if row["fate"] == "tracked"]))
        self.assertEqual(counts["fated"], len(result["fates"]))
        self.assertEqual(result["completion_proof"]["tracked_file_count"], counts["allowed"])
        self.assertEqual(result["completion_proof"]["legacy_tracked_file_count"], counts["allowed"])
        snapshot_payload = json.loads((self.tools_dir / "discovery/cycle-working-tree/SNAPSHOT.json").read_text(encoding="utf-8"))
        fingerprint_payload = json.loads((self.tools_dir / "discovery/cycle-working-tree/REPO_FINGERPRINT.json").read_text(encoding="utf-8"))
        self.assertEqual(snapshot_payload["file_counts"], counts)
        self.assertEqual(snapshot_payload["tracked_file_count"], counts["allowed"])
        self.assertEqual(snapshot_payload["legacy_tracked_file_count"], counts["allowed"])
        self.assertEqual(fingerprint_payload["file_counts"], counts)
        self.assertEqual(fingerprint_payload["tracked_file_count"], counts["fated"])
        self.assertEqual(fingerprint_payload["legacy_tracked_file_count"], counts["fated"])

    def test_snapshot_outside_evidence_marks_run_invalid_and_unsampleable(self):
        tool = shadow_tool()
        tool["runner"] = {
            "type": "subprocess",
            "argv": fake_tool_argv(
                tool_output(
                    findings=[
                        {
                            "id": "outside",
                            "rule": "fixture",
                            "severity": "high",
                            "path": "src/untracked.ts",
                            "evidence": [{"path": "src/untracked.ts", "line": 1}],
                        },
                    ],
                    read_paths=["src/untracked.ts"],
                    evidence_sources=["src/untracked.ts"],
                ),
            ),
            "cwd": ".",
            "timeout_ms": 1000,
            "stdin_json": True,
        }
        register_tool(tool, base_dir=self.tools_dir)
        decision = run_tool(
            "fixture-shadow-tool",
            {"repo_snapshot": {"allowed_paths": ["src/app.ts"], "snapshot_mode": "committed", "snapshot_hash": "sha256:test"}},
            "cycle-snapshot-invalid",
            workspace_root=self.root,
            base_dir=self.tools_dir,
        )
        self.assertEqual(decision["action"], "quarantine")
        run = self.latest_run()
        self.assertEqual(run["status"], "evidence_error")
        raw = json.loads((self.tools_dir / "raw-findings.jsonl").read_text(encoding="utf-8").strip())
        self.assertEqual(raw["status"], "invalid_evidence")
        sample = generate_judgment_sample(
            tool_id="fixture-shadow-tool",
            sample_size=5,
            cycle_id="cycle-snapshot-invalid",
            base_dir=self.tools_dir,
        )
        self.assertEqual(sample["sampled_count"], 0)

    def test_full_shadow_cycle_runs_engines_and_suppresses_operator_emission(self):
        register_tool(shadow_tool(), base_dir=self.tools_dir)
        result = run_cycle(
            workspace_root=self.root,
            cycle_id="cycle-shadow",
            base_dir=self.tools_dir,
            shadow_only=True,
        )
        self.assertEqual(result["status"], "completed")
        self.assertEqual(result["tool_governance_decisions"], result["tool_decisions"])
        self.assertEqual(result["event"]["tool_governance_decision_count"], 1)
        self.assertEqual(result["event"]["tool_decision_count"], 1)
        self.assertEqual(len(result["tool_run_summary"]), 1)
        summary = result["tool_run_summary"][0]
        self.assertEqual(summary["raw_findings_count"], 1)
        self.assertEqual(summary["raw_observations_count"], 1)
        self.assertEqual(summary["emitted_findings_count"], 0)
        self.assertNotIn("raw_findings", summary)
        self.assertNotIn("emitted_findings", summary)
        self.assertEqual(result["reflection"]["tool_run_count"], 1)
        run = self.latest_run()
        self.assertEqual(run["status"], "ok")
        self.assertEqual(run["emitted_findings"], [])
        self.assertGreater(run["runner"]["raw_findings_count"], 0)
        self.assertEqual(result["cycle_metrics"]["status"], "ok")
        self.assertEqual(result["observability_dashboard"]["latest_cycle"]["cycle_id"], "cycle-shadow")
        self.assertTrue((self.tools_dir / "reports/daily").exists())
        report = next((self.tools_dir / "reports/daily").glob("*.md")).read_text(encoding="utf-8")
        self.assertNotIn("Tracked files", report)
        self.assertIn("Git tracked", report)
        self.assertIn("Working-tree", report)
        self.assertIn("Allowed", report)
        self.assertIn("Fated", report)
        for heading in (
            "## Coverage",
            "## Beliefs",
            "## Stale / Revalidation",
            "## Top Pressures",
            "## Tool Health",
            "## Next Cycle Plan",
        ):
            self.assertIn(heading, report)

    def test_integrity_flags_started_cycle_without_terminal_event(self):
        append_jsonl(
            self.tools_dir / "cycles.jsonl",
            {
                "schema_version": 1,
                "at": "2026-05-04T00:00:00+00:00",
                "cycle_id": "stale-cycle",
                "event": "started",
            },
        )
        result = verify_integrity(base_dir=self.tools_dir)
        self.assertFalse(result["valid"])
        self.assertEqual(result["cycle_lifecycle"]["incomplete_cycles"][0]["cycle_id"], "stale-cycle")

    def test_integrity_accepts_old_and_new_cycle_terminal_shapes(self):
        append_jsonl(
            self.tools_dir / "cycles.jsonl",
            {
                "schema_version": 1,
                "at": "2026-05-04T00:00:00+00:00",
                "cycle_id": "old-shape",
                "event": "started",
            },
        )
        append_jsonl(
            self.tools_dir / "cycles.jsonl",
            {
                "schema_version": 1,
                "at": "2026-05-04T00:01:00+00:00",
                "cycle_id": "old-shape",
                "event": "completed",
                "tool_decision_count": 1,
            },
        )
        append_jsonl(
            self.tools_dir / "cycles.jsonl",
            {
                "schema_version": 1,
                "at": "2026-05-04T00:02:00+00:00",
                "cycle_id": "new-shape",
                "event": "started",
            },
        )
        append_jsonl(
            self.tools_dir / "cycles.jsonl",
            {
                "schema_version": 1,
                "at": "2026-05-04T00:03:00+00:00",
                "cycle_id": "new-shape",
                "event": "completed",
                "tool_governance_decision_count": 1,
                "tool_decision_count": 1,
            },
        )
        self.assertTrue(verify_integrity(base_dir=self.tools_dir)["valid"])

    def test_pressure_and_reflection_surface_raw_finding_delta(self):
        tool = shadow_tool()
        register_tool(tool, base_dir=self.tools_dir)
        base_run = {
            "schema_version": 1,
            "tool_id": "fixture-shadow-tool",
            "status": "ok",
            "input_hash": "sha256:input",
            "output_hash": "sha256:output",
            "read_paths": ["src/app.ts"],
            "emitted_observations": [],
            "emitted_findings": [],
            "evidence_validation": {"valid": True},
            "operator_feedback_refs": [],
            "duration_ms": 1,
            "cost_units": 0,
        }
        record_run({**base_run, "run_id": "run-prev", "cycle_id": "cycle-1", "runner": {"raw_findings_count": 2, "raw_observations_count": 1}}, base_dir=self.tools_dir)
        record_run({**base_run, "run_id": "run-current", "cycle_id": "cycle-2", "runner": {"raw_findings_count": 5, "raw_observations_count": 1}}, base_dir=self.tools_dir)
        pressure = run_pressure(cycle_id="cycle-2", base_dir=self.tools_dir)
        self.assertTrue(any(item["source"] == "shadow_raw_delta" for item in pressure["pressures"]))
        reflection = run_reflection(cycle_id="cycle-2", base_dir=self.tools_dir)
        self.assertEqual(reflection["tool_runtime"][0]["raw_finding_delta_vs_prev_cycle"], 3)

    def test_cycle_merges_tool_default_input(self):
        tool = shadow_tool()
        tool["status"] = "ACTIVE"
        tool["default_input"] = {"roots": ["src"], "mode": "fixture"}
        tool["runner"] = {
            "type": "subprocess",
            "argv": echo_input_tool_argv(),
            "cwd": ".",
            "timeout_ms": 1000,
            "stdin_json": True,
        }
        register_active_for_test(tool, base_dir=self.tools_dir)
        run_cycle(
            workspace_root=self.root,
            cycle_id="cycle-default-input",
            base_dir=self.tools_dir,
            shadow_only=False,
        )
        run = self.latest_run()
        details = run["emitted_observations"][0]["details"]
        self.assertEqual(run["runner"]["raw_observations_count"], 1)
        self.assertEqual(details["roots"], ["src"])
        self.assertEqual(details["mode"], "fixture")
        self.assertEqual(details["cycle_id"], "cycle-default-input")
        self.assertIn("pressure_summary", details)
        snapshot = details["repo_snapshot"]
        self.assertEqual(snapshot["tool_scope_allowed_count"], snapshot["tool_scope_path_count"])
        self.assertIn("file_counts", run["repo_snapshot"])
        self.assertEqual(run["repo_snapshot"]["tracked_file_count"], run["repo_snapshot"]["legacy_tracked_file_count"])
        self.assertEqual(run["repo_snapshot"]["tool_scope_allowed_count"], run["repo_snapshot"]["tool_scope_path_count"])
        self.assertTrue(verify_integrity(base_dir=self.tools_dir)["valid"])

    def test_cycle_honors_stop_file_before_start(self):
        self.tools_dir.mkdir(parents=True)
        (self.tools_dir / "ARIA_STOP").write_text("stop\n", encoding="utf-8")
        result = run_cycle(workspace_root=self.root, cycle_id="cycle-stop", base_dir=self.tools_dir)
        self.assertEqual(result["event"], "stopped")
        self.assertFalse((self.tools_dir / "discovery/cycle-stop").exists())

    def test_pressure_records_repetition_from_migration_surface(self):
        migration_dir = self.root / "apps/farm-service/src/database/migrations"
        migration_dir.mkdir(parents=True)
        for index in range(5):
            (migration_dir / f"178800000000{index}-Example.ts").write_text("export class M{}\n", encoding="utf-8")
        run_discovery(workspace_root=self.root, cycle_id="cycle-pressure", base_dir=self.tools_dir)
        payload = run_pressure(cycle_id="cycle-pressure", base_dir=self.tools_dir)
        self.assertEqual(payload["summary"]["repetition"], 1)
        pressure = payload["pressures"][0]
        self.assertEqual(pressure["score_components"]["source_weight"], 30)
        repeated = run_pressure(cycle_id="cycle-pressure", base_dir=self.tools_dir)
        self.assertEqual(
            [(item["pressure_id"], item["score_components"]) for item in payload["pressures"]],
            [(item["pressure_id"], item["score_components"]) for item in repeated["pressures"]],
        )
        explained = explain_pressure(
            cycle_id="cycle-pressure",
            pressure_id=pressure["pressure_id"],
            base_dir=self.tools_dir,
        )
        self.assertEqual(explained["pressure_id"], pressure["pressure_id"])

    def test_memory_belief_uses_repo_evidence_not_self_output(self):
        run_cycle(workspace_root=self.root, cycle_id="cycle-memory", base_dir=self.tools_dir, discovery_only=False)
        observation = json.loads((self.tools_dir / "memory/observations.jsonl").read_text(encoding="utf-8").splitlines()[0])
        self.assertIn("file_counts", observation)
        self.assertEqual(observation["tracked_file_count"], observation["legacy_tracked_file_count"])
        beliefs = list_memory(kind="beliefs", base_dir=self.tools_dir)
        self.assertTrue(any(row.get("belief_id") == "repo-uses-nx" for row in beliefs))
        self.assertTrue(all("aria-tools/" not in str(row.get("evidence_refs", [])) for row in beliefs))

    def test_feedback_affected_belief_ids_adjust_only_targeted_belief(self):
        run_cycle(workspace_root=self.root, cycle_id="cycle-feedback-1", base_dir=self.tools_dir)
        first = {row["belief_id"]: row for row in list_memory(kind="beliefs", base_dir=self.tools_dir)}
        record_operator_feedback(
            tool_id="operator",
            run_id="manual",
            finding_id="manual",
            verdict="false_positive",
            severity="medium",
            note="manual calibration",
            affected_belief_ids=["repo-uses-nx"],
            base_dir=self.tools_dir,
        )
        run_cycle(workspace_root=self.root, cycle_id="cycle-feedback-2", base_dir=self.tools_dir)
        second = {row["belief_id"]: row for row in list_memory(kind="beliefs", base_dir=self.tools_dir)}
        self.assertLess(second["repo-uses-nx"]["confidence"], first["repo-uses-nx"]["confidence"])
        self.assertEqual(
            second["repo-has-node-package-manifest"]["confidence"],
            first["repo-has-node-package-manifest"]["confidence"],
        )

    def test_feedback_note_substring_does_not_adjust_without_affected_belief_ids(self):
        register_tool(candidate_tool(), base_dir=self.tools_dir)
        run_cycle(workspace_root=self.root, cycle_id="cycle-feedback-note-1", base_dir=self.tools_dir, shadow_only=True)
        first = {row["belief_id"]: row for row in list_memory(kind="beliefs", base_dir=self.tools_dir)}
        record_operator_feedback(
            tool_id="operator",
            run_id="manual",
            finding_id="manual",
            verdict="false_positive",
            severity="critical",
            note="candidate:repo-shape should not be adjusted through note substring matching",
            affected_belief_ids=[],
            base_dir=self.tools_dir,
        )
        run_cycle(workspace_root=self.root, cycle_id="cycle-feedback-note-2", base_dir=self.tools_dir, shadow_only=True)
        second = {row["belief_id"]: row for row in list_memory(kind="beliefs", base_dir=self.tools_dir)}
        self.assertGreater(second["candidate:repo-shape"]["confidence"], first["candidate:repo-shape"]["confidence"])

    def test_missing_concrete_evidence_becomes_stale_after_three_cycles(self):
        run_cycle(workspace_root=self.root, cycle_id="cycle-stale-1", base_dir=self.tools_dir)
        (self.root / "nx.json").unlink()
        for index in range(2, 5):
            run_cycle(workspace_root=self.root, cycle_id=f"cycle-stale-{index}", base_dir=self.tools_dir)
        beliefs = {row["belief_id"]: row for row in list_memory(kind="beliefs", base_dir=self.tools_dir)}
        self.assertEqual(beliefs["repo-uses-nx"]["status"], "stale")
        self.assertEqual(beliefs["repo-uses-nx"]["needs_revalidation_cycles"], 3)

    def test_glob_evidence_zero_match_moves_to_revalidation(self):
        run_cycle(workspace_root=self.root, cycle_id="cycle-glob-1", base_dir=self.tools_dir)
        append_jsonl(
            self.tools_dir / "memory/beliefs.jsonl",
            {
                "schema_version": 1,
                "recorded_at": "2026-05-03T00:00:00+00:00",
                "updated_at": "2026-05-03T00:00:00+00:00",
                "belief_id": "glob-belief",
                "claim": "glob backed belief",
                "confidence": 0.7,
                "status": "supported",
                "evidence_refs": ["missing/**/*.ts"],
                "first_seen_cycle": "cycle-glob-1",
                "last_seen_cycle": "cycle-glob-1",
                "support_count": 1,
                "contradiction_count": 0,
                "needs_revalidation_cycles": 0,
                "source_tool_ids": [],
            },
        )
        run_cycle(workspace_root=self.root, cycle_id="cycle-glob-2", base_dir=self.tools_dir)
        beliefs = {row["belief_id"]: row for row in list_memory(kind="beliefs", base_dir=self.tools_dir)}
        self.assertEqual(beliefs["glob-belief"]["status"], "needs_revalidation")
        self.assertEqual(beliefs["glob-belief"]["evidence_state"]["empty_glob_refs"], ["missing/**/*.ts"])

    def test_memory_repeated_cycle_updates_latest_belief_state_without_duplicate_listing(self):
        run_cycle(workspace_root=self.root, cycle_id="cycle-memory-1", base_dir=self.tools_dir)
        run_cycle(workspace_root=self.root, cycle_id="cycle-memory-2", base_dir=self.tools_dir)
        beliefs = [row for row in list_memory(kind="beliefs", base_dir=self.tools_dir) if row["belief_id"] == "repo-uses-nx"]
        self.assertEqual(len(beliefs), 1)
        self.assertEqual(beliefs[0]["first_seen_cycle"], "cycle-memory-1")
        self.assertEqual(beliefs[0]["last_seen_cycle"], "cycle-memory-2")
        self.assertEqual(beliefs[0]["support_count"], 2)

    def test_memory_normalizes_v0_belief_rows(self):
        append_jsonl(
            self.tools_dir / "memory/beliefs.jsonl",
            {
                "schema_version": 1,
                "recorded_at": "2026-05-03T00:00:00+00:00",
                "cycle_id": "old-cycle",
                "belief_id": "legacy-belief",
                "claim": "legacy",
                "confidence": 0.7,
                "evidence": ["nx.json"],
            },
        )
        belief = list_memory(kind="beliefs", base_dir=self.tools_dir)[0]
        self.assertEqual(belief["evidence_refs"], ["nx.json"])
        self.assertEqual(belief["status"], "supported")

    def test_memory_rejects_self_output_evidence(self):
        with self.assertRaisesRegex(GovernanceError, "self-output"):
            validate_repo_evidence(["aria-tools/reports/daily/2026-05-03.md"])

    def test_adapter_belief_candidates_feed_memory_without_operator_emission(self):
        register_tool(candidate_tool(), base_dir=self.tools_dir)
        result = run_cycle(
            workspace_root=self.root,
            cycle_id="cycle-candidate",
            base_dir=self.tools_dir,
            shadow_only=True,
        )
        beliefs = {row["belief_id"]: row for row in list_memory(kind="beliefs", base_dir=self.tools_dir)}
        self.assertEqual(beliefs["candidate:repo-shape"]["source_tool_ids"], ["candidate-tool"])
        self.assertEqual(result["reflection"]["operator_facing_findings"], 0)

    def test_adapter_candidate_confidence_does_not_override_existing_memory_score(self):
        register_tool(candidate_tool(confidence=0.2), base_dir=self.tools_dir)
        run_cycle(workspace_root=self.root, cycle_id="cycle-candidate-score-1", base_dir=self.tools_dir, shadow_only=True)
        first = {row["belief_id"]: row for row in list_memory(kind="beliefs", base_dir=self.tools_dir)}
        register_tool(candidate_tool(confidence=1.0), base_dir=self.tools_dir)
        run_cycle(workspace_root=self.root, cycle_id="cycle-candidate-score-2", base_dir=self.tools_dir, shadow_only=True)
        second = {row["belief_id"]: row for row in list_memory(kind="beliefs", base_dir=self.tools_dir)}
        self.assertEqual(second["candidate:repo-shape"]["support_count"], 2)
        self.assertGreater(second["candidate:repo-shape"]["confidence"], first["candidate:repo-shape"]["confidence"])
        self.assertLess(second["candidate:repo-shape"]["confidence"], 0.5)

    def test_withdrawn_belief_is_sticky_against_candidate_recreation(self):
        register_tool(candidate_tool(), base_dir=self.tools_dir)
        run_cycle(workspace_root=self.root, cycle_id="cycle-withdraw-1", base_dir=self.tools_dir, shadow_only=True)
        withdraw_belief(belief_id="candidate:repo-shape", reason="operator rejected", base_dir=self.tools_dir)
        run_cycle(workspace_root=self.root, cycle_id="cycle-withdraw-2", base_dir=self.tools_dir, shadow_only=True)
        beliefs = {row["belief_id"]: row for row in list_memory(kind="beliefs", base_dir=self.tools_dir)}
        self.assertEqual(beliefs["candidate:repo-shape"]["status"], "withdrawn")
        contradictions = list_memory(kind="contradictions", base_dir=self.tools_dir)
        self.assertTrue(any(row["belief_id"] == "candidate:repo-shape" for row in contradictions))

    def test_quarantined_adapter_source_propagates_to_memory_without_reopening_withdrawn(self):
        tool = candidate_tool()
        tool["status"] = "QUARANTINED"
        register_active_for_test(tool, base_dir=self.tools_dir)
        for belief_id, status, revalidation_cycles in (
            ("adapter:supported", "supported", 0),
            ("adapter:withdrawn", "withdrawn", 0),
            ("adapter:stale", "stale", 3),
        ):
            append_jsonl(
                self.tools_dir / "memory/beliefs.jsonl",
                {
                    "schema_version": 1,
                    "recorded_at": "2026-05-03T00:00:00+00:00",
                    "updated_at": "2026-05-03T00:00:00+00:00",
                    "belief_id": belief_id,
                    "claim": f"{belief_id} claim",
                    "confidence": 0.7,
                    "status": status,
                    "evidence_refs": ["src/app.ts"],
                    "first_seen_cycle": "cycle-quarantine-0",
                    "last_seen_cycle": "cycle-quarantine-0",
                    "support_count": 1,
                    "contradiction_count": 0,
                    "needs_revalidation_cycles": revalidation_cycles,
                    "source_tool_ids": ["candidate-tool"],
                },
            )
        append_jsonl(
            self.tools_dir / "runs.jsonl",
            {
                "schema_version": 1,
                "recorded_at": "2026-05-03T00:00:00+00:00",
                "run_id": "manual-quarantined-run",
                "tool_id": "candidate-tool",
                "cycle_id": "cycle-quarantine-1",
                "status": "ok",
                "memory_candidates": [
                    {
                        "belief_id": "adapter:new",
                        "claim": "new quarantined candidate",
                        "confidence": 0.9,
                        "evidence_refs": ["src/app.ts"],
                        "source_tool_id": "candidate-tool",
                    },
                ],
            },
        )
        update_memory(cycle_id="cycle-quarantine-1", base_dir=self.tools_dir, include_discovery_beliefs=False)
        beliefs = {row["belief_id"]: row for row in list_memory(kind="beliefs", base_dir=self.tools_dir)}
        self.assertEqual(beliefs["adapter:supported"]["status"], "needs_revalidation")
        self.assertEqual(beliefs["adapter:supported"]["quarantined_source_tool_ids"], ["candidate-tool"])
        self.assertEqual(beliefs["adapter:withdrawn"]["status"], "withdrawn")
        self.assertEqual(beliefs["adapter:stale"]["status"], "stale")
        self.assertEqual(beliefs["adapter:stale"]["needs_revalidation_cycles"], 4)
        self.assertNotIn("adapter:new", beliefs)
        uncertainties = list_memory(kind="uncertainties", base_dir=self.tools_dir)
        self.assertTrue(any(row["belief_id"] == "adapter:new" for row in uncertainties))
        calibration = list_memory(kind="calibration", base_dir=self.tools_dir)
        self.assertTrue(any(row["belief_id"] == "adapter:new" for row in calibration))

    def test_self_output_evidence_quarantines_tool_in_full_cycle(self):
        register_tool(self_output_tool(), base_dir=self.tools_dir)
        run_cycle(
            workspace_root=self.root,
            cycle_id="cycle-self-output",
            base_dir=self.tools_dir,
            shadow_only=True,
        )
        self.assertEqual(self.latest_run()["status"], "evidence_error")
        self.assertTrue(verify_integrity(base_dir=self.tools_dir)["valid"])

    def test_cycle_diff_records_changed_paths_between_discovery_runs(self):
        run_discovery(workspace_root=self.root, cycle_id="cycle-diff-1", base_dir=self.tools_dir)
        first = run_cycle_diff(cycle_id="cycle-diff-1", base_dir=self.tools_dir)
        self.assertTrue(first["baseline"])
        (self.root / "src/app.ts").write_text("export const app = false;\n", encoding="utf-8")
        run_discovery(workspace_root=self.root, cycle_id="cycle-diff-2", base_dir=self.tools_dir)
        second = run_cycle_diff(cycle_id="cycle-diff-2", base_dir=self.tools_dir)
        self.assertFalse(second["baseline"])
        self.assertEqual(second["summary"]["changed_count"], 1)
        self.assertIn("file_counts", second["summary"])
        self.assertIn("file_counts", second["fingerprint_delta"])
        self.assertEqual(second["changed_paths"], ["src/app.ts"])

    def test_cycle_diff_reads_legacy_previous_artifact_shape(self):
        legacy_dir = self.tools_dir / "discovery/cycle-legacy"
        legacy_dir.mkdir(parents=True)
        (legacy_dir / "FATES.json").write_text(
            json.dumps({"schema_version": 1, "cycle_id": "cycle-legacy", "files": [{"path": "src/app.ts", "content_hash": "old"}]}),
            encoding="utf-8",
        )
        (legacy_dir / "REPO_FINGERPRINT.json").write_text(
            json.dumps({"schema_version": 1, "tracked_file_count": 1, "service_count": 0}),
            encoding="utf-8",
        )
        run_discovery(workspace_root=self.root, cycle_id="cycle-new", base_dir=self.tools_dir)
        diff = run_cycle_diff(cycle_id="cycle-new", base_dir=self.tools_dir)
        self.assertEqual(diff["previous_cycle_id"], "cycle-legacy")
        self.assertIn("file_counts", diff["summary"])
        self.assertIn("file_counts_delta", diff)

    def test_integrity_detects_tampered_ledger(self):
        run_cycle(workspace_root=self.root, cycle_id="cycle-integrity", base_dir=self.tools_dir, discovery_only=True)
        self.assertTrue(verify_integrity(base_dir=self.tools_dir)["valid"])
        cycles = self.tools_dir / "cycles.jsonl"
        cycles.write_text(cycles.read_text(encoding="utf-8").replace("started", "changed", 1), encoding="utf-8")
        self.assertFalse(verify_integrity(base_dir=self.tools_dir)["valid"])

    def test_proposal_and_research_ledgers_validate_minimum_contracts(self):
        proposal = record_proposal(
            kind="architecture",
            title="Fixture proposal",
            problem="Fixture problem",
            evidence=["src/app.ts"],
            validation_command="python3 -m unittest discover aria-kernel -p '*test*.py'",
            base_dir=self.tools_dir,
        )
        self.assertEqual(proposal["kind"], "architecture")
        source = record_research_source(
            url="https://owasp.org/example",
            source_tier="official",
            content_hash="sha256:" + "0" * 64,
            base_dir=self.tools_dir,
        )
        self.assertEqual(source["source_tier"], "official")
        with self.assertRaises(GovernanceError):
            record_proposal(
                kind="self_change",
                title="No evidence",
                problem="Missing evidence",
                evidence=[],
                validation_command="true",
                base_dir=self.tools_dir,
            )

    def test_cli_exposes_cycle_and_integrity_commands(self):
        with redirect_stdout(StringIO()):
            code = main(
                [
                    "--tools-dir",
                    str(self.tools_dir),
                "cycle",
                "run",
                    "--workspace-root",
                    str(self.root),
                    "--cycle-id",
                    "cycle-cli",
                    "--discovery-only",
                ],
            )
            integrity_code = main(["--tools-dir", str(self.tools_dir), "integrity", "verify"])
        self.assertEqual(code, 0)
        self.assertEqual(integrity_code, 0)

    def test_output_contract_compat_alias_version_gate(self):
        pyproject = tomllib.loads((Path(__file__).parents[1] / "pyproject.toml").read_text(encoding="utf-8"))
        current_version = _version_tuple(pyproject["project"]["version"])
        removal_version = _version_tuple(OUTPUT_CONTRACT_COMPAT_REMOVAL_VERSION)
        self.assertLess(
            current_version,
            removal_version,
            f"{OUTPUT_CONTRACT_COMPAT_FINDING_ID} violation: {current_version} >= {OUTPUT_CONTRACT_COMPAT_REMOVAL_VERSION}; compat aliases must be removed",
        )

    def test_output_contract_compat_finding_is_registered(self):
        registry = Path(__file__).parents[2] / "docs/reviews/_registry/findings.jsonl"
        rows = [json.loads(line) for line in registry.read_text(encoding="utf-8").splitlines() if line.strip()]
        finding = next(row for row in rows if row["id"] == OUTPUT_CONTRACT_COMPAT_FINDING_ID)
        self.assertEqual(finding["state"], "OPEN")
        self.assertEqual(finding["deadline"], "2026-06-05")
        self.assertEqual(finding["owner_agent"], "platform-kernel-expert")
        self.assertEqual(finding["severity"], "MEDIUM")

    def test_cli_exposes_memory_withdraw_and_pressure_explain(self):
        migration_dir = self.root / "apps/farm-service/src/database/migrations"
        migration_dir.mkdir(parents=True)
        for index in range(5):
            (migration_dir / f"178800000000{index}-Example.ts").write_text("export class M{}\n", encoding="utf-8")
        run_cycle(workspace_root=self.root, cycle_id="cycle-cli-explain", base_dir=self.tools_dir)
        pressure = run_pressure(cycle_id="cycle-cli-explain", base_dir=self.tools_dir)["pressures"][0]
        with redirect_stdout(StringIO()):
            withdraw_code = main(
                [
                    "--tools-dir",
                    str(self.tools_dir),
                    "memory",
                    "withdraw",
                    "--belief-id",
                    "repo-uses-nx",
                    "--reason",
                    "operator test",
                ],
            )
            explain_code = main(
                [
                    "--tools-dir",
                    str(self.tools_dir),
                    "pressure",
                    "explain",
                    "--cycle-id",
                    "cycle-cli-explain",
                    "--pressure-id",
                    pressure["pressure_id"],
                ],
            )
        self.assertEqual(withdraw_code, 0)
        self.assertEqual(explain_code, 0)
        beliefs = {row["belief_id"]: row for row in list_memory(kind="beliefs", base_dir=self.tools_dir)}
        self.assertEqual(beliefs["repo-uses-nx"]["status"], "withdrawn")

    def latest_run(self):
        rows = (self.tools_dir / "runs.jsonl").read_text(encoding="utf-8").strip().splitlines()
        return json.loads(rows[-1])


def _version_tuple(value: str) -> tuple[int, ...]:
    return tuple(int(part) for part in value.split("."))


if __name__ == "__main__":
    unittest.main()
