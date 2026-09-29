from __future__ import annotations

import json
import importlib.util
import copy
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from aria_kernel import ledger as ledger_module
from aria_kernel import secure_artifact_io as secure_artifact_io_module
from aria_kernel.burn_in import (
    DISALLOWED_OBSERVE_SURFACES,
    _disallowed_snapshot,
    _diff_snapshots,
    _cycle_ledger_summary,
    _cycle_validity,
    _require_clean_worktree,
    burn_in_report_schema,
    run_observe_burn_in,
    validate_burn_in_report,
    verify_burn_in_artifact_bundle,
)
from aria_kernel.ledger import append_jsonl, read_jsonl
from aria_kernel import state_store
from aria_kernel.state_store import (
    BOOTSTRAP_ACK_ENV,
    build_publishable_snapshot,
    checkout_state_store,
    publish_state,
    tools_root,
)
from aria_kernel.tool_registry import GovernanceError, ensure_tools_dir
from aria_kernel.workspace import canonical_identity
from aria_kernel.worktree import is_runtime_path as worktree_is_runtime_path
from tests._helpers.declared_fixtures import append_declared_fixture


_helpers_path = Path(__file__).parent / "_helpers" / "git_fixtures.py"
_spec = importlib.util.spec_from_file_location("aria_kernel_test_helpers_git_fixtures_burn_in", _helpers_path)
git_fixtures = importlib.util.module_from_spec(_spec)
sys.modules["aria_kernel_test_helpers_git_fixtures_burn_in"] = git_fixtures
_spec.loader.exec_module(git_fixtures)


