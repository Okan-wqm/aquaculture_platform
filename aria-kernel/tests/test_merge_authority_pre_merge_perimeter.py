"""ORPHAN-HIGH-764 — the pre-merge perimeter, wired where ADR-041 promised it.

Static pin: merge_authority runs the hard-fail registry under GATE_PRE_MERGE.
Before the fix the gate was defined and default-gated but no production path
invoked it — the only perimeter callsites were pr_manager's GATE_PRE_PR_OPEN
pair, so ADR-041 decision 3's "fresh pre-merge re-check" existed in prose only.

Behavioral pin: a perimeter refusal stops the merge. All seven GATE_PRE_MERGE
checks consume native evidence — unwaived plan-time coverage, the accepted
expert panel, the operator-feedback ingestion the merged plan's synthesis
was bound to, and the hook's turn-budget verdicts (cycle_and_turn_budget_cap).
Waiver adjudication and current graph reattestation are not established by
the coverage fixture, and its plan is started directly rather than through
the pressure-source provider, so the operator-feedback predicate refuses it
by name (no synthesis binding).
The original controls preserve the structural property: perimeter blocked
means no merge side effect, and the decision ledger records the block at
stage pre_merge_perimeter. Native controls separately exercise real
request/result binding and the normal caller, with explicit fixture limits.
"""
from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from aria_kernel.merge_authority import merge_pr_if_ready
from aria_kernel.tool_registry import ensure_tools_dir

_SHA = "a" * 40
_SOURCE = Path(__file__).resolve().parents[1] / "aria_kernel" / "merge_authority.py"


class _Adapter:
    """London-school fake: records the merge side effect, nothing else."""

    def __init__(self) -> None:
        self.merged: list[int] = []

    def get_pr(self, pr_number: int) -> dict:
        return {
            "number": pr_number,
            "repository": "okan/aqua",
            "base_branch": "main",
            "head_ref": "feat/x",
            "head_sha": _SHA,
            "changed_files": ["aria-kernel/aria_kernel/merge_authority.py"],
        }

    def merge_pr(self, pr_number: int, **kwargs) -> dict:
        self.merged.append(pr_number)
        return {"merged": True}


def _gate_patches(head_sha: str = _SHA):
    """Every gate before the perimeter passes; the perimeter is the test."""
    return [
        patch(
            "aria_kernel.merge_authority.enforce_profile_for_action",
            return_value="autonomous",
        ),
        patch(
            "aria_kernel.merge_authority.assert_merge_not_watchdog_frozen",
            return_value=None,
        ),
        patch(
            "aria_kernel.merge_authority.record_risk_decision_for_pr",
            return_value={"valid": True, "lane": "L1", "policy_hash": "ph"},
        ),
        patch(
            "aria_kernel.merge_authority.assert_autonomy_unlocked",
            return_value=SimpleNamespace(counts={}),
        ),
        patch(
            "aria_kernel.merge_authority.verify_enterprise_readiness",
            return_value=SimpleNamespace(valid=True, failure_classes=(), reasons=[]),
        ),
        patch(
            "aria_kernel.merge_authority.verify_runner_attestation",
            return_value={},
        ),
        patch(
            "aria_kernel.merge_authority.verify_rollback_bundle",
            return_value={},
        ),
        patch(
            "aria_kernel.merge_authority.ensure_pre_merge_incident_row",
            return_value={"ledger_hash": "x"},
        ),
        patch(
            "aria_kernel.merge_authority._merge_if_green_with_executor",
            return_value={"decision": "proceed", "eligible": True, "head_sha": head_sha},
        ),
        patch(
            "aria_kernel.merge_authority._evaluate_triple_gate",
            return_value={"passed": True, "change_id": "c1"},
        ),
        patch(
            "aria_kernel.merge_authority.collect_github_snapshot",
            return_value={},
        ),
        patch(
            "aria_kernel.merge_authority.evaluate_auto_merge",
            return_value={"eligible": True, "head_sha": head_sha},
        ),
    ]


class PreMergePerimeterTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.tools = Path(self.tmp.name) / "aria-tools"
        ensure_tools_dir(self.tools)

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def test_merge_authority_runs_the_pre_merge_gate(self) -> None:
        source = _SOURCE.read_text(encoding="utf-8")
        self.assertIn("run_hard_fail_checks", source)
        self.assertIn("GATE_PRE_MERGE", source)

    def test_perimeter_refusal_blocks_the_merge_side_effect(self) -> None:
        adapter = _Adapter()
        patches = _gate_patches()
        for p in patches:
            p.start()
        try:
            result = merge_pr_if_ready(
                adapter=adapter,
                pr_number=77,
                base_dir=self.tools,
                readiness_claim_id="claim:77:aaaaaaaaaaaa",
            )
        finally:
            for p in patches:
                p.stop()
        self.assertEqual(result["decision"], "blocked")
        self.assertEqual(result["stage"], "pre_merge_perimeter")
        reasons = list(result["reasons"])
        self.assertIn("pre_merge_perimeter_blocked", reasons)
        # Every pre-merge predicate is live and answers from native evidence;
        # a fixture with no implementation binding is refused by name by all
        # seven, never by a placeholder.
        perimeter_reasons = [reason for reason in reasons if reason != "pre_merge_perimeter_blocked"]
        self.assertEqual(len(perimeter_reasons), 7, reasons)
        self.assertTrue(
            all(reason.endswith(":native_implementation_binding_unavailable") for reason in perimeter_reasons),
            reasons,
        )
        self.assertEqual(adapter.merged, [])

    def test_passing_perimeter_leaves_the_merge_path_unchanged(self) -> None:
        adapter = _Adapter()
        patches = _gate_patches() + [
            patch(
                "aria_kernel.merge_authority.run_hard_fail_checks",
                return_value=SimpleNamespace(passed=True, failures=()),
            ),
        ]
        for p in patches:
            p.start()
        try:
            result = merge_pr_if_ready(
                adapter=adapter,
                pr_number=77,
                base_dir=self.tools,
                readiness_claim_id="claim:77:aaaaaaaaaaaa",
            )
        finally:
            for p in patches:
                p.stop()
        self.assertEqual(result["decision"], "merged")
        self.assertEqual(adapter.merged, [77])


