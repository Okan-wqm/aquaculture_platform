from __future__ import annotations

import base64
import json
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
from io import StringIO
from pathlib import Path

from aria_kernel import (
    GovernanceError,
    generate_judgment_sample,
    get_tool,
    latest_fixture_status,
    list_tools,
    promote_tool,
    record_run,
    register_tool,
    run_fixture_suite,
    run_tool,
    transition_tool,
)
from aria_kernel.cli import main
from aria_kernel.feedback_store import record_operator_feedback

FAKE_RUNNER = Path(__file__).resolve().parent / "_helpers" / "fake_tool_runner.py"


# ORPHAN-MEDIUM-738 — the happy-path budget measures the CONTRACT, not the
# host. At 1000ms a healthy fixture tool could exceed its budget purely
# because the machine was busy (observed at load average 10-13: a full
# suite plus parallel agents), turning "a valid run records ok" into a
# coin flip. 30s is still a bound — a tool that needs longer is genuinely
# broken — while the budget-EXCEEDED path keeps its own dedicated test
# with a deliberate 40x margin (sleep 1s against timeout_ms=25), so the
# refusal stays proven by a case that cannot be explained by load.
_HAPPY_PATH_TIMEOUT_MS = 30_000


def runner(argv=None, **overrides):
    config = {
        "type": "subprocess",
        "argv": fake_tool_argv(valid_tool_output()) if argv is None else argv,
        "cwd": ".",
        "timeout_ms": _HAPPY_PATH_TIMEOUT_MS,
        "stdin_json": True,
    }
    config.update(overrides)
    return config