class ObserveBurnInTests(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory(prefix="aria-burn-in-")
        self.tmp = Path(self._tmp.name)
        self.remote = self.tmp / "remote.git"
        subprocess.run(
            ["git", "init", "--bare", "--initial-branch=main", str(self.remote)],
            check=True,
            capture_output=True,
        )
        self.repo = git_fixtures.make_repo_with_initial_commit(
            self.tmp,
            {
                "package.json": "{\"scripts\":{}}\n",
                "apps/api/src/main.ts": "export const api = true;\n",
                "docs/adr/001-seed.md": "# Seed\n",
            },
            name="repo",
            remote_url=str(self.remote),
        )
        (self.repo / ".gitignore").write_text(
            ".aria-state-store/\n.aria-state-store.writers.jsonl\n",
            encoding="utf-8",
        )
        subprocess.run(["git", "add", ".gitignore"], cwd=self.repo, check=True)
        subprocess.run(
            ["git", "commit", "-q", "-m", "fixture: ignore restored state"],
            cwd=self.repo,
            check=True,
        )
        subprocess.run(
            ["git", "push", "-q", "origin", "HEAD:main"],
            cwd=self.repo,
            check=True,
        )
        identity = state_store._repository_identity(self.repo)
        with patch.dict(os.environ, {BOOTSTRAP_ACK_ENV: identity}):
            store = checkout_state_store(self.repo)
        append_jsonl(
            tools_root(store) / "runs.jsonl",
            {"run_id": "published-fixture", "status": "completed"},
            test_fixture=True,
        )
        repo_identity = canonical_identity(self.repo)
        snapshot = build_publishable_snapshot(
            store,
            snapshot_id="published-burn-in-fixture",
            cycle_id="published-burn-in-fixture",
            lane="test",
            repo_hash=repo_identity,
        )
        publish_state(
            store,
            snapshot=snapshot,
            cycle_id="published-burn-in-fixture",
            repo_hash=repo_identity,
        )
        self.tools_dir = self.tmp / "tools-root"
        self.workspace_base = self.tmp / "workspaces"
        self.output_dir = self.tools_dir / "burn-in" / "test-run"

    def tearDown(self) -> None:
        self._tmp.cleanup()

    @staticmethod
    def _valid_cycle_row() -> tuple[dict[str, object], dict[str, object]]:
        row: dict[str, object] = {
            "cycle_id": "cycle-validity",
            "status": "completed",
            "discovery_complete": True,
            "memory_evidence": {
                "observations_written": 1,
                "beliefs_written": 0,
                "no_op_proof": False,
            },
            "pressure_evidence": {"evaluated": True},
            "triage_evidence": {
                "evaluated": True,
                "decision_count": 0,
                "no_op_proof": True,
            },
            "state_continuity": {
                "status": "ok",
                "reference_kind": "state_branch",
                "blocks_action": False,
                "recovery": None,
            },
        }
        summary: dict[str, object] = {
            "missing_terminal_rows": [],
            "tail_hash": "sha256:" + "0" * 64,
        }
        return row, summary

    @staticmethod
    def _seed_dispatch_request(root: Path) -> Path:
        ensure_tools_dir(root)
        target = root / "dispatch" / "requests.jsonl"
        append_declared_fixture(
            target,
            {
                "request_id": "replacement-race-fixture",
                "status": "pending",
            },
            expected_surface="dispatch_requests",
        )
        return target

    def test_stopped_and_aborted_terminal_rows_are_not_reported_missing(self) -> None:
        ensure_tools_dir(self.tools_dir)
        cycles_path = self.tools_dir / "cycles.jsonl"
        for status in ("completed", "failed", "stopped", "aborted"):
            append_declared_fixture(
                cycles_path,
                {"cycle_id": status, "event": status, "status": status},
                expected_surface="cycles",
            )

        cycles = [
            {"cycle_id": status, "status": status}
            for status in ("completed", "failed", "stopped", "aborted")
        ]
        summary = _cycle_ledger_summary(self.tools_dir, cycles)

        self.assertEqual(summary["terminal_row_count"], 4)
        self.assertEqual(summary["missing_terminal_rows"], [])
        for status in ("stopped", "aborted"):
            validity = _cycle_validity(
                {"cycle_id": status, "status": status},
                cycle_ledger_summary=summary,
            )
            self.assertFalse(validity["valid"])
            self.assertIn("cycle_not_completed", validity["reasons"])
            self.assertNotIn("terminal_cycle_row_missing", validity["reasons"])

    def test_cycle_ledger_terminal_ids_exclude_history_and_preserve_duplicates(self) -> None:
        ensure_tools_dir(self.tools_dir)
        cycles_path = self.tools_dir / "cycles.jsonl"
        append_declared_fixture(
            cycles_path,
            {"cycle_id": "historical", "event": "completed", "status": "completed"},
            expected_surface="cycles",
        )
        attempted_ids = [f"attempted-{index:03d}" for index in range(1, 31)]
        for cycle_id in attempted_ids:
            append_declared_fixture(
                cycles_path,
                {"cycle_id": cycle_id, "event": "completed", "status": "completed"},
                expected_surface="cycles",
            )
        append_declared_fixture(
            cycles_path,
            {"cycle_id": attempted_ids[0], "event": "completed", "status": "completed"},
            expected_surface="cycles",
        )
        summary = _cycle_ledger_summary(
            self.tools_dir,
            [
                {"cycle_id": cycle_id, "status": "completed"}
                for cycle_id in attempted_ids
            ],
        )
        self.assertEqual(
            summary["terminal_cycle_ids"],
            [*attempted_ids, attempted_ids[0]],
        )
        self.assertEqual(summary["terminal_row_count"], 32)

    def test_cycle_without_continuity_is_invalid(self) -> None:
        row, summary = self._valid_cycle_row()
        row.pop("state_continuity")
        validity = _cycle_validity(row, cycle_ledger_summary=summary)
        self.assertIn("state_continuity_evidence_missing", validity["reasons"])

    def test_cycle_with_unknown_continuity_is_invalid(self) -> None:
        row, summary = self._valid_cycle_row()
        row["state_continuity"]["status"] = "unknown"
        validity = _cycle_validity(row, cycle_ledger_summary=summary)
        self.assertIn("state_continuity_not_ok", validity["reasons"])

    def test_cycle_with_genesis_continuity_is_invalid(self) -> None:
        row, summary = self._valid_cycle_row()
        row["state_continuity"]["status"] = "genesis"
        validity = _cycle_validity(row, cycle_ledger_summary=summary)
        self.assertIn("state_continuity_not_ok", validity["reasons"])

    def test_cycle_with_daily_anchor_continuity_is_invalid(self) -> None:
        row, summary = self._valid_cycle_row()
        row["state_continuity"]["reference_kind"] = "daily_anchor"
        validity = _cycle_validity(row, cycle_ledger_summary=summary)
        self.assertIn("state_continuity_not_state_branch", validity["reasons"])

    def test_cycle_with_critical_continuity_is_invalid(self) -> None:
        row, summary = self._valid_cycle_row()
        row["state_continuity"]["status"] = "critical"
        row["state_continuity"]["blocks_action"] = True
        validity = _cycle_validity(row, cycle_ledger_summary=summary)
        self.assertIn("state_continuity_not_ok", validity["reasons"])
        self.assertIn("state_continuity_blocks_action", validity["reasons"])

    def test_cycle_with_malformed_continuity_is_invalid(self) -> None:
        row, summary = self._valid_cycle_row()
        row["state_continuity"] = []
        validity = _cycle_validity(row, cycle_ledger_summary=summary)
        self.assertIn("state_continuity_evidence_missing", validity["reasons"])

    def test_cycle_with_recovery_evidence_is_invalid(self) -> None:
        row, summary = self._valid_cycle_row()
        row["state_continuity"]["recovery"] = {"resolved": True}
        validity = _cycle_validity(row, cycle_ledger_summary=summary)
        self.assertIn("state_continuity_recovery_forbidden", validity["reasons"])

    def test_every_returned_cycle_row_records_curated_continuity_before_classification(self) -> None:
        statuses = ("completed", "stopped", "aborted", "failed")
        calls = 0

        def returned_state(**_kwargs):
            nonlocal calls
            status = statuses[calls % len(statuses)]
            calls += 1
            return {
                "status": status,
                "failed_phases": [],
                "state_continuity": {
                    "status": "ok",
                    "reference_kind": "state_branch",
                    "blocks_action": False,
                    "recovery": None,
                    "reasons": ["not part of curated evidence"],
                },
                "discovery": {},
                "cycle_diff": {},
                "memory": {},
                "pressure": {},
                "triage": {},
            }

        with patch("aria_kernel.burn_in.run_enterprise_cycle", side_effect=returned_state):
            report = run_observe_burn_in(
                workspace_root=self.repo,
                workspace_base=self.workspace_base,
                base_dir=self.tools_dir,
                target_ref="HEAD",
                cycles=30,
                min_valid_cycles=20,
                output_dir=self.output_dir,
            )

        self.assertEqual(len(report["cycles"]), 30)
        for row in report["cycles"]:
            self.assertEqual(
                row["state_continuity"],
                {
                    "status": "ok",
                    "reference_kind": "state_branch",
                    "blocks_action": False,
                    "recovery": None,
                },
            )

    def test_producer_derives_no_op_proof_from_serialized_zero_counts(self) -> None:
        def zero_work_state(**_kwargs):
            return {
                "status": "completed",
                "state_continuity": {
                    "status": "ok",
                    "reference_kind": "state_branch",
                    "blocks_action": False,
                    "recovery": None,
                },
                "discovery": {
                    "completion_proof": {
                        "complete": True,
                        "fated_file_count": 0,
                    }
                },
                "cycle_diff": {"changed_count": 0},
                "memory": {
                    "observations_written": 0,
                    "beliefs_written": 0,
                    "noop_proof": False,
                },
                "pressure": {"pressures": []},
                "triage": {"triaged_count": 0, "decisions": []},
            }

        with patch(
            "aria_kernel.burn_in.run_enterprise_cycle",
            side_effect=zero_work_state,
        ):
            report = run_observe_burn_in(
                workspace_root=self.repo,
                workspace_base=self.workspace_base,
                base_dir=self.tools_dir,
                target_ref="HEAD",
                cycles=30,
                min_valid_cycles=20,
                output_dir=self.output_dir,
            )

        self.assertEqual(len(report["cycles"]), 30)
        for row in report["cycles"]:
            self.assertEqual(
                row["memory_evidence"],
                {
                    "observations_written": 0,
                    "beliefs_written": 0,
                    "no_op_proof": True,
                },
            )
            self.assertEqual(
                row["triage_evidence"],
                {
                    "evaluated": True,
                    "decision_count": 0,
                    "no_op_proof": True,
                },
            )

    def test_observe_burn_in_runs_against_a_real_restored_state_reference(self) -> None:
        report = run_observe_burn_in(
            workspace_root=self.repo,
            workspace_base=self.workspace_base,
            base_dir=self.tools_dir,
            target_ref="HEAD",
            cycles=30,
            min_valid_cycles=20,
            output_dir=self.output_dir,
        )

        self.assertEqual(report["schema_version"], "aria/autonomy-burn-in-report/v1")
        self.assertEqual(report["acceptance_verdict"], "passed")
        self.assertEqual(report["profile"], "observe")
        self.assertEqual(report["cycle_attempts"], 30)
        self.assertEqual(report["valid_cycles"], 30)
        self.assertEqual(report["disallowed_actions_observed"], [])
        for row in report["cycles"]:
            self.assertEqual(
                row["state_continuity"],
                {
                    "status": "ok",
                    "reference_kind": "state_branch",
                    "blocks_action": False,
                    "recovery": None,
                },
            )
        self.assertIn("cycles.json", report["artifact_hashes"])
        self.assertTrue((self.output_dir / "evidence-bundle.json").exists())
        self.assertTrue((self.output_dir / "cycle-ledger-summary.json").exists())
        self.assertTrue((self.output_dir / "disallowed-actions.json").exists())
        self.assertTrue((self.output_dir / "manifest-tail-hashes.json").exists())
        self.assertTrue((self.output_dir / "autonomy-burn-in-report.json").exists())
        persisted = json.loads((self.output_dir / "autonomy-burn-in-report.json").read_text(encoding="utf-8"))
        self.assertEqual(persisted["acceptance_verdict"], "passed")
        self.assertTrue(persisted["evidence_bundle_hash"].startswith("sha256:"))
        bundle = json.loads((self.output_dir / "evidence-bundle.json").read_text(encoding="utf-8"))
        self.assertTrue(bundle["burn_in_report_hash"].startswith("sha256:"))
        verify_burn_in_artifact_bundle(self.output_dir)

        for _surface, relative in DISALLOWED_OBSERVE_SURFACES:
            if not relative.endswith(".jsonl"):
                continue
            self.assertEqual(read_jsonl(self.tools_dir / relative), [])

    def test_burn_in_report_schema_rejects_contradictory_pass(self) -> None:
        schema = burn_in_report_schema()
        self.assertEqual(
            schema["properties"]["workflow_run_attempt"],
            {"type": "integer", "minimum": 0},
        )
        self.assertEqual(
            schema["properties"]["cycle_attempts"],
            {"type": "integer", "const": 30},
        )
        self.assertEqual(
            schema["properties"]["valid_cycles"],
            {"type": "integer", "minimum": 0, "maximum": 30},
        )
        self.assertEqual(
            schema["properties"]["failed_cycles"],
            {"type": "integer", "minimum": 0, "maximum": 30},
        )
        self.assertEqual(
            schema["properties"]["min_valid_cycles"],
            {"type": "integer", "const": 20},
        )
        report = run_observe_burn_in(
            workspace_root=self.repo,
            workspace_base=self.workspace_base,
            base_dir=self.tools_dir,
            target_ref="HEAD",
            cycles=30,
            min_valid_cycles=20,
            output_dir=self.output_dir,
        )
        mismatch = copy.deepcopy(report)
        mismatch["cycles"][0]["valid_cycle"] = False
        with self.assertRaisesRegex(GovernanceError, "valid_cycle_count_mismatch"):
            validate_burn_in_report(mismatch)
        report["valid_cycles"] = 19
        with self.assertRaisesRegex(GovernanceError, "insufficient_valid_cycles"):
            validate_burn_in_report(report)

    def test_failed_report_cannot_claim_valid_continuity_cycles(self) -> None:
        report = run_observe_burn_in(
            workspace_root=self.repo,
            workspace_base=self.workspace_base,
            base_dir=self.tools_dir,
            target_ref="HEAD",
            cycles=30,
            min_valid_cycles=20,
            output_dir=self.output_dir,
        )
        contradictory = copy.deepcopy(report)
        contradictory["cycles"][0]["state_continuity"]["status"] = "critical"
        with self.assertRaisesRegex(GovernanceError, "continuity"):
            validate_burn_in_report(contradictory)

    def test_burn_in_bundle_hash_mismatch_rejects(self) -> None:
        run_observe_burn_in(
            workspace_root=self.repo,
            workspace_base=self.workspace_base,
            base_dir=self.tools_dir,
            target_ref="HEAD",
            cycles=30,
            min_valid_cycles=20,
            output_dir=self.output_dir,
        )
        bundle_path = self.output_dir / "evidence-bundle.json"
        payload = json.loads(bundle_path.read_text(encoding="utf-8"))
        payload["burn_in_report_hash"] = "sha256:" + "0" * 64
        bundle_path.write_text(json.dumps(payload), encoding="utf-8")
        with self.assertRaisesRegex(GovernanceError, "report_hash_mismatch"):
            verify_burn_in_artifact_bundle(self.output_dir)

    def test_observe_burn_in_rejects_short_acceptance(self) -> None:
        with self.assertRaisesRegex(GovernanceError, "requires_30_cycles"):
            run_observe_burn_in(
                workspace_root=self.repo,
                workspace_base=self.workspace_base,
                base_dir=self.tools_dir,
                target_ref="HEAD",
                cycles=1,
                min_valid_cycles=1,
                output_dir=self.output_dir,
            )

    def test_disallowed_snapshot_rejects_broken_and_identical_symlink_mutations(self) -> None:
        dispatch = self.tools_dir / "dispatch"
        dispatch.mkdir(parents=True, exist_ok=True)
        external = self.tmp / "external.jsonl"
        external.write_bytes(b"")
        mutations = (
            ("broken.jsonl", lambda path: path.symlink_to(self.tmp / "missing.jsonl")),
            ("linked.jsonl", lambda path: path.symlink_to(external)),
            ("hardlinked.jsonl", lambda path: os.link(external, path)),
        )
        for name, install in mutations:
            with self.subTest(name=name):
                path = dispatch / name
                install(path)
                try:
                    with self.assertRaisesRegex(
                        GovernanceError,
                        "burn_in_disallowed_snapshot_path_invalid",
                    ):
                        _disallowed_snapshot(self.tools_dir)
                finally:
                    path.unlink(missing_ok=True)

    def test_disallowed_snapshot_accepts_unchanged_nonempty_overlapping_ledger(self) -> None:
        ensure_tools_dir(self.tools_dir)
        append_declared_fixture(
            self.tools_dir / "dispatch" / "requests.jsonl",
            ledger_module._make_replay_transport_row(
                {
                    "schema_version": 1,
                    "request_id": "dispatch-request-fixture",
                    "status": "pending",
                },
                expected_surface="dispatch_requests",
                surface_instance="dispatch/requests.jsonl",
                producer_event_id=ledger_module._record_hash(
                    {
                        "schema_version": 1,
                        "request_id": "dispatch-request-fixture",
                        "status": "pending",
                    },
                    None,
                ),
                producer_previous_ledger_hash=None,
                replay_transaction_id="burn-in-overlap-fixture",
            ),
            expected_surface="dispatch_requests",
        )

        before = _disallowed_snapshot(self.tools_dir)
        after = _disallowed_snapshot(self.tools_dir)

        self.assertEqual(before, after)
        self.assertEqual(_diff_snapshots(before, after), [])
        self.assertEqual(
            before["worker_dispatch"]["files"][0]["path"],
            "dispatch/requests.jsonl",
        )
        self.assertEqual(before["worker_dispatch"]["row_count"], 1)
        self.assertEqual(before["dispatch_requests"]["row_count"], 1)

    def test_disallowed_snapshot_rejects_regular_file_replacement_race(self) -> None:
        file_root = self.tmp / "file-race-tools"
        file_target = self._seed_dispatch_request(file_root)
        file_replacement = self.tmp / "file-race-replacement.jsonl"
        file_replacement.write_bytes(file_target.read_bytes())
        parked_file = self.tmp / "file-race-original.jsonl"
        real_open = secure_artifact_io_module.os.open
        file_swapped = False

        def swap_file_before_open(path, *args, **kwargs):
            nonlocal file_swapped
            if (
                not file_swapped
                and path == "requests.jsonl"
                and kwargs.get("dir_fd") is not None
            ):
                file_target.rename(parked_file)
                file_replacement.rename(file_target)
                file_swapped = True
            return real_open(path, *args, **kwargs)

        with patch.object(
            secure_artifact_io_module.os,
            "open",
            side_effect=swap_file_before_open,
        ):
            with self.assertRaisesRegex(
                GovernanceError,
                "burn_in_disallowed_snapshot_path_invalid",
            ):
                _disallowed_snapshot(file_root)
        self.assertTrue(file_swapped)

    def test_disallowed_snapshot_rejects_directory_replacement_race(self) -> None:
        directory_root = self.tmp / "directory-race-tools"
        directory_target_file = self._seed_dispatch_request(directory_root)
        dispatch = directory_target_file.parent
        replacement_dispatch = self.tmp / "directory-race-replacement"
        replacement_dispatch.mkdir()
        (replacement_dispatch / "requests.jsonl").write_bytes(
            directory_target_file.read_bytes()
        )
        parked_dispatch = self.tmp / "directory-race-original"
        real_listdir = secure_artifact_io_module.os.listdir
        directory_swapped = False

        def swap_directory_after_open(directory_fd):
            nonlocal directory_swapped
            if not directory_swapped:
                dispatch.rename(parked_dispatch)
                replacement_dispatch.rename(dispatch)
                directory_swapped = True
            return real_listdir(directory_fd)

        with patch.object(
            secure_artifact_io_module.os,
            "listdir",
            side_effect=swap_directory_after_open,
        ):
            with self.assertRaisesRegex(
                GovernanceError,
                "burn_in_disallowed_snapshot_path_invalid",
            ):
                _disallowed_snapshot(directory_root)
        self.assertTrue(directory_swapped)

    def test_optional_regular_file_rejects_parent_replacement_race(self) -> None:
        root = self.tmp / "optional-directory-race-tools"
        target = self._seed_dispatch_request(root)
        dispatch = target.parent
        replacement_dispatch = self.tmp / "optional-directory-race-replacement"
        replacement_dispatch.mkdir()
        (replacement_dispatch / "requests.jsonl").write_bytes(target.read_bytes())
        parked_dispatch = self.tmp / "optional-directory-race-original"
        real_lstat = secure_artifact_io_module.os.lstat
        swapped = False

        def swap_parent_before_file_classification(path, *args, **kwargs):
            nonlocal swapped
            if (
                not swapped
                and path == "requests.jsonl"
                and kwargs.get("dir_fd") is not None
            ):
                dispatch.rename(parked_dispatch)
                replacement_dispatch.rename(dispatch)
                swapped = True
            return real_lstat(path, *args, **kwargs)

        with secure_artifact_io_module.secure_directory_fd(root) as root_fd:
            with patch.object(
                secure_artifact_io_module.os,
                "lstat",
                side_effect=swap_parent_before_file_classification,
            ):
                with self.assertRaisesRegex(
                    GovernanceError,
                    "secure_artifact_directory_changed",
                ):
                    secure_artifact_io_module.read_optional_regular_file_at(
                        root_fd,
                        "dispatch/requests.jsonl",
                    )
        self.assertTrue(swapped)

    def test_optional_regular_file_rejects_ancestor_swap_on_missing_descendant(self) -> None:
        root = self.tmp / "optional-missing-descendant-race-tools"
        dispatch = root / "dispatch"
        dispatch.mkdir(parents=True)
        replacement_dispatch = self.tmp / "optional-missing-descendant-replacement"
        replacement_dispatch.mkdir()
        parked_dispatch = self.tmp / "optional-missing-descendant-original"
        real_lstat = secure_artifact_io_module.os.lstat
        swapped = False

        def swap_ancestor_before_missing_classification(path, *args, **kwargs):
            nonlocal swapped
            if (
                not swapped
                and path == "missing"
                and kwargs.get("dir_fd") is not None
            ):
                dispatch.rename(parked_dispatch)
                replacement_dispatch.rename(dispatch)
                swapped = True
            return real_lstat(path, *args, **kwargs)

        with secure_artifact_io_module.secure_directory_fd(root) as root_fd:
            with patch.object(
                secure_artifact_io_module.os,
                "lstat",
                side_effect=swap_ancestor_before_missing_classification,
            ):
                with self.assertRaisesRegex(
                    GovernanceError,
                    "secure_artifact_directory_changed",
                ):
                    secure_artifact_io_module.read_optional_regular_file_at(
                        root_fd,
                        "dispatch/missing/probe.json",
                    )
        self.assertTrue(swapped)

    def test_subtree_enumeration_rejects_final_root_dirent_replacement(self) -> None:
        root = self.tmp / "enumeration-root-binding-tools"
        target = self._seed_dispatch_request(root)
        replacement_root = self.tmp / "enumeration-root-binding-replacement"
        replacement_target = replacement_root / "dispatch" / "requests.jsonl"
        replacement_target.parent.mkdir(parents=True)
        replacement_target.write_bytes(target.read_bytes())
        parked_root = self.tmp / "enumeration-root-binding-original"
        real_listdir = secure_artifact_io_module.os.listdir
        swapped = False

        def swap_final_root_before_enumeration(directory_fd):
            nonlocal swapped
            if not swapped:
                root.rename(parked_root)
                replacement_root.rename(root)
                swapped = True
            return real_listdir(directory_fd)

        try:
            with self.assertRaisesRegex(
                GovernanceError,
                "secure_artifact_directory_changed",
            ):
                with secure_artifact_io_module.secure_directory_fd(root) as root_fd:
                    with patch.object(
                        secure_artifact_io_module.os,
                        "listdir",
                        side_effect=swap_final_root_before_enumeration,
                    ):
                        snapshots = secure_artifact_io_module.enumerate_regular_snapshots_beneath_at(
                            root_fd,
                            "dispatch",
                        )
                    self.assertEqual(
                        [relative for relative, _snapshot in snapshots],
                        [
                            "dispatch/requests.jsonl",
                            "dispatch/requests.jsonl.lock",
                        ],
                    )
        finally:
            self.assertTrue(swapped)

    def test_first_component_missing_optional_read_rejects_final_root_dirent_replacement(self) -> None:
        root = self.tmp / "optional-root-binding-tools"
        root.mkdir()
        replacement_root = self.tmp / "optional-root-binding-replacement"
        replacement_target = replacement_root / "missing" / "probe.json"
        replacement_target.parent.mkdir(parents=True)
        replacement_target.write_text('{"replacement":true}\n', encoding="utf-8")
        parked_root = self.tmp / "optional-root-binding-original"
        real_lstat = secure_artifact_io_module.os.lstat
        swapped = False

        def swap_final_root_before_missing_classification(path, *args, **kwargs):
            nonlocal swapped
            if (
                not swapped
                and path == "missing"
                and kwargs.get("dir_fd") is not None
            ):
                root.rename(parked_root)
                replacement_root.rename(root)
                swapped = True
            return real_lstat(path, *args, **kwargs)

        try:
            with self.assertRaisesRegex(
                GovernanceError,
                "secure_artifact_directory_changed",
            ):
                with secure_artifact_io_module.secure_directory_fd(root) as root_fd:
                    with patch.object(
                        secure_artifact_io_module.os,
                        "lstat",
                        side_effect=swap_final_root_before_missing_classification,
                    ):
                        snapshot = secure_artifact_io_module.read_optional_regular_file_at(
                            root_fd,
                            "missing/probe.json",
                        )
                    self.assertIsNone(snapshot)
        finally:
            self.assertTrue(swapped)
        self.assertEqual(
            (root / "missing" / "probe.json").read_text(encoding="utf-8"),
            '{"replacement":true}\n',
        )

    def test_observe_burn_in_rejects_repo_local_tools_dir(self) -> None:
        with self.assertRaisesRegex(GovernanceError, "tools_dir_must_be_outside_workspace_root"):
            run_observe_burn_in(
                workspace_root=self.repo,
                workspace_base=self.workspace_base,
                base_dir=self.repo / "aria-tools",
                target_ref="HEAD",
                cycles=30,
                min_valid_cycles=20,
                output_dir=self.output_dir,
            )

    def test_observe_burn_in_rejects_unsafe_output_before_write(self) -> None:
        unsafe_output = self.repo / "burn-in-output"
        with self.assertRaisesRegex(GovernanceError, "output_dir_must_be_outside_workspace_root"):
            run_observe_burn_in(
                workspace_root=self.repo,
                workspace_base=self.workspace_base,
                base_dir=self.tools_dir,
                target_ref="HEAD",
                cycles=30,
                min_valid_cycles=20,
                output_dir=unsafe_output,
            )
        self.assertFalse(unsafe_output.exists())

    def test_observe_burn_in_rejects_dirty_worktree(self) -> None:
        (self.repo / "scratch.txt").write_text("dirty\n", encoding="utf-8")
        with self.assertRaisesRegex(GovernanceError, "pre_worktree_not_clean"):
            run_observe_burn_in(
                workspace_root=self.repo,
                workspace_base=self.workspace_base,
                base_dir=self.tools_dir,
                target_ref="HEAD",
                cycles=30,
                min_valid_cycles=20,
                output_dir=self.output_dir,
            )

    def test_clean_worktree_guard_ignores_the_kernels_own_runtime_writes(self) -> None:
        """A runtime write must not make the observe burn-in unstartable.

        The guard used to reject any porcelain output at all. Once
        `aria-tools/reports/daily/*.md` became trackable, `reflection` writes it
        every cycle, so the next burn-in dispatch died with
        `observe_burn_in_pre_worktree_not_clean` and produced zero ladder
        evidence — a gate defeating the thing it exists to measure. CI cannot
        see it either, because CI points the kernel at `.aria-ci/tools`.

        `_require_clean_worktree` is called directly rather than through
        `run_observe_burn_in`. Driving it through the public entry point made
        this assertion vacuous: `_validate_args` rejects the small cycle counts
        a fast test wants, so the guard was never reached and the test passed
        against the unfixed code too.
        """
        runtime_report = self.repo / "aria-tools" / "reports" / "daily" / "2099-01-01.md"
        runtime_report.parent.mkdir(parents=True, exist_ok=True)
        runtime_report.write_text("# anchor\n", encoding="utf-8")
        subprocess.run(
            ["git", "add", "-f", "aria-tools/reports/daily/2099-01-01.md"],
            cwd=self.repo, check=True, capture_output=True,
        )
        porcelain = subprocess.run(
            ["git", "status", "--porcelain"],
            cwd=self.repo, text=True, capture_output=True, check=True,
        ).stdout
        self.assertIn(
            "aria-tools/reports/daily/2099-01-01.md", porcelain,
            msg="fixture precondition: the runtime write must be visible to git",
        )
        _require_clean_worktree(self.repo, "pre")

    def test_clean_worktree_guard_still_rejects_a_dirty_source_tree(self) -> None:
        """Filtering runtime paths must not weaken the guard for source dirt."""
        (self.repo / "apps" / "api" / "src" / "main.ts").write_text(
            "export const api = false;\n", encoding="utf-8",
        )
        with self.assertRaisesRegex(GovernanceError, "pre_worktree_not_clean"):
            _require_clean_worktree(self.repo, "pre")

    def test_clean_worktree_guard_agrees_with_the_preflight_gate(self) -> None:
        """One definition of "clean" over one tree, not two.

        `worktree.preflight` already excluded runtime paths while this guard did
        not, so the same tree was clean to one gate and dirty to the other. The
        notion is now imported, and this pins that it stays imported rather than
        being restated and allowed to drift.
        """
        for line in (
            "A  aria-tools/reports/daily/2099-01-01.md",
            "?? aria-findings/F-999.json",
            " M aria-debts/DEBT-2026-01-01-001.json",
        ):
            self.assertTrue(
                worktree_is_runtime_path(line),
                msg=f"preflight treats this as runtime, the burn-in guard must too: {line!r}",
            )
        for line in (" M apps/api/src/main.ts", "?? scratch.txt"):
            self.assertFalse(worktree_is_runtime_path(line))

    def test_observe_burn_in_rejects_target_ref_mismatch(self) -> None:
        first_head = subprocess.run(
            ["git", "rev-parse", "HEAD"],
            cwd=self.repo,
            text=True,
            capture_output=True,
            check=True,
        ).stdout.strip()
        (self.repo / "README.md").write_text("next\n", encoding="utf-8")
        subprocess.run(["git", "add", "README.md"], cwd=self.repo, check=True)
        subprocess.run(
            ["git", "commit", "-q", "-m", "fixture: next"],
            cwd=self.repo,
            check=True,
        )

        with self.assertRaisesRegex(GovernanceError, "target_ref_mismatch"):
            run_observe_burn_in(
                workspace_root=self.repo,
                workspace_base=self.workspace_base,
                base_dir=self.tools_dir,
                target_ref=first_head,
                cycles=30,
                min_valid_cycles=20,
                output_dir=self.output_dir,
            )


if __name__ == "__main__":
    unittest.main()