class NativePreMergeContextTests(unittest.TestCase):
    def test_native_change_without_request_keeps_verified_context_and_explicit_gap(self) -> None:
        import os
        import subprocess

        import aria_kernel.merge_authority as merge_owner
        from aria_kernel.auto_merge import change_for_pr, record_pr_lifecycle
        from aria_kernel.change_ledger import emit_change_committed, emit_change_planned
        from aria_kernel.plan_convergence import plan_status
        from aria_kernel.runtime_profile import set_profile
        from aria_kernel.snapshot import build_repo_snapshot
        from aria_kernel.tool_registry import ensure_tools_binding
        from aria_kernel.workspace import canonical_identity
        from tests._helpers.git_fixtures import make_repo_with_initial_commit
        from tests._helpers.production_shaped import production_converged_plan

        fixture_directory = tempfile.TemporaryDirectory(prefix="aria-pre-merge-context-")
        self.addCleanup(fixture_directory.cleanup)
        root = Path(fixture_directory.name)
        environment = patch.dict(os.environ, {
            "ARIA_REPO_STATE_ROOT": str(root / "repo-state"),
            "ARIA_STATE_STORE_ROOT": str(root / "state-store"),
            "ARIA_WORKSPACE_BASE": str(root / "workspaces"),
            "ARIA_TOOLS_DIR": str(root / "store" / "tools"),
        })
        environment.start()
        self.addCleanup(environment.stop)
        source_path = "apps/farm-service/src/sample-interval.ts"
        repo = make_repo_with_initial_commit(root, {
            source_path: "export const sampleIntervalMs = 30000;\n",
        })
        tools = root / "store" / "tools"
        set_profile("strict", operator_approval_ref="test:pre-merge-context", base_dir=tools)
        ensure_tools_binding(tools, workspace_root=repo)
        plan = production_converged_plan(
            tools_dir=tools, workspace_root=repo,
            plan_id="plan-native-pre-merge-context", affected_paths=[source_path],
            evidence_refs=[source_path],
        )

        def git(*argv: str) -> str:
            return subprocess.check_output(["git", *argv], cwd=repo, text=True).strip()

        git("add", ".claude/agents/farm-expert.md")
        git("commit", "-q", "-m", "fixture: commit the real plan reviewer")
        git("branch", "-M", "main")
        base_sha = git("rev-parse", "HEAD")
        planned = emit_change_planned(
            plan_id=plan.plan_id, finding_id="F-native-pre-merge-context",
            intended_affected_files=[source_path], intended_validation_refs=[],
            architectural_tier=1, base_dir=tools,
        )
        git("checkout", "-q", "-b", "aria/native-pre-merge-context")
        (repo / source_path).write_text(
            "export const sampleIntervalMs = 15000;\n", encoding="utf-8",
        )
        git("add", source_path)
        git("commit", "-q", "-m", "fixture: change the declared sample interval")
        head_sha = git("rev-parse", "HEAD")
        committed = emit_change_committed(
            change_id=planned["change_id"], commit_sha=head_sha,
            actual_affected_files=[source_path], base_dir=tools,
        )
        pr = {
            "number": 731, "base_branch": "main", "base_sha": base_sha,
            "head_ref": "aria/native-pre-merge-context", "head_sha": head_sha,
            "changed_files": [source_path], "change_id": planned["change_id"],
            "body": "Apply the converged sample-interval change.",
        }
        observed = record_pr_lifecycle(pr, base_dir=tools)
        snapshot = build_repo_snapshot(workspace_root=repo, mode="committed")
        self.assertEqual(change_for_pr(731, base_dir=tools), planned["change_id"])
        self.assertEqual(plan_status(plan_id=plan.plan_id, base_dir=tools)["state"], "CONVERGED")
        self.assertIsNone(planned["intended_request_id"])
        self.assertEqual(committed["commit_sha"], head_sha)
        self.assertEqual(git("diff", "--name-only", base_sha, head_sha), source_path)
        self.assertEqual(snapshot["base_commit_sha"], head_sha)
        self.assertNotEqual(base_sha, head_sha)
        for row in (planned, committed, observed):
            self.assertRegex(row["ledger_hash"], r"^sha256:[0-9a-f]{64}$")

        # Missing optional native context capability is the initial RED;
        # this fixture has not produced an implementation request or claim.
        capture = getattr(merge_owner, "_capture_pre_merge_context", None)
        self.assertTrue(callable(capture), "native pre-merge context producer is absent")
        before = {
            str(path.relative_to(tools)): path.read_bytes()
            for path in tools.rglob("*") if path.is_file()
            and path.suffix in {".json", ".jsonl"}
        }
        context = capture(
            workspace_root=repo, base_dir=tools, pr=pr,
            diff_text=git("diff", base_sha, head_sha),
        )
        self.assertEqual(context.workspace_root, repo.resolve())
        self.assertEqual(context.pr_body, pr["body"])
        self.assertEqual(context.base_branch, "main")
        evidence = context.pre_merge_evidence
        self.assertFalse(evidence.available)
        self.assertIn("implementation_request_unavailable", evidence.unavailable_reasons)
        self.assertIsNone(evidence.request_id)
        self.assertIsNone(evidence.claim_id)
        self.assertEqual(evidence.pr_number, 731)
        self.assertEqual(evidence.change_id, planned["change_id"])
        self.assertEqual(evidence.pr_row_hash, observed["ledger_hash"])
        self.assertEqual(evidence.planned_row_hash, planned["ledger_hash"])
        self.assertEqual(evidence.committed_row_hash, committed["ledger_hash"])
        self.assertEqual(evidence.plan_id, plan.plan_id)
        self.assertEqual(evidence.plan_revision_id, plan.revision_id)
        self.assertEqual(evidence.plan_content_hash, plan.content_hash)
        self.assertEqual(evidence.repo_identity, canonical_identity(repo))
        self.assertEqual(evidence.base_sha, base_sha)
        self.assertEqual(evidence.head_sha, head_sha)
        self.assertEqual(evidence.snapshot_hash, snapshot["snapshot_hash"])
        self.assertEqual({
            str(path.relative_to(tools)): path.read_bytes()
            for path in tools.rglob("*") if path.is_file()
            and path.suffix in {".json", ".jsonl"}
        }, before)