def register_active_for_test(tool, base_dir):
    """Plan 023 v3 §C-3 — test fixture helper.

    register_tool now rejects first-time registrations at ACTIVE / CALIBRATE
    / QUARANTINED. Tests that need ACTIVE-tool behavior must route through
    the lifecycle: SHADOW first-register, then transition_tool() with
    synthetic gate values that satisfy the ACTIVE precondition checks.
    Production callers cannot call this helper — it lives in the test
    namespace only and uses operator_approval=True / precision=1.0 /
    evidence_chains_valid=True purely for fixture wiring.

    For initial-lifecycle states (DRAFT/SANDBOX/SHADOW) and intentional
    rejection-path probes (BROKEN status, missing fields, etc.), the
    helper falls through to register_tool unchanged so the test author's
    intent is preserved.
    """
    target = tool.get("status", "ACTIVE")
    if target in ("DRAFT", "SANDBOX", "SHADOW"):
        # Initial-lifecycle states pass through register_tool unchanged.
        return register_tool(tool, base_dir=base_dir)
    if target not in ("ACTIVE", "CALIBRATE", "QUARANTINED"):
        # Invalid status values (BROKEN, etc.) reach register_tool's
        # validation and raise as before.
        return register_tool(tool, base_dir=base_dir)
    # Route ACTIVE / CALIBRATE / QUARANTINED through the legitimate
    # lifecycle: SHADOW first-register, then the appropriate API.
    initial = {**tool, "status": "SHADOW"}
    register_tool(initial, base_dir=base_dir)
    if target == "QUARANTINED":
        from aria_kernel.quarantine import quarantine_tool
        return quarantine_tool(
            tool["tool_id"],
            "test fixture quarantine",
            base_dir=base_dir,
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


def valid_tool(**overrides):
    tool = {
        "tool_id": "ts-adapter",
        "kind": "adapter",
        "version": "1.0.0",
        "status": "ACTIVE",
        "declared_scope": ["apps/farm-service/src/**/*.ts"],
        "output_schema": {
            "type": "object",
            "required": ["observations", "findings", "read_paths", "evidence_sources"],
        },
        "fixture_set": "fixtures/ts-adapter",
        "health_thresholds": {"max_cost_units": 50},
        "allowed_read_globs": ["apps/farm-service/src/**/*.ts"],
        "forbidden_read_globs": ["dist/**"],
        "claim_types": ["schema_drift"],
        "owner": "platform",
        "runner": runner(),
        "schema_version": 1,
    }
    tool.update(overrides)
    return tool


def valid_run(**overrides):
    run = {
        "run_id": "run-1",
        "tool_id": "ts-adapter",
        "cycle_id": "cycle-1",
        "status": "ok",
        "input_hash": "sha256:input",
        "output_hash": "sha256:output",
        "read_paths": ["apps/farm-service/src/app.module.ts"],
        "emitted_observations": [],
        "emitted_findings": [],
        "evidence_validation": {"valid": True, "evidence_sources": ["apps/farm-service/src/app.module.ts"]},
        "operator_feedback_refs": [],
        "duration_ms": 25,
        "cost_units": 1,
        "schema_version": 1,
    }
    run.update(overrides)
    return run


def valid_tool_output(**overrides):
    output = {
        "observations": [{"id": "obs-1"}],
        "findings": [
            {
                "id": "finding-1",
                "evidence": [{"path": "apps/farm-service/src/app.module.ts", "line": 1}],
            },
        ],
        "read_paths": ["apps/farm-service/src/app.module.ts"],
        "evidence_sources": ["apps/farm-service/src/app.module.ts"],
        "cost_units": 1,
        "metadata": {"fixture": True},
    }
    output.update(overrides)
    return output


def fake_tool_argv(output, *, exit_code=0, mutate=False, sleep_seconds=0):
    encoded = base64.b64encode(json.dumps(output, separators=(",", ":")).encode("utf-8")).decode("ascii")
    argv = ["python3", FAKE_RUNNER.as_posix(), "--output-b64", encoded]
    if mutate:
        argv.extend(["--mutate", "apps/farm-service/src/mutated.ts"])
    if sleep_seconds:
        argv.extend(["--sleep-seconds", str(sleep_seconds)])
    if exit_code:
        argv.extend(["--exit-code", str(exit_code)])
    return argv


def invalid_json_argv():
    return ["python3", FAKE_RUNNER.as_posix(), "--invalid-json"]


class ToolGovernanceTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name) / "workspace"
        self.root.mkdir()
        app_module = self.root / "apps/farm-service/src/app.module.ts"
        app_module.parent.mkdir(parents=True, exist_ok=True)
        app_module.write_text("export const app = true;\n", encoding="utf-8")
        self.tools_dir = Path(self.tmp.name) / "aria-tools"

    def tearDown(self):
        self.tmp.cleanup()

    def test_registry_accepts_valid_adapter_definition(self):
        registered = register_active_for_test(valid_tool(), base_dir=self.tools_dir)
        self.assertEqual(registered["tool_id"], "ts-adapter")
        self.assertEqual(list_tools("ACTIVE", base_dir=self.tools_dir)[0]["tool_id"], "ts-adapter")

    def test_registry_accepts_default_input_object(self):
        registered = register_active_for_test(
            valid_tool(default_input={"roots": ["apps/farm-service/src"]}),
            base_dir=self.tools_dir,
        )
        self.assertEqual(registered["default_input"], {"roots": ["apps/farm-service/src"]})

    def test_registry_rejects_non_object_default_input(self):
        with self.assertRaisesRegex(GovernanceError, "default_input"):
            register_active_for_test(valid_tool(default_input=["bad"]), base_dir=self.tools_dir)

    def test_registry_accepts_valid_skill_definition(self):
        registered = register_active_for_test(
            valid_tool(tool_id="drift-skill", kind="skill", claim_types=["drift"]),
            base_dir=self.tools_dir,
        )
        self.assertEqual(registered["kind"], "skill")

    def test_registry_rejects_missing_scope_output_schema_and_unknown_state(self):
        with self.assertRaisesRegex(GovernanceError, "declared_scope"):
            register_active_for_test(valid_tool(declared_scope=[]), base_dir=self.tools_dir)
        with self.assertRaisesRegex(GovernanceError, "output_schema"):
            register_active_for_test(valid_tool(output_schema={}), base_dir=self.tools_dir)
        with self.assertRaisesRegex(GovernanceError, "unknown lifecycle state"):
            register_active_for_test(valid_tool(status="BROKEN"), base_dir=self.tools_dir)

    def test_registry_requires_runner_for_executable_lifecycle_states(self):
        tool = valid_tool(status="DRAFT")
        tool.pop("runner")
        registered = register_tool(tool, base_dir=self.tools_dir)
        self.assertNotIn("runner", registered)

        active = valid_tool()
        active.pop("runner")
        with self.assertRaisesRegex(GovernanceError, "requires runner"):
            register_tool(active, base_dir=self.tools_dir)

    def test_registry_rejects_malformed_runner_configuration(self):
        with self.assertRaisesRegex(GovernanceError, "runner.argv"):
            register_active_for_test(valid_tool(runner=runner(argv=[])), base_dir=self.tools_dir)
        with self.assertRaisesRegex(GovernanceError, "runner.cwd"):
            register_active_for_test(valid_tool(runner=runner(cwd="/tmp")), base_dir=self.tools_dir)
        with self.assertRaisesRegex(GovernanceError, "runner.cwd"):
            register_active_for_test(valid_tool(runner=runner(cwd="../escape")), base_dir=self.tools_dir)
        with self.assertRaisesRegex(GovernanceError, "runner.timeout_ms"):
            register_active_for_test(valid_tool(runner=runner(timeout_ms=-1)), base_dir=self.tools_dir)

    def test_registry_rejects_runner_argv_by_command_policy(self):
        with self.assertRaisesRegex(GovernanceError, "runner.argv_rejected_by_command_policy"):
            register_active_for_test(
                valid_tool(runner=runner(argv=["gh", "api", "/repos/x/y/pulls/42/merge"])),
                base_dir=self.tools_dir,
            )
        with self.assertRaisesRegex(GovernanceError, "runner.argv_rejected_by_command_policy"):
            register_active_for_test(
                valid_tool(runner=runner(argv=["bash", "-c", "gh api /repos/x/y/pulls/42/merge"])),
                base_dir=self.tools_dir,
            )

    def test_run_ledger_records_valid_run_envelopes(self):
        register_active_for_test(valid_tool(), base_dir=self.tools_dir)
        decision = record_run(valid_run(), base_dir=self.tools_dir)
        self.assertEqual(decision["action"], "none")
        rows = (self.tools_dir / "runs.jsonl").read_text(encoding="utf-8").strip().splitlines()
        self.assertEqual(len(rows), 1)
        self.assertEqual(json.loads(rows[0])["run_id"], "run-1")

    def test_scope_violation_auto_quarantines_tool(self):
        register_active_for_test(valid_tool(), base_dir=self.tools_dir)
        decision = record_run(
            valid_run(read_paths=["apps/auth-service/src/main.ts"]),
            base_dir=self.tools_dir,
        )
        self.assertEqual(decision["action"], "quarantine")
        self.assertIn("scope violation", decision["reason"])
        self.assertEqual(get_tool("ts-adapter", base_dir=self.tools_dir)["status"], "QUARANTINED")

    def test_generated_workspace_read_auto_quarantines_tool(self):
        register_active_for_test(valid_tool(), base_dir=self.tools_dir)
        decision = record_run(
            valid_run(read_paths=["agent-workspace/l3-findings/backend/farm-service/security.md"]),
            base_dir=self.tools_dir,
        )
        self.assertEqual(decision["action"], "quarantine")
        self.assertEqual(get_tool("ts-adapter", base_dir=self.tools_dir)["status"], "QUARANTINED")

    def test_self_output_evidence_auto_quarantines_tool(self):
        register_active_for_test(valid_tool(), base_dir=self.tools_dir)
        decision = record_run(
            valid_run(
                evidence_validation={
                    "self_output_evidence": True,
                    "evidence_sources": ["agent-workspace/final-report.md"],
                },
            ),
            base_dir=self.tools_dir,
        )
        self.assertEqual(decision["action"], "quarantine")
        self.assertIn("self-output evidence", decision["reason"])

    def test_invalid_output_schema_auto_quarantines_tool(self):
        register_active_for_test(valid_tool(), base_dir=self.tools_dir)
        decision = record_run(valid_run(status="schema_error"), base_dir=self.tools_dir)
        self.assertEqual(decision["action"], "quarantine")
        self.assertIn("invalid output schema", decision["reason"])

    def test_tool_runner_records_valid_subprocess_output(self):
        register_active_for_test(valid_tool(), base_dir=self.tools_dir)
        decision = run_tool(
            "ts-adapter",
            {"target": "farm"},
            "cycle-1",
            run_id="runner-ok",
            workspace_root=self.root,
            base_dir=self.tools_dir,
        )
        self.assertEqual(decision["action"], "none")
        run = self.latest_run()
        self.assertEqual(run["status"], "ok")
        self.assertEqual(run["run_id"], "runner-ok")
        self.assertEqual(run["emitted_counts"]["observations"], 1)
        self.assertEqual(run["emitted_counts"]["findings"], 1)
        self.assertTrue(run["input_hash"].startswith("sha256:"))
        self.assertTrue(run["output_hash"].startswith("sha256:"))

    def test_tool_runner_allowed_read_path_keeps_active_tool_healthy(self):
        # Plan 022 §M-2 — evidence_refs MUST be a subset of read_paths.
        # The fixture override sets read_paths to main.ts, so the
        # finding's evidence + evidence_sources must also point at
        # main.ts (not the default app.module.ts) for the run to stay
        # clean. Pre-Plan-022 the mismatch silently passed.
        (self.root / "apps/farm-service/src/main.ts").write_text("export const main = true;\n", encoding="utf-8")
        register_active_for_test(
            valid_tool(runner=runner(fake_tool_argv(valid_tool_output(
                read_paths=["apps/farm-service/src/main.ts"],
                findings=[{"id": "finding-1",
                           "evidence": [{"path": "apps/farm-service/src/main.ts", "line": 1}]}],
                evidence_sources=["apps/farm-service/src/main.ts"],
            )))),
            base_dir=self.tools_dir,
        )
        decision = run_tool(
            "ts-adapter",
            {},
            "cycle-1",
            workspace_root=self.root,
            base_dir=self.tools_dir,
        )
        self.assertEqual(decision["action"], "none")
        self.assertEqual(get_tool("ts-adapter", base_dir=self.tools_dir)["status"], "ACTIVE")

    def test_tool_runner_scope_violation_quarantines_tool(self):
        register_active_for_test(
            valid_tool(
                runner=runner(
                    fake_tool_argv(valid_tool_output(read_paths=["apps/auth-service/src/main.ts"])),
                ),
            ),
            base_dir=self.tools_dir,
        )
        decision = run_tool(
            "ts-adapter",
            {},
            "cycle-1",
            workspace_root=self.root,
            base_dir=self.tools_dir,
        )
        self.assertEqual(decision["action"], "quarantine")
        self.assertEqual(self.latest_run()["status"], "scope_violation")

    def test_tool_runner_self_output_evidence_quarantines_tool(self):
        register_active_for_test(
            valid_tool(
                runner=runner(
                    fake_tool_argv(
                        valid_tool_output(evidence_sources=["aria-tools/runs.jsonl"]),
                    ),
                ),
            ),
            base_dir=self.tools_dir,
        )
        decision = run_tool(
            "ts-adapter",
            {},
            "cycle-1",
            workspace_root=self.root,
            base_dir=self.tools_dir,
        )
        self.assertEqual(decision["action"], "quarantine")
        self.assertIn("self-output evidence", decision["reason"])

    def test_tool_runner_invalid_evidence_line_quarantines_tool(self):
        output = valid_tool_output(
            findings=[
                {
                    "id": "finding-1",
                    "evidence": [{"path": "apps/farm-service/src/app.module.ts", "line": 999}],
                },
            ],
        )
        register_active_for_test(valid_tool(runner=runner(fake_tool_argv(output))), base_dir=self.tools_dir)
        decision = run_tool(
            "ts-adapter",
            {},
            "cycle-1",
            workspace_root=self.root,
            base_dir=self.tools_dir,
        )
        self.assertEqual(decision["action"], "quarantine")
        self.assertEqual(self.latest_run()["status"], "evidence_error")

    def test_tool_runner_invalid_json_or_missing_required_output_quarantines_tool(self):
        register_active_for_test(valid_tool(runner=runner(invalid_json_argv())), base_dir=self.tools_dir)
        decision = run_tool(
            "ts-adapter",
            {},
            "cycle-1",
            workspace_root=self.root,
            base_dir=self.tools_dir,
        )
        self.assertEqual(decision["action"], "quarantine")
        self.assertEqual(self.latest_run()["status"], "schema_error")

        self.tools_dir = Path(self.tmp.name) / "aria-tools-missing"
        register_active_for_test(
            valid_tool(runner=runner(fake_tool_argv({"observations": []}))),
            base_dir=self.tools_dir,
        )
        decision = run_tool(
            "ts-adapter",
            {},
            "cycle-1",
            workspace_root=self.root,
            base_dir=self.tools_dir,
        )
        self.assertEqual(decision["action"], "quarantine")
        self.assertEqual(self.latest_run()["status"], "schema_error")

    def test_tool_runner_nonzero_exit_records_crash(self):
        register_active_for_test(
            valid_tool(runner=runner(fake_tool_argv(valid_tool_output(), exit_code=3))),
            base_dir=self.tools_dir,
        )
        decision = run_tool(
            "ts-adapter",
            {},
            "cycle-1",
            workspace_root=self.root,
            base_dir=self.tools_dir,
        )
        self.assertEqual(decision["action"], "none")
        self.assertEqual(self.latest_run()["status"], "crash")

    def test_tool_runner_timeout_records_budget_exceeded(self):
        register_active_for_test(
            valid_tool(runner=runner(fake_tool_argv(valid_tool_output(), sleep_seconds=1), timeout_ms=25)),
            base_dir=self.tools_dir,
        )
        decision = run_tool(
            "ts-adapter",
            {},
            "cycle-1",
            workspace_root=self.root,
            base_dir=self.tools_dir,
        )
        self.assertEqual(decision["action"], "none")
        self.assertEqual(self.latest_run()["status"], "budget_exceeded")

    def test_tool_runner_repository_mutation_quarantines_tool(self):
        register_active_for_test(
            valid_tool(runner=runner(fake_tool_argv(valid_tool_output(), mutate=True))),
            base_dir=self.tools_dir,
        )
        decision = run_tool(
            "ts-adapter",
            {},
            "cycle-1",
            workspace_root=self.root,
            base_dir=self.tools_dir,
        )
        self.assertEqual(decision["action"], "quarantine")
        run = self.latest_run()
        self.assertTrue(run["evidence_validation"]["repository_mutation_attempt"])

    def test_tool_runner_shadow_and_calibrate_do_not_emit_operator_facing_output(self):
        register_active_for_test(valid_tool(status="SHADOW"), base_dir=self.tools_dir)
        run_tool(
            "ts-adapter",
            {},
            "cycle-1",
            workspace_root=self.root,
            base_dir=self.tools_dir,
        )
        run = self.latest_run()
        self.assertEqual(run["emitted_counts"]["observations"], 0)
        self.assertEqual(run["emitted_counts"]["findings"], 0)

        self.tools_dir = Path(self.tmp.name) / "aria-tools-calibrate"
        register_active_for_test(valid_tool(status="CALIBRATE"), base_dir=self.tools_dir)
        run_tool(
            "ts-adapter",
            {},
            "cycle-1",
            workspace_root=self.root,
            base_dir=self.tools_dir,
        )
        run = self.latest_run()
        self.assertEqual(run["emitted_counts"]["observations"], 0)
        self.assertEqual(run["emitted_counts"]["findings"], 0)

    def test_tool_runner_refuses_quarantined_tool(self):
        register_active_for_test(valid_tool(status="QUARANTINED"), base_dir=self.tools_dir)
        with self.assertRaisesRegex(GovernanceError, "QUARANTINED"):
            run_tool(
                "ts-adapter",
                {},
                "cycle-1",
                workspace_root=self.root,
                base_dir=self.tools_dir,
            )

    def test_three_noncritical_false_positives_move_tool_to_calibrate(self):
        register_active_for_test(valid_tool(), base_dir=self.tools_dir)
        for idx in range(3):
            decision = record_run(
                valid_run(
                    run_id=f"run-{idx}",
                    operator_feedback_refs=[{"kind": "false_positive", "severity": "medium"}],
                ),
                base_dir=self.tools_dir,
            )
        self.assertEqual(decision["action"], "calibrate")
        self.assertEqual(get_tool("ts-adapter", base_dir=self.tools_dir)["status"], "CALIBRATE")

    def test_budget_cap_exceeded_twice_moves_tool_to_calibrate(self):
        register_active_for_test(valid_tool(), base_dir=self.tools_dir)
        record_run(valid_run(run_id="budget-1", cost_units=51), base_dir=self.tools_dir)
        decision = record_run(valid_run(run_id="budget-2", cost_units=52), base_dir=self.tools_dir)
        self.assertEqual(decision["action"], "calibrate")
        self.assertEqual(decision["metrics"]["budget_exceeded_7d"], 2)

    def test_critical_false_positive_moves_tool_to_quarantined(self):
        register_active_for_test(valid_tool(), base_dir=self.tools_dir)
        decision = record_run(
            valid_run(operator_feedback_refs=[{"kind": "false_positive", "severity": "critical"}]),
            base_dir=self.tools_dir,
        )
        self.assertEqual(decision["action"], "quarantine")
        self.assertEqual(get_tool("ts-adapter", base_dir=self.tools_dir)["status"], "QUARANTINED")

    def test_quarantined_tool_cannot_emit_operator_facing_findings(self):
        register_active_for_test(valid_tool(status="QUARANTINED"), base_dir=self.tools_dir)
        with self.assertRaisesRegex(GovernanceError, "cannot emit"):
            record_run(valid_run(emitted_findings=[{"id": "finding-1"}]), base_dir=self.tools_dir)

    def test_calibrated_tool_cannot_return_to_active_without_fixtures(self):
        register_active_for_test(valid_tool(status="CALIBRATE"), base_dir=self.tools_dir)
        # Plan 026R §E.10 — error message now
        # ``tool_lifecycle_forbidden_active_promotion``; accept the
        # legacy "pass through SHADOW" message too for forward-compat.
        with self.assertRaisesRegex(
            GovernanceError,
            "pass through SHADOW|tool_lifecycle_forbidden_active_promotion",
        ):
            transition_tool(
                "ts-adapter",
                "ACTIVE",
                reason="operator override",
                base_dir=self.tools_dir,
            )
        with self.assertRaisesRegex(GovernanceError, "fixture_suite_passed"):
            transition_tool("ts-adapter", "SHADOW", reason="fixed", base_dir=self.tools_dir)

    def test_fixture_runner_and_strict_promotion_gate(self):
        fixture_root = self.tools_dir / "fixtures/ts-adapter/cases"
        fixture_root.mkdir(parents=True)
        (fixture_root / "clean.json").write_text(
            json.dumps(
                {
                    "input": {},
                    "expected": {
                        "status": "ok",
                        "required_observation_values": [
                            {
                                "type": "schema_catalog",
                                "name": "FARM_EVENT_SCHEMAS",
                                "eventCount": 10,
                            }
                        ],
                        "max_findings": 0,
                    },
                }
            ),
            encoding="utf-8",
        )
        register_active_for_test(
            valid_tool(
                status="CALIBRATE",
                runner=runner(
                    fake_tool_argv(
                        valid_tool_output(
                            observations=[
                                {
                                    "id": "obs-schema-catalog",
                                    "type": "schema_catalog",
                                    "name": "FARM_EVENT_SCHEMAS",
                                    "eventCount": 10,
                                }
                            ],
                            findings=[],
                        )
                    )
                ),
            ),
            base_dir=self.tools_dir,
        )
        result = run_fixture_suite(
            "ts-adapter",
            workspace_root=self.root,
            cycle_id="fixture-cycle",
            base_dir=self.tools_dir,
        )
        self.assertTrue(result["passed"])
        self.assertTrue(latest_fixture_status("ts-adapter", base_dir=self.tools_dir)["current_tool_passed"])
        promoted = promote_tool(
            "ts-adapter",
            "SHADOW",
            reason="fixture suite passed",
            base_dir=self.tools_dir,
        )
        self.assertEqual(promoted["status"], "SHADOW")

    def test_old_fixture_pass_is_not_current_after_tool_manifest_change(self):
        fixture_root = self.tools_dir / "fixtures/ts-adapter/cases"
        fixture_root.mkdir(parents=True)
        (fixture_root / "clean.json").write_text(
            json.dumps({"input": {}, "expected": {"status": "ok", "max_findings": 0}}),
            encoding="utf-8",
        )
        register_active_for_test(
            valid_tool(status="CALIBRATE", runner=runner(fake_tool_argv(valid_tool_output(findings=[])))),
            base_dir=self.tools_dir,
        )
        run_fixture_suite("ts-adapter", workspace_root=self.root, cycle_id="fixture-cycle", base_dir=self.tools_dir)
        changed = valid_tool(
            status="CALIBRATE",
            version="1.0.1",
            runner=runner(fake_tool_argv(valid_tool_output(findings=[]))),
        )
        register_tool(changed, base_dir=self.tools_dir)
        status = latest_fixture_status("ts-adapter", base_dir=self.tools_dir)
        self.assertTrue(status["passed"])
        self.assertFalse(status["current_tool_passed"])
        with self.assertRaisesRegex(GovernanceError, "current tool version"):
            promote_tool("ts-adapter", "SHADOW", reason="stale fixture should not promote", base_dir=self.tools_dir)

    def test_feedback_judge_samples_shadow_raw_findings_by_rule_bucket(self):
        register_active_for_test(valid_tool(status="SHADOW"), base_dir=self.tools_dir)
        output = valid_tool_output(
            findings=[
                {"id": "f-1", "rule": "a", "severity": "medium", "path": "apps/farm-service/src/app.module.ts", "evidence": [{"path": "apps/farm-service/src/app.module.ts", "line": 1}]},
                {"id": "f-2", "rule": "b", "severity": "medium", "path": "apps/farm-service/src/app.module.ts", "evidence": [{"path": "apps/farm-service/src/app.module.ts", "line": 1}]},
                {"id": "f-3", "rule": "a", "severity": "medium", "path": "apps/farm-service/src/app.module.ts", "evidence": [{"path": "apps/farm-service/src/app.module.ts", "line": 1}]},
            ],
        )
        register_active_for_test(valid_tool(status="SHADOW", runner=runner(fake_tool_argv(output))), base_dir=self.tools_dir)
        run_tool("ts-adapter", {}, "cycle-judge", workspace_root=self.root, base_dir=self.tools_dir)
        sample = generate_judgment_sample(
            tool_id="ts-adapter",
            sample_size=2,
            cycle_id="cycle-judge",
            base_dir=self.tools_dir,
        )
        self.assertEqual(sample["status"], "pending")
        self.assertEqual(sample["sampled_count"], 2)
        self.assertEqual({item["rule"] for item in sample["items"]}, {"a", "b"})

    def test_operator_feedback_store_contributes_to_health_metrics(self):
        register_active_for_test(valid_tool(), base_dir=self.tools_dir)
        record_run(valid_run(run_id="feedback-run"), base_dir=self.tools_dir)
        record_operator_feedback(
            tool_id="ts-adapter",
            run_id="feedback-run",
            finding_id="finding-1",
            verdict="false_positive",
            severity="medium",
            note="operator rejected",
            base_dir=self.tools_dir,
        )
        decision = record_run(valid_run(run_id="after-feedback"), base_dir=self.tools_dir)
        self.assertEqual(decision["metrics"]["judged_samples"], 1)
        self.assertEqual(decision["metrics"]["precision"], 0.0)

    def test_cli_register_list_and_quarantine(self):
        # Plan 023 v3 §C-3 — first registration must land in an
        # initial-lifecycle state. The CLI fixture writes status=SHADOW;
        # the list assertion targets SHADOW (not ACTIVE) since the test
        # only exercises the register/list/quarantine pipeline, not the
        # SHADOW→ACTIVE promotion (covered separately by transition tests).
        fixture = self.tools_dir / "tool.json"
        fixture.parent.mkdir(parents=True, exist_ok=True)
        fixture.write_text(json.dumps(valid_tool(status="SHADOW")), encoding="utf-8")
        self.assertEqual(
            self.run_cli(["--tools-dir", str(self.tools_dir), "tool", "register", "--file", str(fixture)]),
            0,
        )
        self.assertEqual(
            self.run_cli(["--tools-dir", str(self.tools_dir), "tool", "list", "--status", "SHADOW"]),
            0,
        )
        self.assertEqual(
            self.run_cli(
                [
                    "--tools-dir",
                    str(self.tools_dir),
                    "tool",
                    "quarantine",
                    "--tool-id",
                    "ts-adapter",
                    "--reason",
                    "manual safety gate",
                ],
            ),
            0,
        )
        self.assertEqual(get_tool("ts-adapter", base_dir=self.tools_dir)["status"], "QUARANTINED")

    def test_cli_tool_run_records_health_decision(self):
        # Plan 023 v3 §C-3 — register at SHADOW via CLI, then run_tool
        # against the SHADOW tool. SHADOW tools execute via the runner
        # (they just don't emit operator-facing observations/findings),
        # so the CLI run path is exercisable without ACTIVE promotion.
        fixture = self.tools_dir / "tool.json"
        fixture.parent.mkdir(parents=True, exist_ok=True)
        fixture.write_text(json.dumps(valid_tool(status="SHADOW")), encoding="utf-8")
        self.assertEqual(
            self.run_cli(["--tools-dir", str(self.tools_dir), "tool", "register", "--file", str(fixture)]),
            0,
        )
        self.assertEqual(
            self.run_cli(
                [
                    "--tools-dir",
                    str(self.tools_dir),
                    "tool",
                    "run",
                    "--tool-id",
                    "ts-adapter",
                    "--input",
                    '{"target":"farm"}',
                    "--cycle-id",
                    "cycle-cli",
                    "--workspace-root",
                    str(self.root),
                ],
            ),
            0,
        )
        self.assertEqual(self.latest_run()["cycle_id"], "cycle-cli")

    def run_cli(self, argv):
        with redirect_stdout(StringIO()), redirect_stderr(StringIO()):
            return main(argv)

    def latest_run(self):
        rows = (self.tools_dir / "runs.jsonl").read_text(encoding="utf-8").strip().splitlines()
        return json.loads(rows[-1])


if __name__ == "__main__":
    unittest.main()
