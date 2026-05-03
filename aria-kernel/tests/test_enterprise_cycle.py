from __future__ import annotations

import json
import sys
import tempfile
import unittest
from contextlib import redirect_stdout
from io import StringIO
from pathlib import Path

from aria_kernel import (
    record_proposal,
    record_research_source,
    register_tool,
    run_cycle,
    run_cycle_diff,
    run_discovery,
    update_memory,
    verify_integrity,
    withdraw_belief,
)
from aria_kernel.cli import main
from aria_kernel.feedback_store import record_operator_feedback
from aria_kernel.ledger import append_jsonl
from aria_kernel.memory import list_memory, validate_repo_evidence
from aria_kernel.pressure import explain_pressure, run_pressure
from aria_kernel.tool_registry import GovernanceError


def fake_tool_argv(output):
    return [sys.executable, "-c", f"import json; print({json.dumps(json.dumps(output))})"]


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

    def test_discovery_writes_fates_and_completion_proof(self):
        result = run_discovery(workspace_root=self.root, cycle_id="cycle-1", base_dir=self.tools_dir)
        self.assertTrue(result["completion_proof"]["complete"])
        paths = {row["path"] for row in result["fates"]}
        self.assertIn("src/app.ts", paths)
        self.assertTrue((self.tools_dir / "discovery/cycle-1/FATES.json").exists())

    def test_full_shadow_cycle_runs_engines_and_suppresses_operator_emission(self):
        register_tool(shadow_tool(), base_dir=self.tools_dir)
        result = run_cycle(
            workspace_root=self.root,
            cycle_id="cycle-shadow",
            base_dir=self.tools_dir,
            shadow_only=True,
        )
        self.assertEqual(result["status"], "completed")
        self.assertEqual(result["reflection"]["tool_run_count"], 1)
        run = self.latest_run()
        self.assertEqual(run["status"], "ok")
        self.assertEqual(run["emitted_findings"], [])
        self.assertGreater(run["runner"]["raw_findings_count"], 0)
        self.assertTrue((self.tools_dir / "reports/daily").exists())
        report = next((self.tools_dir / "reports/daily").glob("*.md")).read_text(encoding="utf-8")
        for heading in (
            "## Coverage",
            "## Beliefs",
            "## Stale / Revalidation",
            "## Top Pressures",
            "## Tool Health",
            "## Next Cycle Plan",
        ):
            self.assertIn(heading, report)
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
        register_tool(tool, base_dir=self.tools_dir)
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
        self.assertEqual(second["changed_paths"], ["src/app.ts"])

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


if __name__ == "__main__":
    unittest.main()