class NativeImplementationContextTests(unittest.TestCase):
    def test_native_result_joins_request_and_exact_commit_before_predicates(self) -> None:
        import hashlib
        import json
        import os
        import subprocess
        from contextlib import chdir

        import aria_kernel.merge_authority as merge_owner
        from aria_kernel.agent_invocations import (
            accepted_result_for_request, claim_request, submit_claim_result,
            verify_invocation_context_binding,
        )
        from aria_kernel.apply_engine import stage_converged_plan_for_pr
        from aria_kernel.auto_merge import record_pr_lifecycle
        from aria_kernel.change_ledger import emit_change_committed, get_change_chain
        from aria_kernel.cross_review_bridge import issue_implementation_envelope
        from aria_kernel.gh_token_factory import mint_signing_key
        from aria_kernel.implementation_safety import (
            GATE_PRE_MERGE, _native_implementation_is_bound, run_hard_fail_checks,
            verify_commit_signature,
        )
        from aria_kernel.ledger import load_declared_jsonl
        from aria_kernel.plan_convergence import plan_status
        from aria_kernel.runtime_profile import set_profile
        from aria_kernel.tool_registry import ensure_tools_binding, utc_now
        from aria_kernel.tool_registry import update_tools_index as actual_index_writer
        from aria_kernel.validation import run_validation_commands
        from aria_kernel.validation_runs_ledger import verify_validation_run
        from tests._helpers.git_fixtures import make_repo_with_initial_commit
        from tests._helpers.production_shaped import production_converged_plan

        fixture_directory = tempfile.TemporaryDirectory(prefix="aria-native-implementation-")
        self.addCleanup(fixture_directory.cleanup)
        fixture = Path(fixture_directory.name)
        tools = fixture / "store" / "tools"
        source_path = "apps/farm-service/src/sample-interval.ts"
        check_path = "apps/farm-service/check-sample.cjs"
        selected_repo = Path(__file__).resolve().parents[2]
        native_tool_paths = ("tools/gates/plan-coverage-witness.ts", "tools/gates/tsconfig.json")
        native_tool_bytes = {path: (selected_repo / path).read_bytes() for path in native_tool_paths}
        files = {
            **{path: data.decode("utf-8") for path, data in native_tool_bytes.items()},
            ".gitignore": "/node_modules\n.nx/\naria-debts/\n",
            "package.json": json.dumps({"name": "pre-merge-native-fixture", "private": True,
                "scripts": {"type-check": "tsc --noEmit --pretty false -p tsconfig.json"}}),
            "nx.json": json.dumps({"neverConnectToCloud": True, "plugins": []}),
            "apps/farm-service/project.json": json.dumps({
                "name": "native-implementation-fixture", "root": "apps/farm-service",
                "targets": {
                    "test": {"executor": "nx:run-commands", "cache": False,
                        "options": {"command": "node " + check_path}},
                    "lint": {"executor": "nx:run-commands", "cache": False,
                        "options": {"command": "eslint apps/farm-service/checked.js --format json"}},
                }}),
            "eslint.config.cjs": "module.exports = [{files: ['apps/**/*.js'], rules: {'no-unused-vars': 'error'}}];\n",
            "tsconfig.json": json.dumps({"compilerOptions": {"strict": True, "types": []}, "files": [source_path]}),
            "apps/farm-service/checked.js": "export const sampleUnit = 'milliseconds';\n",
            source_path: "export const sampleIntervalMs: number = 60000;\n",
            check_path: (
                "const fs = require('node:fs');\nconst vm = require('node:vm');\n"
                "const assert = require('node:assert/strict');\nconst ts = require('typescript');\n"
                "const text = fs.readFileSync(__dirname + '/src/sample-interval.ts', 'utf8');\n"
                "const compiled = ts.transpileModule(text, {compilerOptions: {module: ts.ModuleKind.CommonJS}});\n"
                "const context = {exports: {}};\nvm.runInNewContext(compiled.outputText, context);\n"
                "assert.ok(context.exports.sampleIntervalMs > 0 && context.exports.sampleIntervalMs <= 30000);\n"
                "console.log('sample-interval-behavior=' + context.exports.sampleIntervalMs);\n"
            ),
        }
        # Only disposable fixture process configuration changes. Installed
        # Nx/TypeScript/ESLint bytes are used through a local dependency link.
        environment_values = {name: value for name, value in os.environ.items()
            if not name.startswith(("ARIA_", "NX_", "npm_config_", "NPM_CONFIG_"))
            and name != "NODE_OPTIONS"}
        environment_values.update({
            "ARIA_TOOLS_DIR": str(tools), "ARIA_REPO_STATE_ROOT": str(fixture / "repo-state"),
            "ARIA_STATE_STORE_ROOT": str(fixture / "state-store"),
            "ARIA_WORKSPACE_BASE": str(fixture / "workspaces"),
            "NX_DAEMON": "false", "NX_ISOLATE_PLUGINS": "false", "NX_SKIP_NX_CACHE": "true",
            "NX_CACHE_DIRECTORY": str(fixture / "nx-cache"),
            "NX_WORKSPACE_DATA_DIRECTORY": str(fixture / "nx-data"),
            "npm_config_cache": str(fixture / "npm-cache"), "npm_config_offline": "true",
        })
        environment = patch.dict(os.environ, environment_values, clear=True)
        environment.start()
        self.addCleanup(environment.stop)
        repo = make_repo_with_initial_commit(fixture, files)

        def git(*argv: str) -> str:
            return subprocess.check_output(["git", *argv], cwd=repo, text=True).strip()

        initial_sha = git("rev-parse", "HEAD")
        os.environ["NX_BASE"] = initial_sha
        os.environ["NX_HEAD"] = "HEAD"
        installed = Path("/var/aqua-saas/node_modules")
        for package in ("nx", "typescript", "eslint", "ts-node"):
            self.assertTrue((installed / package / "package.json").is_file())
        (repo / "node_modules").symlink_to(installed, target_is_directory=True)
        set_profile("strict", operator_approval_ref="test:native-pre-merge-result", base_dir=tools)
        ensure_tools_binding(tools, workspace_root=repo)
        plan = production_converged_plan(
            tools_dir=tools, workspace_root=repo, plan_id="plan-native-implementation-result",
            affected_paths=[source_path], evidence_refs=[source_path], with_coverage=True,
        )
        self.assertEqual(plan.plan_content["schema_version"], 2)
        coverage_rows = [row for row in load_declared_jsonl(tools / "plans" / "events.jsonl",
            expected_surface="plan_convergence_events")
            if row["plan_id"] == plan.plan_id and row["event_type"] == "coverage_computed"]
        self.assertEqual(len(coverage_rows), 1)
        coverage_event = coverage_rows[0]
        coverage_payload = coverage_event["payload"]
        self.assertEqual(coverage_payload["verdict"], "covered")
        self.assertEqual(coverage_payload["witness"]["exit_code"], 0)
        self.assertEqual(coverage_payload["witness"]["tool"], native_tool_paths[0])
        self.assertEqual(coverage_payload["target_revision_id"], plan.revision_id)
        self.assertEqual(coverage_payload["target_plan_content_hash"], plan.content_hash)
        self.assertEqual(coverage_payload["computed_at_sha"], initial_sha)
        self.assertEqual(coverage_payload["uncovered"], [])
        self.assertEqual(coverage_payload["waived"], [])
        coverage_manifest = tools / "coverage" / (plan.plan_id + "-r1.json")
        coverage_bytes = coverage_manifest.read_bytes()
        self.assertEqual(coverage_payload["closure_manifest_hash"],
            "sha256:" + hashlib.sha256(coverage_bytes).hexdigest())
        self.assertEqual([project["name"] for project in json.loads(coverage_bytes)["closure"]["projects"]],
            ["native-implementation-fixture"])
        for path, expected_bytes in native_tool_bytes.items():
            self.assertEqual((repo / path).read_bytes(), expected_bytes)
            self.assertEqual(subprocess.check_output(["git", "show", initial_sha + ":" + path], cwd=repo),
                expected_bytes)
        (repo / source_path).write_text("export const sampleIntervalMs: number = 30000;\n", encoding="utf-8")
        git("add", source_path, ".claude/agents/farm-expert.md")
        git("commit", "-q", "-m", "fixture: committed converged baseline")
        git("branch", "-M", "main")
        self.assertEqual(git("status", "--porcelain"), "")
        staged = stage_converged_plan_for_pr(plan_id=plan.plan_id, workspace_root=repo, base_dir=tools)
        planned = get_change_chain(change_id=staged["change_id"], base_dir=tools)["planned"]
        self.assertIsNone(planned["intended_request_id"])
        self.assertEqual(staged["base_sha"], git("rev-parse", "HEAD"))
        request = issue_implementation_envelope(
            plan_id=plan.plan_id, cross_review_revision_id=plan.revision_id,
            cross_review_summary_text="Direct native convergence fixture; no separate expert panel.",
            proposal_id=staged["proposal_id"], change_id=staged["change_id"],
            branch=staged["branch"], base_sha=staged["base_sha"], base_dir=tools,
        )
        self.assertEqual(request["implementation_ids"]["change_id"], staged["change_id"])
        self.assertEqual(request["plan_revision_hash"], plan.content_hash)
        claim = claim_request(request_id=request["request_id"], agent_id="native-implementation-worker",
            lease_seconds=1800, base_dir=tools)
        # cycle_and_turn_budget_cap — the implementer's spawn ran under the
        # kernel hook with the compiled cap (claude_settings → --turn-budget);
        # its admitted Edit/Write/Bash verdicts on hooks/decisions.jsonl are
        # the evidence the seventh predicate reads. No job deadline is bound
        # in this fixture's cleared environment, exactly like the executor
        # lane, whose cycle cap is the pre-spawn dispatch gate.
        from aria_kernel import hooks as kernel_hooks
        from aria_kernel.turn_budget import IMPLEMENTER_TURN_BUDGET

        def implementer_turn(tool_use_id: str) -> int:
            hook_exit, _ = kernel_hooks.run_hook(
                "pre-tool",
                {"session_id": "sess-native-implementation", "tool_use_id": tool_use_id,
                 "hook_event_name": "PreToolUse", "tool_name": "Bash",
                 "tool_input": {"command": "git status --porcelain"}, "cwd": str(repo)},
                base_dir=tools, workspace_root=repo, request_id=request["request_id"],
                turn_budget=IMPLEMENTER_TURN_BUDGET,
            )
            return hook_exit

        for turn in range(3):
            self.assertEqual(implementer_turn(f"toolu_impl_{turn}"), kernel_hooks.EXIT_ALLOW)
        hook_rows = load_declared_jsonl(tools.joinpath(*kernel_hooks.HOOK_DECISIONS_RELPATH),
            expected_surface=kernel_hooks.HOOK_DECISIONS_SURFACE)
        self.assertEqual([row["turn_budget"]["used_before"] for row in hook_rows], [0, 1, 2])
        signer = mint_signing_key(cycle_id="cyc-native-pre-merge", workspace_root=repo)
        git("checkout", "-q", "-b", staged["branch"])
        (repo / source_path).write_text("export const sampleIntervalMs: number = 20000;\n", encoding="utf-8")
        git("add", source_path)
        git("commit", "-q", "-m", "fixture: first implementation commit")
        earlier_sha = git("rev-parse", "HEAD")
        (repo / source_path).write_text("export const sampleIntervalMs: number = 15000;\n", encoding="utf-8")
        git("add", source_path)
        git("commit", "-q", "-m", "fixture: complete implementation commit")
        head_sha = git("rev-parse", "HEAD")
        committed = emit_change_committed(change_id=staged["change_id"], commit_sha=head_sha,
            actual_affected_files=[source_path], claim_id=claim["claim_id"], base_dir=tools)
        self.assertNotEqual(earlier_sha, head_sha)
        self.assertEqual(git("rev-list", "--count", staged["base_sha"] + ".." + head_sha), "2")
        self.assertTrue(verify_commit_signature(earlier_sha, signer.fingerprint, repo=repo))
        self.assertTrue(verify_commit_signature(head_sha, signer.fingerprint, repo=repo))
        commands = ["npx nx affected --target=test", "npx nx affected --target=lint", "npm run type-check"]
        candidate = run_validation_commands(commands=commands, workspace_root=repo,
            change_id=staged["change_id"], commit_sha=head_sha,
            runner_identity="fixture:pre-merge-native-candidate", timeout_ms=120000, base_dir=tools)
        native_runs = [verify_validation_run(run_id, base_dir=tools) for run_id in candidate["validation_run_ids"]]
        self.assertEqual(candidate["status"], "ok", json.dumps([{
            "cmd": row["cmd"], "exit_code": row["exit_code"],
            "native_log_tail": Path(row["log_path"]).read_text(encoding="utf-8")[-1600:],
        } for row in native_runs]))
        self.assertEqual([row["cmd"] for row in native_runs], commands)
        self.assertTrue(all(row["commit_sha"] == head_sha and row["exit_code"] == 0 for row in native_runs))
        test_log = Path(native_runs[0]["log_path"]).read_text(encoding="utf-8")
        self.assertIn("sample-interval-behavior=15000", test_log)
        baseline_rows = [row for row in load_declared_jsonl(tools / "validation" / "validation-runs.jsonl",
            expected_surface="validation_runs") if row["commit_sha"] == staged["base_sha"]]
        self.assertEqual(len(baseline_rows), 3)
        for row in baseline_rows:
            self.assertEqual(verify_validation_run(row["validation_run_id"], base_dir=tools), row)
            self.assertEqual(row["exit_code"], 0)
        self.assertTrue(any("sample-interval-behavior=30000" in Path(row["log_path"]).read_text(encoding="utf-8")
            for row in baseline_rows))
        diff_text = git("diff", staged["base_sha"], head_sha)
        pr_url = "https://github.com/fixture/native-context/pull/732"
        response = {
            "$schema": "aria/agent-response/v1", "request_id": request["request_id"],
            "claim_id": claim["claim_id"], "agent_id": claim["agent_id"],
            "role": "implementation", "status": "submitted",
            "satisfaction_matrix": [{"id": entry["id"], "verdict": "satisfied", "evidence_refs": [source_path + ":1"]}
                for entry in request["must_satisfy"]],
            "evidence_refs": [source_path + ":1"],
            "details": {"implementation": {
                "claim_id": claim["claim_id"], "pr_url": pr_url,
                "diff_hash": "sha256:" + hashlib.sha256(diff_text.encode()).hexdigest(),
                "branch_tip_sha": head_sha, "base_branch_sha": staged["base_sha"],
                "validation_results": [{"cmd": row["cmd"], "exit_code": row["exit_code"],
                    "log_path": row["log_path"], "log_hash": row["log_hash"]} for row in native_runs],
                "signer_key_fp": signer.fingerprint, "completed_at": utc_now(),
            }},
        }
        output = Path(request["expected_output_path"])
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_text(json.dumps(response), encoding="utf-8")
        transcript = fixture / "native-worker-transcript.txt"
        transcript.write_text("Fixture worker used the real staged request, signed commits and native validation runs.\n", encoding="utf-8")
        # The existing implementation result bridge invokes Git at its process
        # cwd. Exercise its normal workspace cwd; do not replace its verifier.
        with chdir(repo):
            submitted = submit_claim_result(claim_id=claim["claim_id"], agent_id=claim["agent_id"],
                lease_token=claim["lease_token"], output_path=output, workspace_root=repo, base_dir=tools,
                context_hash=request["context_hash"], prompt_hash=request["prompt_hash"],
                transcript_hash="sha256:" + hashlib.sha256(transcript.read_bytes()).hexdigest(),
                transcript_artifact_ref=str(transcript), evidence_target_sha=head_sha)
        self.assertEqual(submitted["status"], "accepted")
        self.assertEqual(submitted["bridged"]["bridge_errors"], [])
        self.assertEqual(plan_status(plan_id=plan.plan_id, base_dir=tools)["state"], "IMPLEMENTATION_RECORDED")
        self.assertEqual(accepted_result_for_request(request_id=request["request_id"], base_dir=tools)["ledger_hash"],
            submitted["row"]["ledger_hash"])
        pr = {"number": 732, "base_branch": "main", "base_sha": staged["base_sha"],
            "head_ref": staged["branch"], "head_sha": head_sha, "body": "Native implementation result fixture.",
            "changed_files": [source_path], "change_id": staged["change_id"],
            "proposal_id": staged["proposal_id"], "url": pr_url}
        observed = record_pr_lifecycle(pr, base_dir=tools)
        with patch("aria_kernel.tool_registry.update_tools_index", wraps=actual_index_writer) as public_writer:
            public_binding = verify_invocation_context_binding(
                request_id=request["request_id"], context_hash=request["context_hash"],
                prompt_hash=request["prompt_hash"], base_dir=tools,
            )
        self.assertGreater(public_writer.call_count, 0)
        self.assertEqual(public_binding["context"]["ledger_hash"], request["context_ledger_hash"])
        self.assertEqual(public_binding["prompt"]["prompt_hash"], request["prompt_hash"])
        native_before = {str(path.relative_to(tools)): path.read_bytes()
            for path in tools.rglob("*") if path.is_file() and path.suffix in {".json", ".jsonl"}}
        with patch("aria_kernel.tool_registry.update_tools_index", wraps=actual_index_writer) as capture_writer:
            context = merge_owner._capture_pre_merge_context(workspace_root=repo, base_dir=tools, pr=pr, diff_text=diff_text)
        capture_writer.assert_not_called()
        evidence = context.pre_merge_evidence
        self.assertEqual(evidence.committed_row_hash, committed["ledger_hash"])
        self.assertEqual(evidence.request_id, request["request_id"])
        self.assertEqual(evidence.claim_id, claim["claim_id"])
        self.assertEqual(evidence.result_row_hash, submitted["row"]["ledger_hash"])
        self.assertEqual(evidence.pr_row_hash, observed["ledger_hash"])
        self.assertEqual(evidence.plan_revision_id, plan.revision_id)
        self.assertEqual(evidence.plan_content_hash, plan.content_hash)
        self.assertEqual(evidence.head_sha, head_sha)
        report = run_hard_fail_checks(context, gate=GATE_PRE_MERGE)
        results = {result.name: result for result in report.results}
        self.assertTrue(results["branch_tip_lock_and_recheck"].passed, results["branch_tip_lock_and_recheck"].reason)
        self.assertTrue(results["content_hash_recheck"].passed, results["content_hash_recheck"].reason)
        self.assertTrue(results["per_file_mutual_exclusion"].passed, results["per_file_mutual_exclusion"].reason)
        self.assertTrue(results["plan_coverage_witness_verified"].passed,
            results["plan_coverage_witness_verified"].reason)
        self.assertEqual(evidence.coverage_event_hash, coverage_event["ledger_hash"])
        self.assertEqual(evidence.coverage_manifest_hash, coverage_payload["closure_manifest_hash"])
        self.assertEqual(evidence.coverage_revision_id, plan.revision_id)
        self.assertEqual(evidence.coverage_plan_hash, plan.content_hash)
        self.assertEqual(evidence.coverage_computed_at_sha, initial_sha)
        self.assertTrue(results["cycle_and_turn_budget_cap"].passed, results["cycle_and_turn_budget_cap"].reason)
        self.assertEqual(results["cycle_and_turn_budget_cap"].reason, "native_cycle_and_turn_budget_respected")
        self.assertEqual(evidence.turn_budget_cap, IMPLEMENTER_TURN_BUDGET)
        self.assertEqual(evidence.turn_budget_used, 3)
        self.assertIsNone(evidence.turn_budget_refusal_reason)
        self.assertEqual(evidence.turn_budget_ledger_tip, hook_rows[-1]["ledger_hash"])
        self.assertFalse(report.passed, "this fixture has no native expert panel or synthesis binding")
        # V9.5 check 12 — the plan was started by the fixture, not synthesized
        # through the provider, so there is no synthesis_bound row to walk
        # from; the predicate names that rather than passing on absence.
        self.assertFalse(results["operator_feedback_signature"].passed)
        self.assertEqual(results["operator_feedback_signature"].reason,
            "operator_feedback_synthesis_binding_unavailable")
        self.assertEqual(evidence.operator_feedback_plan_started_hash, plan.content_hash)
        self.assertFalse(evidence.operator_feedback_verified)
        self.assertEqual({str(path.relative_to(tools)): path.read_bytes()
            for path in tools.rglob("*") if path.is_file() and path.suffix in {".json", ".jsonl"}}, native_before)

        # Earlier authority gates are fixture controls. The normal runner,
        # authority capture and seven predicates below execute their real code.
        from contextlib import ExitStack
        from aria_kernel.auto_merge import SnapshotGitHubAdapter
        from aria_kernel.auto_merge_runners import RealAutoMergeRunner

        adapter = SnapshotGitHubAdapter({"pr": pr, "github": {"pr_diff": diff_text}})
        runner = RealAutoMergeRunner(
            profile="autonomous", adapter_factory=lambda: adapter,
            pr_enumerator=lambda selected: [pr["number"]],
            readiness_claim_resolver=lambda selected, number, root: "fixture-readiness-reference",
        )
        observed_reports = []

        def evaluate_actual_context(value, *, gate):
            actual_report = run_hard_fail_checks(value, gate=gate)
            observed_reports.append((value, actual_report))
            return actual_report

        with ExitStack() as stack:
            for gate_patch in _gate_patches(head_sha):
                stack.enter_context(gate_patch)
            capture_call = stack.enter_context(patch(
                "aria_kernel.merge_authority._capture_pre_merge_context",
                wraps=merge_owner._capture_pre_merge_context,
            ))
            stack.enter_context(patch(
                "aria_kernel.merge_authority.run_hard_fail_checks",
                side_effect=evaluate_actual_context,
            ))
            runner_result = runner(base_dir=tools, workspace_root=repo)
        capture_call.assert_called_once()
        self.assertEqual(capture_call.call_args.kwargs["workspace_root"], repo)
        self.assertEqual(capture_call.call_args.kwargs["base_dir"], tools)
        self.assertEqual(capture_call.call_args.kwargs["pr"], pr)
        self.assertEqual(capture_call.call_args.kwargs["diff_text"], diff_text)
        self.assertEqual(len(observed_reports), 1)
        called_context, called_report = observed_reports[0]
        self.assertEqual(called_context.pre_merge_evidence.request_id, request["request_id"])
        self.assertEqual(called_context.pre_merge_evidence.result_row_hash, submitted["row"]["ledger_hash"])
        self.assertEqual(called_context.pr_body, pr["body"])
        called_results = {item.name: item for item in called_report.results}
        self.assertTrue(called_results["branch_tip_lock_and_recheck"].passed)
        self.assertTrue(called_results["content_hash_recheck"].passed)
        self.assertTrue(called_results["per_file_mutual_exclusion"].passed)
        self.assertTrue(called_results["plan_coverage_witness_verified"].passed)
        self.assertTrue(called_results["cycle_and_turn_budget_cap"].passed)
        self.assertEqual({item.name for item in called_report.failures},
            {"operator_feedback_signature", "expert_consensus_evidence_verified"})
        self.assertEqual(runner_result["decisions"][0]["stage"], "pre_merge_perimeter")
        self.assertEqual(runner_result["decisions"][0]["decision"], "blocked")
        self.assertEqual(runner_result["merges_completed"], 0)
        self.assertEqual(runner_result["candidates_evaluated"], 1)
        self.assertFalse(runner_result["dry_run"])
        self.assertEqual(adapter.merge_calls, [])

        # The final perimeter must request review of the accepted implementation,
        # not reuse a pre-worker plan panel or a review of the base commit.
        from aria_kernel.agent_invocations import list_agent_invocation_requests
        expert_requests = list_agent_invocation_requests(
            base_dir=tools, role="specialist_domain_review",
        )
        self.assertEqual(len(expert_requests), 2)
        self.assertEqual({row["target_agent"] for row in expert_requests},
            {"farm-expert", "security-reviewer"})
        for expert_request in expert_requests:
            self.assertEqual(expert_request["convergence_id"], plan.plan_id)
            self.assertEqual(expert_request["plan_revision_hash"], plan.content_hash)
            self.assertEqual(expert_request["target_sha"], head_sha)
            self.assertNotEqual(expert_request["target_sha"], staged["base_sha"])
            self.assertEqual(expert_request["allowed_scope"], [source_path])
            self.assertEqual(expert_request["evidence_refs"], [source_path + ":1"])
            self.assertEqual(expert_request["context_source_paths"], [source_path])
            self.assertEqual(len(expert_request["must_satisfy"]), 1)
            implementation_binding = expert_request["must_satisfy"][0]["implementation_binding"]
            self.assertEqual(implementation_binding["change_id"], staged["change_id"])
            self.assertEqual(implementation_binding["request_id"], request["request_id"])
            self.assertEqual(implementation_binding["claim_id"], claim["claim_id"])
            self.assertEqual(implementation_binding["result_row_hash"], submitted["row"]["ledger_hash"])
            self.assertEqual(implementation_binding["committed_row_hash"], committed["ledger_hash"])
            self.assertEqual(implementation_binding["head_sha"], head_sha)
            self.assertEqual(implementation_binding["base_sha"], staged["base_sha"])
            self.assertEqual(implementation_binding["diff_hash"],
                "sha256:" + hashlib.sha256(diff_text.encode()).hexdigest())
            sealed_expert = verify_invocation_context_binding(
                request_id=expert_request["request_id"], context_hash=expert_request["context_hash"],
                prompt_hash=expert_request["prompt_hash"], base_dir=tools,
            )
            self.assertEqual(sealed_expert["context"]["target_sha"], head_sha)
            self.assertIn(json.dumps(implementation_binding, sort_keys=True),
                sealed_expert["prompt"]["prompt_text"])
            self.assertIsNone(accepted_result_for_request(
                request_id=expert_request["request_id"], base_dir=tools,
            ))
        expert_request_bytes = (tools / "agent-invocations/requests.jsonl").read_bytes()

        def invoke_current_runner(*, selected_root, pr_observation=pr, expected_expert=False,
                                  expected_budget=True):
            selected_adapter = SnapshotGitHubAdapter({
                "pr": pr_observation, "github": {"pr_diff": diff_text},
            })
            selected_runner = RealAutoMergeRunner(
                profile="autonomous", adapter_factory=lambda: selected_adapter,
                pr_enumerator=lambda selected: [pr["number"]],
                readiness_claim_resolver=lambda selected, number, root: "fixture-readiness-reference",
            )
            observed_reports.clear()
            with ExitStack() as stack:
                for gate_patch in _gate_patches(head_sha):
                    stack.enter_context(gate_patch)
                stack.enter_context(patch(
                    "aria_kernel.merge_authority.run_hard_fail_checks",
                    side_effect=evaluate_actual_context,
                ))
                selected_result = selected_runner(base_dir=tools, workspace_root=selected_root)
            self.assertEqual(len(observed_reports), 1)
            selected_context, selected_report = observed_reports[0]
            self.assertFalse(selected_report.passed)
            self.assertEqual(selected_result["decisions"][0]["stage"], "pre_merge_perimeter")
            self.assertEqual(selected_result["decisions"][0]["decision"], "blocked")
            self.assertEqual(selected_result["merges_completed"], 0)
            self.assertEqual(selected_adapter.merge_calls, [])
            selected_checks = {item.name: item for item in selected_report.results}
            # The fixture starts its plan directly, never through the
            # pressure-source provider, so once the implementation is bound
            # the operator-feedback predicate refuses on the missing
            # synthesis binding; unbound, it refuses like every other one.
            self.assertFalse(selected_checks["operator_feedback_signature"].passed)
            self.assertEqual(selected_checks["operator_feedback_signature"].reason,
                "operator_feedback_synthesis_binding_unavailable"
                if _native_implementation_is_bound(selected_context)
                else "native_implementation_binding_unavailable")
            self.assertEqual(selected_checks["cycle_and_turn_budget_cap"].passed, expected_budget,
                selected_checks["cycle_and_turn_budget_cap"].reason)
            self.assertEqual(selected_checks["expert_consensus_evidence_verified"].passed, expected_expert)
            return selected_context, selected_checks

        repeated_context, repeated_checks = invoke_current_runner(selected_root=repo)
        self.assertEqual(repeated_context.pre_merge_evidence.result_row_hash,
            submitted["row"]["ledger_hash"])
        self.assertFalse(repeated_checks["expert_consensus_evidence_verified"].passed)
        self.assertEqual((tools / "agent-invocations/requests.jsonl").read_bytes(), expert_request_bytes)

        with self.subTest(ordinary_case="missing_workspace_input"):
            missing_context, missing_checks = invoke_current_runner(selected_root=None, expected_budget=False)
            self.assertEqual(missing_context.pre_merge_evidence.unavailable_reasons,
                ("workspace_root_unavailable",))
            self.assertEqual(missing_checks["cycle_and_turn_budget_cap"].reason,
                "native_implementation_binding_unavailable")
            self.assertFalse(missing_checks["branch_tip_lock_and_recheck"].passed)
            self.assertFalse(missing_checks["content_hash_recheck"].passed)
            self.assertFalse(missing_checks["per_file_mutual_exclusion"].passed)

        with self.subTest(ordinary_case="partial_live_pr_observation"):
            partial_pr = dict(pr)
            partial_pr.pop("base_sha")
            partial_context, partial_checks = invoke_current_runner(
                selected_root=repo, pr_observation=partial_pr, expected_budget=False,
            )
            self.assertEqual(partial_context.pre_merge_evidence.unavailable_reasons,
                ("pr_commit_identity_unavailable",))
            self.assertFalse(partial_checks["branch_tip_lock_and_recheck"].passed)
            self.assertFalse(partial_checks["content_hash_recheck"].passed)
            self.assertFalse(partial_checks["per_file_mutual_exclusion"].passed)

        from aria_kernel.agent_invocations import create_agent_invocation_request, release_claim
        competing = create_agent_invocation_request(
            target_agent="aria-implementer", role="implementation",
            suggested_prompt="inspect the same source during the pending merge review",
            must_satisfy=[{"id": "inspect-source", "criterion": "inspect the declared source"}],
            allowed_scope=[source_path], target_sha=head_sha, base_dir=tools,
        )
        competing_claim = claim_request(request_id=competing["request_id"],
            agent_id="competing-source-worker", base_dir=tools)
        with self.subTest(ordinary_case="live_overlapping_implementation_claim"):
            locked_context, locked_checks = invoke_current_runner(selected_root=repo)
            self.assertTrue(locked_checks["branch_tip_lock_and_recheck"].passed)
            self.assertTrue(locked_checks["content_hash_recheck"].passed)
            self.assertFalse(locked_checks["per_file_mutual_exclusion"].passed)
            self.assertEqual(locked_checks["per_file_mutual_exclusion"].reason, "implementation_scope_locked")
            self.assertEqual(locked_context.pre_merge_evidence.scope_conflicting_claim_id, competing_claim["claim_id"])
            self.assertEqual(locked_context.pre_merge_evidence.scope_conflicting_claim_hash,
                competing_claim["claim_ledger_hash"])
        release_claim(claim_id=competing_claim["claim_id"], agent_id="competing-source-worker",
            lease_token=competing_claim["lease_token"], reason="worker completed its local scope", base_dir=tools)
        with self.subTest(ordinary_case="released_overlapping_implementation_claim"):
            unlocked_context, unlocked_checks = invoke_current_runner(selected_root=repo)
            self.assertTrue(unlocked_checks["branch_tip_lock_and_recheck"].passed)
            self.assertTrue(unlocked_checks["content_hash_recheck"].passed)
            self.assertTrue(unlocked_checks["per_file_mutual_exclusion"].passed)
            self.assertIsNone(unlocked_context.pre_merge_evidence.scope_conflicting_claim_id)
            self.assertIsNotNone(unlocked_context.pre_merge_evidence.scope_observed_at)

        with self.subTest(ordinary_case="coverage_manifest_temporarily_unavailable"):
            held_manifest = coverage_manifest.with_suffix(".held")
            coverage_manifest.rename(held_manifest)
            try:
                unavailable_context, unavailable_checks = invoke_current_runner(selected_root=repo)
                for name in ("branch_tip_lock_and_recheck", "content_hash_recheck", "per_file_mutual_exclusion"):
                    self.assertTrue(unavailable_checks[name].passed)
                self.assertFalse(unavailable_checks["plan_coverage_witness_verified"].passed)
                self.assertEqual(unavailable_checks["plan_coverage_witness_verified"].reason,
                    "coverage_manifest_unavailable")
                self.assertEqual(unavailable_context.pre_merge_evidence.coverage_event_hash,
                    coverage_event["ledger_hash"])
            finally:
                held_manifest.rename(coverage_manifest)
        with self.subTest(ordinary_case="same_native_coverage_manifest_available_again"):
            available_context, available_checks = invoke_current_runner(selected_root=repo)
            self.assertTrue(available_checks["plan_coverage_witness_verified"].passed)
            self.assertEqual(available_context.pre_merge_evidence.coverage_manifest_hash,
                coverage_payload["closure_manifest_hash"])
            self.assertEqual(coverage_manifest.read_bytes(), coverage_bytes)

        # Declared fixture opinions enter through real claim/submission owners.
        # No model or operator endorsement is supplied by this fixture.
        expert_results = []
        for expert_request in expert_requests:
            expert_claim = claim_request(
                request_id=expert_request["request_id"],
                agent_id="fixture-" + expert_request["target_agent"] + "-session",
                lease_seconds=1800, base_dir=tools,
            )
            expert_response = {
                "$schema": "aria/agent-response/v1",
                "request_id": expert_request["request_id"],
                "claim_id": expert_claim["claim_id"],
                "agent_id": expert_claim["agent_id"],
                "role": "specialist_domain_review", "status": "submitted",
                "satisfaction_matrix": [{
                    "id": expert_request["must_satisfy"][0]["id"],
                    "verdict": "satisfied", "confidence": 0.9,
                    "evidence_refs": [source_path + ":1"],
                }],
                "evidence_refs": [source_path + ":1"],
            }
            expert_output = Path(expert_request["expected_output_path"])
            expert_output.parent.mkdir(parents=True, exist_ok=True)
            expert_output.write_text(json.dumps(expert_response), encoding="utf-8")
            expert_transcript = fixture / (expert_request["target_agent"] + "-declared-opinion.txt")
            expert_transcript.write_text(
                "Declared fixture opinion; no provider executed. Request="
                + expert_request["request_id"] + " claim=" + expert_claim["claim_id"] + "\n",
                encoding="utf-8",
            )
            with chdir(repo):
                expert_submission = submit_claim_result(
                    claim_id=expert_claim["claim_id"], agent_id=expert_claim["agent_id"],
                    lease_token=expert_claim["lease_token"], output_path=expert_output,
                    workspace_root=repo, base_dir=tools,
                    context_hash=expert_request["context_hash"],
                    prompt_hash=expert_request["prompt_hash"],
                    transcript_hash="sha256:" + hashlib.sha256(expert_transcript.read_bytes()).hexdigest(),
                    transcript_artifact_ref=str(expert_transcript),
                )
            self.assertEqual(expert_submission["status"], "accepted", expert_submission)
            self.assertEqual(expert_submission["bridged"]["bridge_errors"], [])
            accepted_expert = accepted_result_for_request(
                request_id=expert_request["request_id"], role="specialist_domain_review", base_dir=tools,
            )
            self.assertEqual(accepted_expert, expert_submission["row"])
            self.assertEqual(accepted_expert["claim_id"], expert_claim["claim_id"])
            self.assertEqual(accepted_expert["agent_id"], expert_claim["agent_id"])
            sealed_output = tools / accepted_expert["output_path"]
            self.assertEqual("sha256:" + hashlib.sha256(sealed_output.read_bytes()).hexdigest(),
                accepted_expert["output_hash"])
            self.assertEqual(json.loads(sealed_output.read_text()), expert_response)
            expert_results.append(accepted_expert)
            if len(expert_results) == 1:
                one_context, one_checks = invoke_current_runner(selected_root=repo)
                self.assertFalse(one_checks["expert_consensus_evidence_verified"].passed)
                self.assertEqual(one_context.pre_merge_evidence.result_row_hash,
                    submitted["row"]["ledger_hash"])
        self.assertEqual(len({row["claim_id"] for row in expert_results}), 2)
        self.assertEqual(len({row["transcript_hash"] for row in expert_results}), 2)
        self.assertEqual((tools / "agent-invocations/requests.jsonl").read_bytes()[:len(expert_request_bytes)],
            expert_request_bytes)
        reviewed_context, reviewed_checks = invoke_current_runner(
            selected_root=repo, expected_expert=True,
        )
        self.assertEqual(reviewed_checks["expert_consensus_evidence_verified"].reason,
            "native_final_expert_consensus_verified")
        self.assertEqual(reviewed_context.pre_merge_evidence.expert_request_ids,
            tuple(row["request_id"] for row in expert_requests))
        self.assertEqual(reviewed_context.pre_merge_evidence.expert_result_hashes,
            tuple(row["ledger_hash"] for row in expert_results))
        self.assertEqual(reviewed_context.pre_merge_evidence.expert_target_sha, head_sha)
        # With the panel accepted, every LIVE pre-merge predicate holds on this
        # implementation; the perimeter is closed by the one unbuilt check alone.
        self.assertEqual({name for name, item in reviewed_checks.items() if not item.passed},
            {"operator_feedback_signature"})

        with self.subTest(ordinary_case="implementer_turn_budget_exhausted"):
            # The same implementer keeps working: seven more admitted turns
            # reach the cap, the eleventh is refused at the boundary, and the
            # refusal is what the predicate now reads — the attempt exceeded
            # its cap, so what it produced is not mergeable.
            for turn in range(3, IMPLEMENTER_TURN_BUDGET):
                self.assertEqual(implementer_turn(f"toolu_impl_{turn}"), kernel_hooks.EXIT_ALLOW)
            self.assertEqual(implementer_turn("toolu_impl_refused"), kernel_hooks.EXIT_BLOCK)
            exhausted_context, exhausted_checks = invoke_current_runner(
                selected_root=repo, expected_expert=True, expected_budget=False,
            )
            self.assertEqual(exhausted_checks["cycle_and_turn_budget_cap"].reason,
                "implementer_turn_budget_exhausted")
            self.assertEqual(exhausted_context.pre_merge_evidence.turn_budget_used, IMPLEMENTER_TURN_BUDGET)
            self.assertEqual(exhausted_context.pre_merge_evidence.turn_budget_refusal_reason,
                f"implementer_turn_budget_exhausted:used={IMPLEMENTER_TURN_BUDGET}:cap={IMPLEMENTER_TURN_BUDGET}")
            self.assertEqual(exhausted_context.pre_merge_evidence.result_row_hash, submitted["row"]["ledger_hash"])
            self.assertTrue(exhausted_checks["expert_consensus_evidence_verified"].passed)

        # A later real commit moves the original implementation branch. Keep
        # that branch intact and read the previously accepted commit detached.
        (repo / source_path).write_text("export const sampleIntervalMs: number = 10000;\n", encoding="utf-8")
        git("add", source_path)
        git("commit", "-q", "-m", "fixture: next source revision")
        later_head = git("rev-parse", "HEAD")
        self.assertNotEqual(later_head, head_sha)
        self.assertTrue(verify_commit_signature(later_head, signer.fingerprint, repo=repo))
        git("checkout", "-q", "--detach", head_sha)
        self.assertEqual(git("rev-parse", "refs/heads/" + staged["branch"]), later_head)
        self.assertEqual(git("rev-parse", "HEAD"), head_sha)
        with self.subTest(ordinary_case="native_branch_advanced"):
            stale_context, stale_checks = invoke_current_runner(
                selected_root=repo, expected_expert=True, expected_budget=False,
            )
            self.assertEqual(stale_context.pre_merge_evidence.result_row_hash, submitted["row"]["ledger_hash"])
            self.assertEqual(stale_checks["branch_tip_lock_and_recheck"].reason, "native_branch_tip_changed")
            self.assertFalse(stale_checks["branch_tip_lock_and_recheck"].passed)
            self.assertTrue(stale_checks["content_hash_recheck"].passed)

        with self.subTest(ordinary_case="live_pr_revision_moves_beyond_expert_panel"):
            advanced_pr = dict(pr, head_sha=later_head)
            advanced_context, advanced_checks = invoke_current_runner(
                selected_root=repo, pr_observation=advanced_pr, expected_budget=False,
            )
            self.assertIsNone(advanced_context.pre_merge_evidence.result_row_hash)
            self.assertFalse(advanced_checks["expert_consensus_evidence_verified"].passed)

        from aria_kernel.plan_convergence import record_implementation_rejected
        record_implementation_rejected(
            plan_id=plan.plan_id, rejection_class="branch_tip_drift",
            rejected_at=utc_now(), base_dir=tools,
        )
        rejected_state = plan_status(plan_id=plan.plan_id, base_dir=tools)
        self.assertEqual(rejected_state["state"], "IMPLEMENTATION_REJECTED")
        self.assertEqual(rejected_state["implementation"]["rejection_class"], "branch_tip_drift")
        with self.subTest(ordinary_case="native_implementation_no_longer_accepted"):
            rejected_context, rejected_checks = invoke_current_runner(selected_root=repo, expected_budget=False)
            self.assertIsNone(rejected_context.pre_merge_evidence.result_row_hash)
            self.assertFalse(rejected_checks["branch_tip_lock_and_recheck"].passed)
            self.assertFalse(rejected_checks["content_hash_recheck"].passed)
            self.assertFalse(rejected_checks["per_file_mutual_exclusion"].passed)
        self.assertEqual(get_change_chain(change_id=staged["change_id"], base_dir=tools)["committed"], committed)
        self.assertEqual(accepted_result_for_request(request_id=request["request_id"], base_dir=tools)["ledger_hash"],
            submitted["row"]["ledger_hash"])


