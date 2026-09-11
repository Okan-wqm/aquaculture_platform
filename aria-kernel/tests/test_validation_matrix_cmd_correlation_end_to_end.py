"""Plan 024 v3 §B-5 — validation matrix cmd correlation end-to-end tests.

Pre-fix list_required_tests projection (validation_matrix_gate.py:218-224)
serialised path_glob, path_substr, regex_pattern but OMITTED
expected_cmd_substring. The downstream gate
_check_required_test_cmd_correlation (line 320-322) saw None on every
spec.get('expected_cmd_substring') and silent-skipped — `cmd: 'echo ok'`
then satisfied any required test in production. Plan 023 §R-3 + §R-3.1
migrated the spec table; Plan 024 §B-5 closes the projection-time
strip so the field survives every hop from spec table → projection →
enforce_validation_matrix → correlation gate.

Tests:
1. Projection output for every risk_type carries expected_cmd_substring.
2. Gate receives the field and fires correlation against echo-ok.
3. cmd matching the substring passes correlation.
4. Spec mutation (test removes the field from one spec) → projection
   raises required_test_spec_missing_expected_cmd_substring at first
   call.
5. Direct call to _check_required_test_cmd_correlation with a spec
   missing the field raises validation_matrix_spec_missing_cmd_-
   correlation_field — fail-loud, not silent-skip.
"""
from __future__ import annotations

import unittest
from unittest.mock import patch

from aria_kernel.tool_registry import GovernanceError
from aria_kernel.validation_matrix_gate import (
    _REQUIRED_TESTS_BY_RISK,
    _check_required_test_cmd_correlation,
    list_required_tests,
)


