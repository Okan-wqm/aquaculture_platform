from __future__ import annotations

import argparse
import json
import subprocess
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
from datetime import datetime, timezone
from io import StringIO
from pathlib import Path

from aria_kernel.cli import main
from aria_kernel.cycle import run_cycle
from aria_kernel.feedback import add_feedback, build_feedback_event, load_failure_modes, normalize_feedback_event, validate_failure_mode
from aria_kernel.integrity import verify_integrity
from aria_kernel.ledger import append_jsonl, load_index, read_jsonl
from aria_kernel.memory import list_memory, withdraw_belief
from aria_kernel.migration import migrate_tools_v1_to_v2, migrate_workspace_v1_to_v2, rollback_tools_v2_to_v1, rollback_workspace_v2_to_v1
from aria_kernel.pressure import list_workspace_pressures
from aria_kernel.tool_registry import GovernanceError, ensure_tools_dir
from aria_kernel.workspace import ensure_workspace, workspace_paths
from tests._helpers.declared_fixtures import append_declared_fixture


class V13ContractTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.base = Path(self.tmp.name)
        self.repo = self.base / "repo"
        self.repo.mkdir()
        self._init_git(self.repo)

    def tearDown(self):
        self.tmp.cleanup()

    def test_tools_v0_root_with_ledgers_migrates_and_rolls_back_with_audit(self):
        tools = self.base / "aria-tools"
        tools.mkdir()
        append_jsonl(tools / "runs.jsonl", {"schema_version": 1, "run_id": "run-1", "cycle_id": "cycle-1"}, test_fixture=True)

        with self.assertRaisesRegex(GovernanceError, "ambiguous_tools_root"):
            ensure_tools_dir(tools)

        result = migrate_tools_v1_to_v2(
            tools_dir=tools,
            workspace_root=self.repo,
            acknowledge=True,
            reason="operator migration",
        )

        self.assertEqual(result["phase"], "finalized")
        backup = Path(result["backup_path"])
        self.assertTrue(backup.exists())
        self.assertTrue((tools / "repo_identity.json").exists())
        workspace_base = self.base / "integrity-workspaces"
        self.assertTrue(verify_integrity(workspace_root=self.repo, workspace_base=workspace_base, tools_dir=tools)["valid"])

        governance = read_jsonl(tools / "governance.jsonl")
        kinds = [row["kind"] for row in governance]
        self.assertIn("migration_started", kinds)
        self.assertGreaterEqual(kinds.count("migration_phase"), 4)
        self.assertIn("migration_completed", kinds)
        self.assertEqual(governance[-1]["kind"], "migration_completed")

        state = json.loads((tools / "migration_state.json").read_text(encoding="utf-8"))
        state["phase"] = "tampered"
        (tools / "migration_state.json").write_text(json.dumps(state, sort_keys=True) + "\n", encoding="utf-8")
        self.assertFalse(verify_integrity(workspace_root=self.repo, workspace_base=workspace_base, tools_dir=tools)["valid"])

        # restore valid state before rollback
        result = migrate_tools_v1_to_v2(
            tools_dir=tools,
            workspace_root=self.repo,
            acknowledge=True,
            reason="rerun after finalized",
        )
        self.assertEqual(result["phase"], "finalized")
        rollback = rollback_tools_v2_to_v1(
            tools_dir=tools,
            from_backup=backup,
            acknowledge=True,
            reason="operator rollback",
            force_discard_since_migration=True,
        )
        self.assertEqual(rollback["rollback"], "tools_v2_to_v1")
        rollback_kinds = [row["kind"] for row in read_jsonl(tools / "governance.jsonl")]
        self.assertEqual(rollback_kinds[-3:], ["rollback_started", "rollback_phase", "rollback_completed"])
        self.assertTrue((tools / "since_migration_events.jsonl").exists())
        index = load_index(tools / "integrity_index.json")
        self.assertIn("since_migration_events.jsonl", index.get("file_hashes", {}))
        self.assertGreaterEqual(read_jsonl(tools / "governance.jsonl")[-1]["details"]["discarded_event_count"], 0)

    def test_v1_identity_with_covered_ledgers_runs_standard_migration(self):
        tools = self.base / "v1-tools"
        tools.mkdir()
        (tools / "repo_identity.json").write_text('{"schema_version":1,"aria_tools_contract_version":1}\n', encoding="utf-8")
        append_jsonl(tools / "runs.jsonl", {"schema_version": 1, "run_id": "run-1", "cycle_id": "cycle-1"}, test_fixture=True)

        result = migrate_tools_v1_to_v2(
            tools_dir=tools,
            workspace_root=self.repo,
            acknowledge=True,
            reason="standard migration",
        )

        self.assertEqual(result["phase"], "finalized")
        governance = read_jsonl(tools / "governance.jsonl")
        self.assertEqual(governance[0]["kind"], "migration_started")
        self.assertEqual(governance[-1]["kind"], "migration_completed")
        self.assertEqual(governance[0]["details"]["source_state"], "tools_v1")

    def test_v2_with_unfinished_migration_state_resumes_instead_of_noop(self):
        tools = self.base / "mixed-tools"
        tools.mkdir()
        append_jsonl(tools / "runs.jsonl", {"schema_version": 1, "run_id": "run-1", "cycle_id": "cycle-1"}, test_fixture=True)
        first = migrate_tools_v1_to_v2(
            tools_dir=tools,
            workspace_root=self.repo,
            acknowledge=True,
            reason="initial migration",
        )
        state = json.loads((tools / "migration_state.json").read_text(encoding="utf-8"))
        state["phase"] = "copied"
        state["phases"] = ["started", "copied"]
        (tools / "migration_state.json").write_text(json.dumps(state, sort_keys=True) + "\n", encoding="utf-8")

        resumed = migrate_tools_v1_to_v2(
            tools_dir=tools,
            workspace_root=self.repo,
            acknowledge=True,
            reason="resume mixed state",
        )

        self.assertEqual(resumed["phase"], "finalized")
        self.assertEqual(resumed["backup_path"], first["backup_path"])

    def test_v1_identity_without_ledgers_finalizes_empty_migration_and_v2_is_noop(self):
        tools = self.base / "empty-tools"
        tools.mkdir()
        (tools / "repo_identity.json").write_text('{"schema_version":1,"aria_tools_contract_version":1}\n', encoding="utf-8")

        migrated = migrate_tools_v1_to_v2(
            tools_dir=tools,
            workspace_root=self.repo,
            acknowledge=True,
            reason="empty migration",
        )
        self.assertEqual(migrated["phase"], "finalized")
        completed = [row for row in read_jsonl(tools / "governance.jsonl") if row["kind"] == "migration_completed"][-1]
        self.assertTrue(completed["details"]["empty_v0_state"])

        rerun = migrate_tools_v1_to_v2(
            tools_dir=tools,
            workspace_root=self.repo,
            acknowledge=True,
            reason="noop",
        )
        self.assertEqual(rerun["status"], "already_v2")

    def test_identityless_tools_root_without_ledgers_uses_auto_bootstrap(self):
        tools = self.base / "fresh-tools"
        result = migrate_tools_v1_to_v2(
            tools_dir=tools,
            workspace_root=self.repo,
            acknowledge=True,
            reason="fresh bootstrap",
        )

        self.assertEqual(result["status"], "auto_bootstrapped")
        self.assertFalse((tools / "migration_state.json").exists())
        self.assertEqual([row["kind"] for row in read_jsonl(tools / "governance.jsonl")], ["tools_root_bootstrapped"])

    def test_cli_exit_codes_for_binding_and_repo_resolution(self):
        invalid = self.base / "not-a-repo"
        invalid.mkdir()
        stderr = StringIO()
        # Plan ARIA-V2 I-31 — --reason must be ≥10 non-whitespace chars
        # (audit trail discipline). Original test used "bad root" (8
        # chars) which is now rejected at parse time. Using a longer
        # reason that still triggers the downstream repo_resolution_failed
        # check exercises the exit code path the test was validating.
        with redirect_stderr(stderr):
            code = main(
                [
                    "integrity",
                    "migrate-tools-v1-to-v2",
                    "--tools-dir",
                    str(self.base / "tools-invalid"),
                    "--workspace-root",
                    str(invalid),
                    "--acknowledge",
                    "--reason",
                    "bad-root regression test fixture",
                ],
            )
        self.assertEqual(code, 14)
        self.assertIn("repo_resolution_failed", stderr.getvalue())

    def test_workspace_cycle_schema_v2_and_pressure_keys_removed(self):
        workspace_base = self.base / "workspaces"
        paths = workspace_paths(self.repo, workspace_base)
        ensure_workspace(paths)
        state = run_cycle(paths)
        self.assertEqual(state["schema_version"], 2)
        self.assertNotIn("pressure_keys_emitted", load_index(paths.feedback_index))

    def test_workspace_migration_drops_legacy_pressure_keys(self):
        workspace_base = self.base / "legacy-workspaces"
        paths = workspace_paths(self.repo, workspace_base)
        paths.memory_dir.mkdir(parents=True)
        paths.state_dir.mkdir(parents=True)
        for path in paths.ledgers.values():
            path.parent.mkdir(parents=True, exist_ok=True)
            path.touch()
        paths.feedback_index.write_text(
            json.dumps({"schema_version": 1, "ledger_hashes": {}, "pressure_keys_emitted": ["legacy"]}) + "\n",
            encoding="utf-8",
        )
        migrated = migrate_workspace_v1_to_v2(
            workspace_root=self.repo,
            workspace_base=workspace_base,
            acknowledge=True,
            reason="workspace migration",
        )
        self.assertEqual(migrated["migration"], "workspace_v1_to_v2")
        self.assertNotIn("pressure_keys_emitted", load_index(paths.feedback_index))
        completed = [row for row in read_jsonl(paths.ledgers["governance"]) if row["kind"] == "migration_completed"][-1]
        self.assertEqual(completed["details"]["dropped_legacy_field"], "pressure_keys_emitted")

    def test_workspace_rollback_force_discard_writes_audit_and_since_ledger(self):
        workspace_base = self.base / "rollback-workspaces"
        paths = workspace_paths(self.repo, workspace_base)
        paths.memory_dir.mkdir(parents=True)
        paths.state_dir.mkdir(parents=True)
        for path in paths.ledgers.values():
            path.parent.mkdir(parents=True, exist_ok=True)
            path.touch()
        paths.feedback_index.write_text(json.dumps({"schema_version": 1, "ledger_hashes": {}}) + "\n", encoding="utf-8")
        migrated = migrate_workspace_v1_to_v2(
            workspace_root=self.repo,
            workspace_base=workspace_base,
            acknowledge=True,
            reason="workspace migration",
        )
        append_declared_fixture(
            paths.ledgers["missed_signals"],
            normalize_feedback_event({"kind": "missed_signal", "refs": ["apps/api/src/app.ts:1"], "summary": "post"}),
            expected_surface="workspace_memory_missed_signals",
        )

        rollback = rollback_workspace_v2_to_v1(
            workspace_root=self.repo,
            workspace_base=workspace_base,
            from_backup=migrated["backup_path"],
            acknowledge=True,
            reason="workspace rollback",
            force_discard_since_migration=True,
        )

        self.assertEqual(rollback["rollback"], "workspace_v2_to_v1")
        paths = workspace_paths(self.repo, workspace_base)
        governance = read_jsonl(paths.ledgers["governance"])
        self.assertEqual([row["kind"] for row in governance[-3:]], ["rollback_started", "rollback_phase", "rollback_completed"])
        self.assertGreater(governance[-1]["details"]["discarded_event_count"], 0)
        self.assertGreater(len(read_jsonl(paths.ledgers["since_migration_events"])), 0)

    def test_vocabulary_defaults_and_legacy_override(self):
        modes = load_failure_modes()
        self.assertIn("adapter_missing", modes)
        self.assertNotIn("unknown_capability", modes)

        event = build_feedback_event(self._args(kind="unknown_capability", ref="libs/backend-common/src/foo.ts:1"))
        self.assertEqual(event["failure_mode"], "adapter_missing")
        self.assertTrue(event["capability_gap_key"].startswith("shared_lib:adapter_missing:"))

        with self.assertRaisesRegex(ValueError, "tenant_isolation_bypass"):
            validate_failure_mode("tenant_repo_bypass")

        workspace_base = self.base / "vocab-workspaces"
        paths = workspace_paths(self.repo, workspace_base)
        ensure_workspace(paths)
        initial_governance = read_jsonl(paths.ledgers["governance"])
        vocabulary_events = [row for row in initial_governance if row["kind"] == "vocabulary_loaded"]
        self.assertEqual(len(vocabulary_events), 1)
        self.assertEqual(
            sorted(vocabulary_events[0]["details"]),
            ["default_count", "legacy_schema_detected", "override_count", "override_hash", "schema", "source"],
        )
        self.assertEqual(load_index(paths.feedback_index)["failure_mode_vocabulary_loaded"], vocabulary_events[0]["details"])
        self.assertIn("adapter_missing", load_failure_modes(paths))
        self.assertEqual(len([row for row in read_jsonl(paths.ledgers["governance"]) if row["kind"] == "vocabulary_loaded"]), 1)

        override = paths.workspace_root / "aria-config" / "failure_mode_vocabulary.json"
        override.parent.mkdir(parents=True)
        override.write_text(
            json.dumps(
                {
                    "$schema": "aria/failure-mode-vocab/v2",
                    "modes": [{"id": "missed_signal"}, {"id": "custom_mode"}],
                },
            )
            + "\n",
            encoding="utf-8",
        )
        self.assertIn("custom_mode", load_failure_modes(paths))
        self.assertNotIn("missed_signal", load_failure_modes(paths))
        governance = read_jsonl(paths.ledgers["governance"])
        self.assertEqual(governance[-1]["kind"], "vocabulary_loaded")
        self.assertEqual(governance[-1]["details"]["source"], "legacy-v2-tolerated")
        self.assertTrue(governance[-1]["details"]["legacy_schema_detected"])
        self.assertEqual(len([row for row in governance if row["kind"] == "vocabulary_loaded"]), 2)

    def test_cycle_records_git_head_sha_at_cycle(self):
        tools_dir = self.base / "head-tools"
        workspace_base = self.base / "head-workspaces"
        expected = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=self.repo, text=True).strip()

        result = run_cycle(
            workspace_root=self.repo,
            workspace_base=workspace_base,
            cycle_id="cyc-20260506T000000Z",
            base_dir=tools_dir,
            discovery_only=True,
        )

        self.assertEqual(result["git_head_sha_at_cycle"], expected)
        self.assertEqual(result["event"]["git_head_sha_at_cycle"], expected)
        completed = [row for row in read_jsonl(tools_dir / "cycles.jsonl") if row.get("event") == "completed"][-1]
        self.assertEqual(completed["git_head_sha_at_cycle"], expected)
        artifact = json.loads(
            (workspace_paths(self.repo, workspace_base).cycle_dir / "cyc-20260506T000000Z.json").read_text(encoding="utf-8"),
        )
        self.assertEqual(artifact["git_head_sha_at_cycle"], expected)

    def test_vocabulary_normalization_drift_is_audited_without_rewriting_old_rows(self):
        workspace_base = self.base / "drift-workspaces"
        paths = workspace_paths(self.repo, workspace_base)
        ensure_workspace(paths)
        old = normalize_feedback_event(
            {
                "kind": "missed_signal",
                "source": "operator",
                "refs": ["libs/backend-common/src/foo.ts:1"],
                "summary": "old bucket",
                "capability_gap_key": "repo:scope_violation:ts",
            },
        )
        append_declared_fixture(
            paths.ledgers["missed_signals"],
            old,
            expected_surface="workspace_memory_missed_signals",
        )

        event = build_feedback_event(self._args(kind="missed_signal", ref="libs/backend-common/src/foo.ts:1"), paths=paths)
        add_feedback(paths, event)

        self.assertEqual(read_jsonl(paths.ledgers["missed_signals"])[0]["capability_gap_key"], "repo:scope_violation:ts")
        drift_events = [row for row in read_jsonl(paths.ledgers["governance"]) if row["kind"] == "vocabulary_normalization_drift"]
        self.assertEqual(drift_events[-1]["details"]["drift_count"], 1)

    def test_existing_capability_gap_keys_are_immutable(self):
        old = {
            "kind": "closed_signal",
            "source": "operator",
            "refs": ["libs/backend-common/src/foo.ts:1"],
            "summary": "closed under old key",
            "capability_gap_key": "repo:scope_violation:ts",
            "evidence_refs": ["manual:closed"],
        }
        normalized = normalize_feedback_event(old)
        self.assertEqual(normalized["capability_gap_key"], "repo:scope_violation:ts")
        self.assertEqual(normalized["failure_mode"], "scope_violation")

    def test_pressure_list_workspace_base_isolation_and_memory_tools_isolation(self):
        base_a = self.base / "workspace-a"
        base_b = self.base / "workspace-b"
        paths_a = workspace_paths(self.repo, base_a)
        paths_b = workspace_paths(self.repo, base_b)
        ensure_workspace(paths_a)
        ensure_workspace(paths_b)
        append_declared_fixture(
            paths_a.ledgers["pressure"],
            self._pressure("PE-a"),
            expected_surface="workspace_memory_pressure",
        )

        self.assertEqual([row["event_id"] for row in list_workspace_pressures(paths_a)], ["PE-a"])
        self.assertEqual(list_workspace_pressures(paths_b), [])

        tools_a = self.base / "tools-a"
        tools_b = self.base / "tools-b"
        ensure_tools_dir(tools_a)
        ensure_tools_dir(tools_b)
        append_declared_fixture(
            tools_a / "memory" / "beliefs.jsonl",
            {"belief_id": "belief-1", "status": "active", "schema_version": 1},
            expected_surface="memory_beliefs",
        )
        append_declared_fixture(
            tools_b / "memory" / "beliefs.jsonl",
            {"belief_id": "belief-1", "status": "active", "schema_version": 1},
            expected_surface="memory_beliefs",
        )
        withdraw_belief(belief_id="belief-1", reason="operator rejected", base_dir=tools_a)
        self.assertEqual(list_memory(kind="beliefs", base_dir=tools_a)[0]["status"], "withdrawn")
        self.assertEqual(list_memory(kind="beliefs", base_dir=tools_b)[0]["status"], "active")

    def test_ci_workflow_uses_isolated_tools_bootstrap(self):
        # ORPHAN-MEDIUM-769 — aria-kernel-full.yml was deleted (a strict
        # subset of this lane); the bootstrap-isolation contract lives on
        # aria-kernel.yml alone.
        workflow = (Path(__file__).parents[2] / ".github/workflows/aria-kernel.yml").read_text(encoding="utf-8")
        self.assertIn("rm -rf ./.aria-ci/tools ./.aria-ci/workspaces", workflow)
        self.assertIn("mkdir -p ./.aria-ci", workflow)
        # Plan ARIA-V2 §3.8 renamed the CI migration call from
        # ``migrate-tools-v1-to-v2`` to the idempotent umbrella
        # ``migrate-tools-bootstrap`` so the workflow handles any
        # starting contract version (v0/v1/v2) and chains forward
        # to v3 without operator intervention.
        self.assertIn("integrity migrate-tools-bootstrap --tools-dir ./.aria-ci/tools", workflow)
        self.assertIn("discovery run --workspace-root . --workspace-base ./.aria-ci/workspaces --tools-dir ./.aria-ci/tools", workflow)
        self.assertNotIn("--tools-dir ./aria-tools --cycle-id ci-", workflow)

    def _args(self, **overrides):
        defaults = {
            "kind": "missed_signal",
            "summary": "summary",
            "ref": "apps/api/src/app.ts",
            "concept": "concept",
            "source": "operator",
            "surface": None,
            "failure_mode": None,
            "parser_kind": None,
            "capability_gap_key": None,
            "evidence_ref": [],
        }
        defaults.update(overrides)
        return argparse.Namespace(**defaults)

    def _pressure(self, event_id: str):
        return {
            "$schema": "aria/pressure-event/v2",
            "event_id": event_id,
            "primitive": "UNKNOWN",
            "subtype": "fixture",
            "capability_gap_key": "backend:evidence_gap:ts",
            "evidence_fingerprint": f"sha256:{event_id}",
            "feedback_event_ids": [],
            # Wall-clock-relative, NOT a literal date: list_workspace_pressures
            # reads with the real clock, and a fixed detected_at crosses the
            # 90-day decay threshold and vanishes from the active listing
            # (fired on 2026-08-03, exactly 90 days after the old literal).
            "detected_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "schema_version": 2,
        }

    def _init_git(self, path: Path) -> None:
        subprocess.run(["git", "init"], cwd=path, check=True, capture_output=True)
        subprocess.run(["git", "config", "user.email", "aria@example.invalid"], cwd=path, check=True)
        subprocess.run(["git", "config", "user.name", "ARIA"], cwd=path, check=True)
        (path / "README.md").write_text("fixture\n", encoding="utf-8")
        subprocess.run(["git", "add", "README.md"], cwd=path, check=True)
        subprocess.run(["git", "commit", "-m", "init"], cwd=path, check=True, capture_output=True)


if __name__ == "__main__":
    unittest.main()