class GitHubPreMergeContextTests(unittest.TestCase):
    def test_live_pr_projection_requests_base_body_and_url(self) -> None:
        from aria_kernel.auto_merge import GhCliGitHubAdapter

        native_pr = {
            "number": 732, "baseRefName": "main", "baseRefOid": "b" * 40,
            "headRefName": "aria/change-732", "headRefOid": "c" * 40,
            "body": "Review this exact implementation revision.",
            "url": "https://github.com/fixture-owner/fixture-repo/pull/732",
            "files": [{"path": "apps/farm-service/src/sample-interval.ts"}],
            "reviews": [], "reviewDecision": "APPROVED",
        }

        def public_json_transport(args):
            if args == ["repo", "view", "--json", "owner,name"]:
                return {"owner": {"login": "fixture-owner"}, "name": "fixture-repo"}
            self.assertEqual(args[:4], ["pr", "view", "732", "--json"])
            return {name: native_pr[name] for name in args[4].split(",")}

        with patch.object(GhCliGitHubAdapter, "_gh_json", side_effect=public_json_transport) as transport:
            adapter = GhCliGitHubAdapter(cwd=Path(__file__).resolve().parents[2])
            projected = adapter.get_pr(732)
        self.assertEqual(projected.get("base_sha"), native_pr["baseRefOid"])
        self.assertEqual(projected.get("body"), native_pr["body"])
        self.assertEqual(projected.get("url"), native_pr["url"])
        self.assertEqual(projected["head_sha"], native_pr["headRefOid"])
        self.assertEqual(projected["base_branch"], native_pr["baseRefName"])
        self.assertEqual(projected["changed_files"], native_pr["files"])
        self.assertEqual(projected["repository"], "fixture-owner/fixture-repo")
        self.assertEqual(transport.call_count, 2)


if __name__ == "__main__":
    unittest.main()
