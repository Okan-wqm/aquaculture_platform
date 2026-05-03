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
    verify_integrity,
)
from aria_kernel.cli import main
from aria_kernel.ledger import append_jsonl
from aria_kernel.memory import list_memory, validate_repo_evidence
from aria_kernel.pressure import run_pressure
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

    def test_memory_belief_uses_repo_evidence_not_self_output(self):
        run_cycle(workspace_root=self.root, cycle_id="cycle-memory", base_dir=self.tools_dir, discovery_only=False)
        beliefs = list_memory(kind="beliefs", base_dir=self.tools_dir)
        self.assertTrue(any(row.get("belief_id") == "repo-uses-nx" for row in beliefs))
        self.assertTrue(all("aria-tools/" not in str(row.get("evidence_refs", [])) for row in beliefs))

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

    def latest_run(self):
        rows = (self.tools_dir / "runs.jsonl").read_text(encoding="utf-8").strip().splitlines()
        return json.loads(rows[-1])


if __name__ == "__main__":
    unittest.main()