class CmdCorrelationEndToEndTests(unittest.TestCase):
    def test_projection_output_carries_expected_cmd_substring(self) -> None:
        """Plan 024 §B-5 acceptance (1)."""
        for risk_type in _REQUIRED_TESTS_BY_RISK:
            projection = list_required_tests([risk_type])
            for spec in projection:
                self.assertIn("expected_cmd_substring", spec,
                    f"projection for {risk_type}/{spec.get('name')} missing "
                    f"expected_cmd_substring")
                self.assertIsInstance(spec["expected_cmd_substring"], str)
                self.assertTrue(spec["expected_cmd_substring"].strip())

    def test_correlation_gate_fires_on_echo_ok(self) -> None:
        """Plan 024 §B-5 acceptance (2)."""
        projection = list_required_tests(["auth_change"])
        # Build a candidate_refs list with cmd='echo ok' which should
        # NOT satisfy the required test cmd substring.
        refs = [{"cmd": "echo ok", "exit_code": 0, "log_path": "/tmp/x", "ran_at": "2026-05-09T00:00:00Z"}]
        failures = _check_required_test_cmd_correlation(
            required_tests=projection, candidate_refs=refs,
        )
        # Every required test should fail-correlation since 'echo ok'
        # contains none of the expected substrings (e.g. 'nx test
        # auth-service').
        self.assertGreater(len(failures), 0,
            "echo ok must not satisfy the auth_change required tests")
        for f in failures:
            self.assertIn("validation_run_ref_does_not_match_required_test_cmd", f)

    def test_correlation_gate_passes_on_matching_cmd(self) -> None:
        """Plan 024 §B-5 acceptance (3)."""
        projection = list_required_tests(["auth_change"])
        # Pick the first spec's expected_cmd_substring as the cmd; that
        # should at least satisfy that spec.
        first_substr = projection[0]["expected_cmd_substring"]
        refs = [{
            "cmd": f"npx {first_substr} --skip-nx-cache",
            "exit_code": 0,
            "log_path": "/tmp/x",
            "ran_at": "2026-05-09T00:00:00Z",
        }]
        failures = _check_required_test_cmd_correlation(
            required_tests=projection, candidate_refs=refs,
        )
        # Filter for failures specifically about the first spec's name.
        first_name = projection[0]["name"]
        relevant = [f for f in failures if first_name in f]
        self.assertEqual(len(relevant), 0,
            f"cmd containing {first_substr!r} must satisfy first spec; "
            f"unexpected failures: {relevant!r}")

    def test_spec_mutation_raises_at_projection(self) -> None:
        """Plan 024 §B-5 acceptance (4): a future spec edit that drops
        the field surfaces at first list_required_tests call."""
        # Build a mutated registry that drops expected_cmd_substring
        # from one spec.
        first_risk = next(iter(_REQUIRED_TESTS_BY_RISK))
        mutated = {
            first_risk: tuple(
                {k: v for k, v in spec.items() if k != "expected_cmd_substring"}
                for spec in _REQUIRED_TESTS_BY_RISK[first_risk]
            ),
        }
        with patch(
            "aria_kernel.validation_matrix_gate._REQUIRED_TESTS_BY_RISK",
            mutated,
        ):
            with self.assertRaises(GovernanceError) as ctx:
                list_required_tests([first_risk])
            self.assertIn(
                "required_test_spec_missing_expected_cmd_substring",
                str(ctx.exception),
            )

    def test_correlation_gate_rejects_spec_without_field(self) -> None:
        """Plan 024 §B-5 acceptance (5): direct call surfaces the same
        guard, defense in depth even if a future caller bypasses
        list_required_tests."""
        rogue_spec = {
            "risk_type": "auth_change",
            "name": "rogue_test_without_substr",
            "path_glob": "**/*.spec.ts",
            "path_substr": "auth",
            "regex_pattern": ".",
        }
        with self.assertRaises(GovernanceError) as ctx:
            _check_required_test_cmd_correlation(
                required_tests=[rogue_spec],
                candidate_refs=[{"cmd": "x", "exit_code": 0, "log_path": "/x", "ran_at": "x"}],
            )
        self.assertIn(
            "validation_matrix_spec_missing_cmd_correlation_field",
            str(ctx.exception),
        )


    def test_native_allowed_nx_run_satisfies_its_actual_upcaster_requirement(self) -> None:
        """Real selected library test -> native run -> existing correlation gate."""
        import hashlib
        import json
        import os
        from pathlib import Path
        import re
        import subprocess
        import tempfile

        from aria_kernel.change_ledger import emit_change_planned, get_change_chain
        from aria_kernel.finding import emit_finding
        from aria_kernel.runtime_profile import set_profile
        from aria_kernel.validation import parse_allowed_command, run_validation_commands
        from aria_kernel.validation_runs_ledger import list_validation_runs, verify_validation_run
        from aria_kernel.workspace import ensure_workspace, workspace_paths
        from tests._helpers.git_fixtures import make_local_git_repo
        from tests._helpers.production_shaped import production_converged_plan

        source_root = Path(__file__).resolve().parents[2]
        selected = "libs/event-contracts/src/upcasters/__tests__/upcasters.spec.ts"
        command = (
            "npx nx run-many --target=test --projects=event-contracts "
            "--parallel=1 --skip-nx-cache --runInBand --testFile=" + selected
        )
        requirement = next(
            row for row in list_required_tests(["event_change"])
            if row["name"] == "upcaster_test"
        )
        self.assertEqual(requirement["expected_cmd_substring"], "nx test event-contracts")
        self.assertEqual(parse_allowed_command(command)[0][:3], ["npx", "nx", "run-many"])
        with self.assertRaisesRegex(GovernanceError, "must use affected or run-many"):
            parse_allowed_command("npx " + requirement["expected_cmd_substring"])

        with tempfile.TemporaryDirectory(prefix="aria-native-upcaster-run-") as fixture_directory:
            fixture = Path(fixture_directory)
            root = make_local_git_repo(fixture, name="workspace")
            tools = fixture / "tools"
            isolated_roots = {
                "ARIA_TOOLS_DIR": tools,
                "ARIA_WORKSPACE_BASE": fixture / "workspaces",
                "ARIA_REPO_STATE_ROOT": fixture / "repo-state",
                "ARIA_STATE_STORE_ROOT": fixture / "state-store",
            }
            for path in isolated_roots.values():
                path.mkdir(parents=True, exist_ok=True)
            with patch.dict(os.environ, {key: str(path) for key, path in isolated_roots.items()}):
                set_profile("standard", operator_approval_ref="declared-native-validation-control", base_dir=tools)
                library = source_root / "libs/event-contracts"
                copied = sorted(
                    str(path.relative_to(source_root))
                    for path in library.rglob("*")
                    if path.is_file() and path.suffix in {".ts", ".json"}
                ) + [
                    "jest.preset.js", "tsconfig.base.json",
                    "aria-kernel/aria_kernel/validation.py",
                    "aria-kernel/aria_kernel/validation_matrix_gate.py",
                ]
                self.assertLessEqual(len(copied), 128)
                expected_bytes = {rel: (source_root / rel).read_bytes() for rel in copied}
                self.assertLessEqual(sum(map(len, expected_bytes.values())), 2 * 1024 * 1024)
                self.assertIn(selected, expected_bytes)
                for rel, data in expected_bytes.items():
                    destination = root / rel
                    destination.parent.mkdir(parents=True, exist_ok=True)
                    destination.write_bytes(data)
                    self.assertEqual(destination.read_bytes(), data)
                (root / "package.json").write_text(json.dumps({"name": "aria-native-validation-fixture", "private": True}) + "\n")
                (root / "nx.json").write_text(json.dumps({"plugins": [], "neverConnectToCloud": True}) + "\n")
                (root / ".gitignore").write_text("/node_modules\n/.nx/\n/coverage/\n/aria-findings/\n/workspaces/\n")
                dependencies = (source_root / "node_modules").resolve(strict=True)
                self.assertTrue((dependencies / ".bin/nx").is_file())
                self.assertTrue((dependencies / "@nx/jest/src/executors/jest/schema.json").is_file())
                (root / "node_modules").symlink_to(dependencies, target_is_directory=True)
                subprocess.run(["git", "add", "."], cwd=root, check=True, capture_output=True)
                subprocess.run(["git", "commit", "-m", "fixture: bind actual event validation inputs"], cwd=root, check=True, capture_output=True)
                ensure_workspace(workspace_paths(root))
                finding = emit_finding(
                    repo_root=root, base_dir=tools, claim_type="contradiction", severity="MEDIUM",
                    claim_summary="The required direct Nx test spelling is refused by the approved validation runner",
                    evidences=[
                        {"ref": "aria-kernel/aria_kernel/validation.py", "summary": "The approved Nx runner accepts affected or run-many"},
                        {"ref": "aria-kernel/aria_kernel/validation_matrix_gate.py", "summary": "The upcaster requirement requests nx test event-contracts"},
                    ],
                    facts=["The actual command parser accepted run-many and refused the projected direct test command"],
                    scope_files=["aria-kernel/aria_kernel/validation.py", "aria-kernel/aria_kernel/validation_matrix_gate.py"],
                )
                plan = production_converged_plan(
                    tools_dir=tools, workspace_root=root, plan_id="native-validation-command-compatibility",
                    affected_paths=["aria-kernel/aria_kernel/validation_matrix_gate.py"],
                    evidence_refs=[selected], validation_commands=[{"cmd": command, "timeout_ms": 180_000}],
                )
                # The existing helper writes its declared reviewer file. Commit that
                # ordinary fixture input before the native runner's clean-HEAD check.
                subprocess.run(["git", "add", ".claude/agents"], cwd=root, check=True, capture_output=True)
                subprocess.run(["git", "commit", "-m", "fixture: bind native plan reviewer"], cwd=root, check=True, capture_output=True)
                head = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=root, text=True).strip()
                self.assertEqual(subprocess.check_output(["git", "status", "--porcelain"], cwd=root), b"")
                change = emit_change_planned(
                    plan_id=plan.plan_id, finding_id=finding["finding_id"],
                    intended_affected_files=["aria-kernel/aria_kernel/validation_matrix_gate.py"],
                    intended_validation_refs=[command], architectural_tier=1, base_dir=tools,
                )
                self.assertEqual(get_change_chain(change_id=change["change_id"], base_dir=tools)["planned"]["ledger_hash"], change["ledger_hash"])
                self.assertEqual(list_validation_runs(base_dir=tools), [])
                scope = {
                    "schema_version": 1,
                    "files": {"source": copied, "config": ["package.json", "nx.json", ".gitignore"]},
                }
                with patch.dict(os.environ, {
                    "NX_DAEMON": "false", "NX_ISOLATE_PLUGINS": "false", "NX_NO_CLOUD": "true",
                    "NX_TASKS_RUNNER_DYNAMIC_OUTPUT": "false", "NX_PARALLEL": "1",
                    "npm_config_offline": "true", "npm_config_yes": "false", "FORCE_COLOR": "0",
                }):
                    observation = run_validation_commands(
                        commands=[command], workspace_root=root, change_id=change["change_id"],
                        commit_sha=head, runner_identity="declared-native-validation-runner",
                        change_author_identity="declared-command-compatibility-author",
                        base_dir=tools, validation_plan_id="native-upcaster-validation",
                        timeout_ms=180_000, input_scope=scope,
                    )
                self.assertEqual(observation["command_count"], 1)
                self.assertEqual(len(observation["validation_run_ids"]), 1)
                run = verify_validation_run(observation["validation_run_ids"][0], base_dir=tools)
                log = Path(run["log_path"]).read_text()
                self.assertEqual(observation["status"], "ok", log[-12000:])
                self.assertEqual(run["commit_sha"], head)
                self.assertEqual(run["change_id"], change["change_id"])
                self.assertEqual(run["cmd"], command)
                self.assertEqual(run["exit_code"], 0)
                self.assertEqual(observation["run_refs"], [run["ledger_hash"]])
                self.assertIn("upcasters.spec.ts", log)
                matched = re.search(r"Tests:\s+(\d+) passed", log)
                self.assertIsNotNone(matched, log)
                self.assertGreater(int(matched.group(1)), 0)
                self.assertEqual(subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=root, text=True).strip(), head)
                for rel, data in expected_bytes.items():
                    self.assertEqual(hashlib.sha256((root / rel).read_bytes()).digest(), hashlib.sha256(data).digest())

                self.assertEqual(
                    _check_required_test_cmd_correlation(required_tests=[requirement], candidate_refs=[run]),
                    [],
                    "The real approved run executed the required upcaster suite at its recorded commit",
                )
                self.assertEqual(list_validation_runs(base_dir=tools), [run])
                self.assertIsNone(get_change_chain(change_id=change["change_id"], base_dir=tools)["validated"])


if __name__ == "__main__":
    unittest.main()
