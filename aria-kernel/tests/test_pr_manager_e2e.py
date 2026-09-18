"""End-to-end PR pipeline tests (Plan 017 Phase 3, closes DEBT-2026-05-07-004).

Walks proposal -> approve -> apply action -> validation gate -> open PR
under a mock gh API factory. Asserts:

- PR body carries the seven required sections (Problem, Evidence, Solution,
  Validation, Baseline Comparison, Rollback, Provenance).
- gh subprocess is invoked with `--base main` (hardcoded in
  pr_manager); a different base never appears.
- Action without `ready_for_pr` status cannot open a PR.
- gh API failure surfaces as `GovernanceError`.
- push_prepared_branch refuses to push protected base branches.


Plus the apply_engine.gate_apply_action `diff_text` extension:
- Diff containing a banned suppression (e.g. `// @ts-ignore`) flips the
  action status to `blocked` with `suppression_pattern` in `blocked_by`.
"""
from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from aria_kernel.apply_engine import (
    PLAN_CONVERGED_APPROVAL_PREFIX,
    gate_apply_action,
    run_apply_gate,
    stage_converged_plan_for_pr,
)
from aria_kernel.implementation_safety import (
    ARIA_IMPL_BRANCH_FRAGMENT,
    CANONICAL_VALIDATION_COMMANDS,
    CANONICAL_VALIDATION_COMMANDS_EXECUTABLE,
    CANONICAL_VALIDATION_TIMEOUT_MS,
)
from aria_kernel.pr_manager import (
    build_pr_body,
    open_pr_for_action,
    push_prepared_branch,
)
from aria_kernel.proposal import approve_proposal, record_proposal
from aria_kernel.runtime_profile import set_profile
from aria_kernel.tool_registry import GovernanceError, ensure_tools_dir
from tests._helpers.declared_fixtures import append_declared_fixture
from tests._helpers.production_shaped import production_converged_plan
from tests._helpers.node_modules import installed_node_modules
from tests._gh_mock import (
    gh_create_failure,
    gh_create_success,
    recorded_calls,
    reset_recorded,
)


# ORPHAN-CRITICAL-428 — the one product file this fixture's PR claims to
# change. It must sit OUTSIDE implementation_safety.READONLY_PATHS
# (`aria-kernel/`, `.github/`, `docs/adr/`, `scripts/`, …): the pre-PR-open
# hard-fail perimeter refuses both a readonly write
# (`forbidden_scope_normalized`) and a readonly mint-time declaration
# (`kernel_self_modification_blocked_at_envelope_mint`), so a kernel path here
# describes a PR that could never legally be opened. The branch commit in
# _seed_tools touches this exact path so the declared surface and the real
# base..branch diff agree.
FIXTURE_CHANGED_FILE = "apps/farm-service/src/farm/services/water-quality.service.ts"


def _seed_tools() -> Path:
    import subprocess as _sp
    tmp = Path(tempfile.mkdtemp(prefix="aria-pr-e2e-"))
    tools = tmp / "aria-tools"
    ensure_tools_dir(tools)
    # Plan 020 Phase 1.B — pr_open is strict-only under the new runtime
    # profile gate. PR-manager tests intentionally exercise the open_pr
    # path, so the seed bumps the profile to strict (with an explicit
    # test-fixture operator_approval_ref). Profile gate is the safety
    # boundary; the test explicitly opts into the boundary it is testing.
    set_profile(
        "strict",
        operator_approval_ref="test:plan-020-phase-1.B:pr-manager-e2e",
        base_dir=tools,
        set_by="operator",
    )
    # Plan 023 v3 §P-3 — open_pr_for_action now fails hard when
    # `git rev-parse <branch>` fails. _seed_apply_action uses a fixed
    # `aria/test-proposal` branch; init a real git repo + create the
    # branch so rev-parse resolves to a real SHA and the existing
    # tests stay portable.
    workspace = tools.parent
    _sp.run(["git", "init", "-q"], cwd=workspace, check=True)
    _sp.run(["git", "config", "user.email", "t@t.invalid"], cwd=workspace, check=True)
    _sp.run(["git", "config", "user.name", "t"], cwd=workspace, check=True)
    (workspace / "init.txt").write_text("init\n", encoding="utf-8")
    _sp.run(["git", "add", "init.txt"], cwd=workspace, check=True)
    _sp.run(
        ["git", "commit", "-q", "-m", "init"],
        cwd=workspace, check=True, capture_output=True,
    )
    _sp.run(
        ["git", "checkout", "-q", "-b", "aria/test-proposal"],
        cwd=workspace, check=True,
    )
    changed = workspace / FIXTURE_CHANGED_FILE
    changed.parent.mkdir(parents=True, exist_ok=True)
    changed.write_text(
        "export const WATER_QUALITY_SAMPLE_INTERVAL_MS = 60000;\n",
        encoding="utf-8",
    )
    _sp.run(["git", "add", FIXTURE_CHANGED_FILE], cwd=workspace, check=True)
    _sp.run(
        ["git", "commit", "-q", "-m", "feature"],
        cwd=workspace, check=True, capture_output=True,
    )
    return tools


def _latest_staged_action(tools: Path, proposal_id: str) -> dict:
    from aria_kernel.apply_engine import latest_apply_action

    action = latest_apply_action(proposal_id=proposal_id, base_dir=tools)
    assert action is not None
    return action


def _rev_parse(workspace: Path, rev: str) -> str:
    import subprocess as _sp
    completed = _sp.run(
        ["git", "rev-parse", rev],
        cwd=workspace, check=True, capture_output=True, text=True,
    )
    return completed.stdout.strip()


def _seed_apply_action(
    *,
    tools: Path,
    proposal_id: str,
    status: str,
    base_sha: str | None = None,
    branch: str = "aria/test-proposal",
) -> dict:
    """Bypass plan_apply_worktree (which needs git) and write the action row directly.

    Plan 017 Phase 3 verifies the gate logic, not the worktree planner. The
    seeded action row mirrors what plan_apply_worktree -> gate_apply_action
    would have produced for a passing validation gate.

    ORPHAN-CRITICAL-428 — that mirror now has to hold for the pre-PR-open
    hard-fail perimeter too, so `base_sha` defaults to the branch's REAL
    parent commit instead of the literal "abcd1234". A base SHA git cannot
    resolve makes `git diff <base>..<head>` fail, which pr_manager reports as
    diff_text=None, which the secret scan treats as UNVERIFIED and refuses
    (`secret_scan_diff_clean:diff_text_absent`) — a fixture describing a PR
    whose diff nobody can read, not a clean one.
    """
    if base_sha is None:
        base_sha = _rev_parse(tools.parent, f"{branch}^")
    row = {
        "schema_version": 1,
        "recorded_at": "2026-05-07T00:00:00Z",
        "proposal_id": proposal_id,
        "workspace_root": str(tools.parent),
        "base_sha": base_sha,
        "branch": branch,
        "worktree_path": str(tools.parent / "aria-worktrees" / f"A-{proposal_id}"),
        "changed_files": [FIXTURE_CHANGED_FILE],
        # apply_engine copies proposal.validation_scope.commands verbatim, so
        # the production shape is a flat list of command strings. The perimeter
        # requires each canonical command as its OWN entry (ORPHAN-CRITICAL-461
        # closed the loophole where one string mentioning all three passed), and
        # the tuple is imported rather than retyped so the fixture cannot drift
        # from the suite it claims to declare.
        "validation_commands": [*CANONICAL_VALIDATION_COMMANDS, "nx test aria-kernel"],
        "validation_gate_ref": "sha256:gate-ref-fake",
        "validation_gate_status": "ready_for_pr",
        "validation_gate_blocked_by": [],
        "status": status,
        "blocked_by": [],
    }
    append_declared_fixture(
        tools / "apply" / "actions.jsonl",
        row,
        expected_surface="apply_actions",
    )
    return row


def _seed_proposal(*, tools: Path, proposal_id: str = "PROP-0001") -> dict:
    proposal = record_proposal(
        kind="test_gap",
        title="Plan 017 Phase 3 sample proposal",
        problem="Synthetic test proposal — exercises the PR pipeline end to end.",
        evidence=["docs/aria/SPEC.md:53", "docs/aria/CONTRACTS.md:8"],
        validation_command="nx test aria-kernel",
        proposed_change="Land the integration test that closes DEBT-2026-05-07-004.",
        base_dir=tools,
    )
    pid = proposal["proposal_id"]
    approve_proposal(
        proposal_id=pid,
        operator_approval_ref="operator-test:plan-017-phase-3",
        base_dir=tools,
    )
    return proposal


class PRBodySectionsTests(unittest.TestCase):
    """Verify build_pr_body produces all seven required sections."""

    def test_body_has_seven_required_sections(self) -> None:
        proposal = {
            "proposal_id": "PROP-X",
            "task_id": "TASK-Y",
            "title": "Sample title",
            "problem": "Sample problem statement",
            "evidence": ["docs/aria/SPEC.md:53"],
            "proposed_change": "Sample change",
        }
        action = {
            "base_sha": "abcd1234",
            "validation_commands": [{"cmd": "nx test", "expected_exit": 0, "timeout_ms": 60000}],
            "validation_run_refs": ["sha256:run-ref"],
            "worktree_path": "/tmp/wt",
        }
        body = build_pr_body(proposal=proposal, action=action)
        for section in (
            "## Problem",
            "## Evidence",
            "## Solution",
            "## Validation",
            "## Baseline Comparison",
            "## Rollback",
            "## Provenance",
        ):
            self.assertIn(section, body, f"missing section {section}")


class OpenPRForActionTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tools = _seed_tools()
        self.repo = self.tools.parent
        reset_recorded()

    def tearDown(self) -> None:
        import shutil
        shutil.rmtree(self.repo, ignore_errors=True)

    def test_dry_run_records_pr_dry_run_event_with_seven_section_body(self) -> None:
        proposal = _seed_proposal(tools=self.tools)
        _seed_apply_action(tools=self.tools, proposal_id=proposal["proposal_id"], status="ready_for_pr")
        result = open_pr_for_action(
            proposal_id=proposal["proposal_id"],
            workspace_root=self.repo,
            base_dir=self.tools,
            dry_run=True,
        )
        self.assertEqual(result["base_branch"], "main")
        self.assertIn("## Problem", result["body"])
        self.assertIn("## Provenance", result["body"])

    def test_action_not_ready_for_pr_raises(self) -> None:
        proposal = _seed_proposal(tools=self.tools)
        _seed_apply_action(tools=self.tools, proposal_id=proposal["proposal_id"], status="blocked")
        with self.assertRaisesRegex(GovernanceError, "validation gate"):
            open_pr_for_action(
                proposal_id=proposal["proposal_id"],
                workspace_root=self.repo,
                base_dir=self.tools,
                dry_run=True,
            )

    def test_open_pr_invokes_gh_with_base_main(self) -> None:
        proposal = _seed_proposal(tools=self.tools)
        _seed_apply_action(tools=self.tools, proposal_id=proposal["proposal_id"], status="ready_for_pr")
        with patch("aria_kernel.pr_manager.subprocess.run", side_effect=gh_create_success):
            result = open_pr_for_action(
                proposal_id=proposal["proposal_id"],
                workspace_root=self.repo,
                base_dir=self.tools,
                change_id="ch-test", dry_run=False,
            )
        self.assertEqual(result["base_branch"], "main")
        # Plan 022 §C-4 — open_pr_for_action now also calls
        # `git rev-parse <branch>` to resolve the real head_sha; the
        # call log captures BOTH that git call AND the gh pr create call.
        calls = recorded_calls()
        gh_calls = [c for c in calls if c.argv[:3] == ["gh", "pr", "create"]]
        git_calls = [c for c in calls if c.argv[:2] == ["git", "rev-parse"]]
        self.assertEqual(len(gh_calls), 1)
        self.assertEqual(len(git_calls), 1)
        argv = gh_calls[0].argv
        self.assertIn("--title", argv)
        self.assertEqual(argv[argv.index("--title") + 1], proposal["title"])

    def test_gh_failure_raises_governance_error(self) -> None:
        proposal = _seed_proposal(tools=self.tools)
        _seed_apply_action(tools=self.tools, proposal_id=proposal["proposal_id"], status="ready_for_pr")
        with patch("aria_kernel.pr_manager.subprocess.run", side_effect=gh_create_failure):
            with self.assertRaisesRegex(GovernanceError, "insufficient permissions"):
                open_pr_for_action(
                    proposal_id=proposal["proposal_id"],
                    workspace_root=self.repo,
                    base_dir=self.tools,
                    change_id="ch-test", dry_run=False,
                )

    def test_explicit_base_develop_is_rejected_at_function_entry(self) -> None:
        # Plan 018 Phase 6.2 (G7) — open_pr_for_action MUST surface the
        # main-only invariant at the function boundary, not just at
        # the gh argv hardcoded value. The explicit base parameter
        # rejection runs BEFORE proposal lookup so a misconfigured
        # caller cannot leak any state through the call.
        with self.assertRaisesRegex(GovernanceError, "ARIA PRs MUST target 'main'; got base='develop'"):
            open_pr_for_action(
                proposal_id="PROP-NONEXISTENT",  # unreachable — base check fires first
                workspace_root=self.repo,
                base_dir=self.tools,
                dry_run=True,
                base="develop",
            )

    def test_explicit_base_main_passes_through(self) -> None:
        # The default value is main; explicit base="main" must
        # behave identically to no-arg.
        proposal = _seed_proposal(tools=self.tools)
        _seed_apply_action(tools=self.tools, proposal_id=proposal["proposal_id"], status="ready_for_pr")
        result = open_pr_for_action(
            proposal_id=proposal["proposal_id"],
            workspace_root=self.repo,
            base_dir=self.tools,
            dry_run=True,
            base="main",
        )
        self.assertEqual(result["base_branch"], "main")


def _fake_child_process(monkeypatched_module):
    """Run every git call for real; answer validation child processes with exit 0.

    ORPHAN-CRITICAL-727 — the staged chain has to execute the REAL
    ``run_validation_commands`` (it is what writes the validation-plans rows
    that ``compare_validation_groups`` and the gate later join on), and the
    real function refuses a change_id that does not resolve, a commit_sha the
    repo cannot parse and a dirty worktree. All three checks are git calls, so
    they stay real; only the `npx nx` / `npm run` child — minutes of CI that
    prove nothing about this pipeline — is answered without spawning.

    ARIA-HIGH-124 (round 4) — the substitute is the runner's ONE spawn seam
    (``validation._run_to_completion``, which leads its own process group so
    a timeout kills the whole tree) rather than the module's
    ``subprocess.run``: the seam is what every validation child goes through,
    and patching it leaves the module's git calls real by construction
    instead of by an argv test.
    """
    import subprocess as _sp

    real_spawn = monkeypatched_module._run_to_completion

    def _spawn(argv, **kwargs):
        # ARIA-HIGH-149 — the canonical format entry is the quality runner
        # under `node`; it is a validation child like npx/npm.
        if argv and str(argv[0]) in ("npx", "npm", "cargo", "node") or (
            argv and str(argv[0]).startswith("python3") and "-m" in argv
        ):
            return _sp.CompletedProcess(argv, 0, "ok\n", "")
        return real_spawn(argv, **kwargs)

    return patch.object(monkeypatched_module, "_run_to_completion", _spawn)


class StagedConvergedPlanChainTests(unittest.TestCase):
    """ORPHAN-CRITICAL-727 — a CONVERGED plan can now reach `pr create`.

    ``open_pr_for_action`` demands three things nothing autonomous produced:
    a proposal in ``approved_for_apply``, an apply action in ``ready_for_pr``
    and a ``validation_gate_ref``. These tests walk the whole producer chain
    end to end — converge, stage, implement, gate, open — and pin the refusal
    that remains when the gate is skipped.
    """

    def setUp(self) -> None:
        self.tools = _seed_tools()
        self.repo = self.tools.parent
        reset_recorded()

    def tearDown(self) -> None:
        import shutil
        shutil.rmtree(self.repo, ignore_errors=True)

    def _ordinary_scoped_stage(self):
        import os
        from aria_kernel.experiment import register_recipe
        from aria_kernel.tool_registry import ensure_tools_binding

        external = tempfile.TemporaryDirectory(prefix="aria-stage-inputs-")
        self.addCleanup(external.cleanup)
        outside = Path(external.name)
        self.tools = outside / "store" / "tools"
        set_profile("strict", operator_approval_ref="test:stage-inputs", base_dir=self.tools)
        ensure_tools_binding(self.tools, workspace_root=self.repo)
        installed = installed_node_modules("nx", "typescript", "eslint")
        (self.repo / "node_modules").symlink_to(installed, target_is_directory=True)
        self.scoped_prefix = "apps/farm-service/env/"
        self.scoped_selector = "test_paths.PathTests.test_normalized_case_sensitive_deduplication"
        self.scoped_command = "PYTHONPATH=" + self.scoped_prefix.rstrip("/") + " python3 -m unittest -v " + self.scoped_selector
        files = {
            ".gitignore": "aria-tools/\nnode_modules/\n.nx/\n__pycache__/\n",
            "package.json": json.dumps({"name": "ordinary-env-fixture", "private": True,
                                       "scripts": {"type-check": "tsc --noEmit --pretty false --listFiles -p tsconfig.json",
                                                   # ARIA-HIGH-104 (2) — format:check joined the
                                                   # canonical suite; the offline fixture answers it.
                                                   "format:check": "node -e 0"}}),
                                                   # ARIA-HIGH-149 — the canonical format entry is the repository's
                                                   # quality runner (`format check-changed`); the offline fixture's
                                                   # runner answers exit 0 like the other canonical commands.
                                                   "tools/quality/quality.mjs": "process.exit(0);\n",
            "nx.json": json.dumps({"neverConnectToCloud": True, "plugins": []}),
            "apps/farm-service/project.json": json.dumps({
                "name": "env-fixture", "root": "apps/farm-service",
                "targets": {
                    "test": {"executor": "nx:run-commands", "cache": False,
                             "options": {"command": self.scoped_command}},
                    "lint": {"executor": "nx:run-commands", "cache": False,
                             "options": {"command": "eslint apps/farm-service/env/checked.js --format json"}},
                },
            }),
            "eslint.config.cjs": (
                "module.exports = [{files: ['apps/**/*.js'], languageOptions: {ecmaVersion: 2022, "
                "sourceType: 'module'}, rules: {'no-unused-vars': 'error'}}];\n"
            ),
            "tsconfig.json": json.dumps({"compilerOptions": {"strict": True, "types": []},
                                        "files": [self.scoped_prefix + "typed.ts"]}),
            self.scoped_prefix + "checked.js": "export const distinctPaths = ['src/A.py', 'src/a.py'];\n",
            self.scoped_prefix + "typed.ts": "export const distinctPaths: string[] = ['src/A.py', 'src/a.py'];\n",
            self.scoped_prefix + "paths.py": (
                "import json\nfrom pathlib import Path\nfrom path_helper import canonical_path\n"
                "def unique_paths(paths):\n"
                "    config = json.loads(Path(__file__).with_name('path-config.json').read_text())\n"
                "    values = [canonical_path(p) for p in paths]\n"
                "    if not config['case_sensitive']:\n"
                "        values = [p.lower() for p in values]\n"
                "    return sorted(set(values))\n"
            ),
            self.scoped_prefix + "path_helper.py": "def canonical_path(value):\n    return value.removeprefix('./')\n",
            self.scoped_prefix + "path-config.json": '{"case_sensitive": true}\n',
            self.scoped_prefix + "test_paths.py": (
                "import os, unittest\nfrom paths import unique_paths\n"
                "class PathTests(unittest.TestCase):\n"
                "    def test_normalized_case_sensitive_deduplication(self):\n"
                "        print('STAGE_CHILD:' + str(os.getpid()))\n"
                "        self.assertEqual(unique_paths(['./src/A.py', 'src/a.py', 'src/A.py']),\n"
                "                         ['src/A.py', 'src/a.py'])\n"
            ),
        }
        for name, content in files.items():
            path = self.repo / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(content, encoding="utf-8")
        self._commit_all("ordinary local Nx and configured-path fixture")
        affected_base = _rev_parse(self.repo, "HEAD")
        environment = {key: value for key, value in os.environ.items()
                       if not key.startswith("NX_") and not key.lower().startswith("npm_config_")
                       and key not in ("NODE_OPTIONS", "NODE_PATH")}
        for name in ("npm-user.conf", "npm-global.conf"):
            (outside / name).write_text("")
        environment.update({
            "NX_BASE": affected_base, "NX_HEAD": "HEAD", "NX_DAEMON": "false", "NX_NO_CLOUD": "true",
            "NX_SKIP_REMOTE_CACHE": "true", "NX_SKIP_NX_CACHE": "true", "NX_PARALLEL": "1",
            "NX_TASKS_RUNNER_DYNAMIC_OUTPUT": "false", "CI": "true",
            "NX_WORKSPACE_DATA_DIRECTORY": str(outside / "nx-workspace"), "NX_CACHE_DIRECTORY": str(outside / "nx-cache"),
            "npm_config_offline": "true", "npm_config_cache": str(outside / "npm-cache"),
            "npm_config_userconfig": str(outside / "npm-user.conf"),
            "npm_config_globalconfig": str(outside / "npm-global.conf"), "npm_config_update_notifier": "false",
        })
        env_patch = patch.dict(os.environ, environment, clear=True)
        env_patch.start()
        self.addCleanup(env_patch.stop)
        self.scoped_descriptor = {
            "schema_version": 2,
            "files": {role: [self.scoped_prefix + path] for role, path in (
                ("source", "paths.py"), ("test", "test_paths.py"),
                ("config", "path-config.json"), ("dependency", "path_helper.py"))},
            "execution_profile": {"kind": "python_unittest_public_v1", "modules": ["path_helper"]},
        }
        self.scoped_recipe = register_recipe(
            recipe_id="recipe-stage-paths", command=self.scoped_command, timeout_ms=60_000,
            deterministic=True, input_scope=self.scoped_descriptor, base_dir=self.tools,
        )
        plan = production_converged_plan(
            tools_dir=self.tools, workspace_root=self.repo,
            affected_paths=[self.scoped_prefix + "path_helper.py"],
            evidence_refs=[self.scoped_prefix + "path_helper.py:2"],
            validation_commands=[{"recipe_id": self.scoped_recipe["recipe_id"], "cmd": self.scoped_command, "timeout_ms": 60_000}],
        )
        # A real project input changes after the fixed Nx base. Both the
        # clean baseline and the later candidate must select this project.
        (self.repo / (self.scoped_prefix + "checked.js")).write_text("export const distinctPaths = ['src/A.py', 'src/a.py', 'src/B.py'];\n")
        self._commit_all("declare the reviewed scope and affected project input")
        staged = stage_converged_plan_for_pr(plan_id=plan.plan_id, workspace_root=self.repo, base_dir=self.tools)
        self.assertNotEqual(staged["base_sha"], affected_base)
        return plan, staged

    def _native_stage_group(self, reference, expected_sha):
        from aria_kernel.validation import list_validation_plans
        from aria_kernel.validation_runs_ledger import verify_validation_run

        group = next(row for row in list_validation_plans(base_dir=self.tools) if row["ledger_hash"] == reference)
        rows = [verify_validation_run(run_id, base_dir=self.tools) for run_id in group["validation_run_ids"]]
        self.assertEqual([row["cmd"] for row in rows], [*CANONICAL_VALIDATION_COMMANDS_EXECUTABLE, self.scoped_command])
        logs = {}
        for row in rows:
            text = Path(row["log_path"]).read_text()
            self.assertEqual((row["exit_code"], row["timed_out"], row["commit_sha"]), (0, False, expected_sha), text)
            logs[row["cmd"]] = text
        nx_test = logs["npx nx affected --target=test"]
        self.assertIn("env-fixture:test", nx_test)
        self.assertIn(self.scoped_selector.rsplit(".", 1)[1], nx_test)
        self.assertIn("Ran 1 test", nx_test)
        self.assertIn("\nOK", nx_test)
        lint = logs["npx nx affected --target=lint"]
        self.assertIn("env-fixture:lint", lint)
        eslint_rows = json.loads(next(line for line in lint.splitlines() if line.startswith('[{"filePath":')))
        checked = str(self.repo / self.scoped_prefix / "checked.js")
        self.assertEqual([(row["filePath"], row["errorCount"], row["warningCount"]) for row in eslint_rows], [(checked, 0, 0)])
        self.assertIn(str(self.repo / self.scoped_prefix / "typed.ts"), logs["npm run type-check"])
        direct = logs[self.scoped_command]
        self.assertIn("Ran 1 test", direct)
        self.assertIn("STAGE_CHILD:", direct)
        return group, rows, logs

    def _assert_stage_selection(self, action, group, rows, logs, plan):
        import hashlib
        from aria_kernel.plan_convergence import fold_plan_state, plan_body_from_state

        direct = rows[-1]
        self.assertIn("input_binding", direct, "real staged validation omitted the recipe-selected descriptor")
        current = plan_body_from_state(fold_plan_state(plan_id=plan.plan_id, base_dir=self.tools))
        selection = action["validation_input_selection"]
        self.assertEqual(selection, {
            "schema_version": 1, "status": "selected", "input_scope": self.scoped_descriptor,
            "recipe_sources": [{"recipe_id": self.scoped_recipe["recipe_id"],
                                "ledger_hash": self.scoped_recipe["ledger_hash"], "command": self.scoped_command}],
            "plan_content_hash": current["content_hash"], "reason": None,
        })
        self.assertEqual(group["change_id"], action["change_id"])
        manifests = {}
        for row in rows:
            manifest = json.loads(next(line.removeprefix("input_manifest: ") for line in logs[row["cmd"]].splitlines()
                                       if line.startswith("input_manifest: ")))
            self.assertEqual(manifest["roles"], self.scoped_descriptor["files"])
            manifests[row["cmd"]] = manifest
        env = manifests[self.scoped_command]["environment"]
        pid = int(next(line.split(":", 1)[1] for line in logs[self.scoped_command].splitlines() if line.startswith("STAGE_CHILD:")))
        self.assertEqual(env["observation"]["child_pid"], pid)
        self.assertEqual(set(env["stable"]["modules"]), {"path_helper"})
        self.assertEqual(env["stable"]["modules"]["path_helper"]["executed_content_binding"]["status"], "unknown")
        expected = "sha256:" + hashlib.sha256(json.dumps(env["stable"], sort_keys=True, separators=(",", ":"), ensure_ascii=True).encode()).hexdigest()
        self.assertEqual(direct["input_binding"]["runner_environment_digest"], expected)
        for row in rows:
            for dimension in ("dependency", "runner_environment", "selection_closure", "configuration_closure"):
                self.assertEqual(row["input_binding"]["availability"][dimension]["status"], "unknown")
        for command in CANONICAL_VALIDATION_COMMANDS_EXECUTABLE:
            self.assertEqual(manifests[command]["environment"]["observation"]["reason"], "unsupported_command_profile")
        return manifests[self.scoped_command]

    def test_staging_recipe_scope_reaches_real_baseline_receipt(self):
        plan, staged = self._ordinary_scoped_stage()
        group, rows, logs = self._native_stage_group(staged["baseline_ref"], staged["base_sha"])
        action = _latest_staged_action(self.tools, staged["proposal_id"])
        self.assertEqual(action["status"], "staged_for_implementation")
        self._assert_stage_selection(action, group, rows, logs, plan)

    def test_same_command_scope_unknown_reason_uses_source_order(self):
        from aria_kernel.apply_engine import _staged_validation_inputs
        from aria_kernel.experiment import register_recipe

        command = "python3 -m unittest -v test_paths.PathTests.test_normalized_case_sensitive_deduplication"
        scopes = {
            "recipe-aaa": {"schema_version": 1, "files": {}},
            "recipe-bbb": {"schema_version": 2, "files": {}, "execution_profile": {
                "kind": "python_unittest_public_v1", "modules": [f"declared_module_{n}" for n in range(8)]}},
            "recipe-ccc": {"schema_version": 2, "files": {}, "execution_profile": {
                "kind": "python_unittest_public_v1", "modules": ["another_declared_module"]}},
        }
        for recipe_id, scope in scopes.items():
            register_recipe(recipe_id=recipe_id, command=command, timeout_ms=60_000,
                            deterministic=True, input_scope=scope, base_dir=self.tools)
        expected = {"schema_version": 1, "status": "unknown", "input_scope": None,
                    "recipe_sources": [], "plan_content_hash": None, "reason": "selection_incompatible_scope"}
        for order in (("recipe-aaa", "recipe-bbb", "recipe-ccc"), ("recipe-bbb", "recipe-ccc", "recipe-aaa")):
            commands, timeout_ms, selection = _staged_validation_inputs(
                {"validation_commands": [{"recipe_id": key, "cmd": command} for key in order]}, base_dir=self.tools)
            self.assertEqual(commands, [*CANONICAL_VALIDATION_COMMANDS_EXECUTABLE, command])
            self.assertEqual(timeout_ms, CANONICAL_VALIDATION_TIMEOUT_MS)
            self.assertEqual(selection, expected, f"declaration order {order} must not choose the diagnostic")

    def test_scoped_recipe_union_uses_exact_rows_and_execution_order(self):
        from aria_kernel.apply_engine import _staged_validation_commands, _staged_validation_inputs
        from aria_kernel.experiment import register_recipe

        def register(recipe_id, command, files, timeout=60_000):
            return register_recipe(recipe_id=recipe_id, command=command, timeout_ms=timeout,
                                   deterministic=True, input_scope={"schema_version": 1, "files": files}, base_dir=self.tools)
        canonical = CANONICAL_VALIDATION_COMMANDS_EXECUTABLE[0]
        old_command = "python3 -m unittest test_existing.TestPaths.test_paths"
        new_command = "python3 -m unittest test_new.TestPaths.test_paths"
        register("recipe-history", old_command, {"source": ["history.py"]})
        latest = register("recipe-history", new_command, {"source": ["new.py"]})
        alpha = register("recipe-alpha", canonical, {"source": ["src/A.py"], "test": ["src/A.py"]}, CANONICAL_VALIDATION_TIMEOUT_MS + 1)
        beta = register("recipe-beta", canonical, {"source": ["src/a.py"], "test": ["src/A.py"]})
        body = {"validation_commands": [{"cmd": new_command}, {"recipe_id": "recipe-beta"},
                                         {"recipe_id": "recipe-alpha"}, {"cmd": new_command}, {"cmd": canonical}]}
        commands, timeout, selection = _staged_validation_inputs(body, base_dir=self.tools)
        self.assertEqual(commands, [*CANONICAL_VALIDATION_COMMANDS_EXECUTABLE, new_command])
        self.assertEqual(timeout, CANONICAL_VALIDATION_TIMEOUT_MS + 1)
        self.assertEqual(_staged_validation_commands(body, base_dir=self.tools), (commands, timeout))
        self.assertEqual(selection["status"], "selected")
        self.assertEqual(selection["input_scope"], {"schema_version": 1, "files": {
            "source": ["new.py", "src/A.py", "src/a.py"], "test": ["src/A.py"], "config": [], "dependency": []}})
        self.assertEqual(selection["recipe_sources"], [
            {"recipe_id": row["recipe_id"], "ledger_hash": row["ledger_hash"], "command": row["command"]}
            for row in (alpha, beta, latest)])
        # ARIA-HIGH-103 — a reseeded id's superseded command is not in the
        # admissible set the planner was shown (the catalog lists the latest
        # row per id), so a plan that names it is refused by name: what the
        # planner was told is what staging runs.
        with self.assertRaisesRegex(GovernanceError, "stage_validation_command_not_declared"):
            _staged_validation_inputs({"validation_commands": [{"cmd": old_command}]}, base_dir=self.tools)

    def test_scope_union_limits_drop_all_contributors(self):
        from aria_kernel.apply_engine import _staged_validation_inputs
        from aria_kernel.experiment import register_recipe

        command = "python3 -m unittest test_paths.TestPaths.test_paths"
        cases = {
            "paths": [{"schema_version": 1, "files": {"source": [f"src/file_{n}.py" for n in range(256)]}},
                      {"schema_version": 1, "files": {"source": ["src/one_more.py"]}}],
            "modules": [{"schema_version": 2, "files": {}, "execution_profile": {
                            "kind": "python_unittest_public_v1", "modules": [f"module_{n}" for n in range(8)]}},
                        {"schema_version": 2, "files": {}, "execution_profile": {
                            "kind": "python_unittest_public_v1", "modules": ["one_more_module"]}}],
            "rows": [{"schema_version": 1, "files": {"source": ["src/shared.py"]}} for _ in range(9)],
        }
        for kind, scopes in cases.items():
            with self.subTest(bound=kind):
                declarations = []
                for index, scope in enumerate(scopes):
                    row = register_recipe(recipe_id=f"recipe-{kind}-{index}", command=command, timeout_ms=60_000,
                                          deterministic=True, input_scope=scope, base_dir=self.tools)
                    declarations.append({"recipe_id": row["recipe_id"]})
                at_limit = declarations[:8] if kind == "rows" else declarations[:1]
                _commands, _timeout, selected = _staged_validation_inputs({"validation_commands": at_limit}, base_dir=self.tools)
                self.assertEqual(selected["status"], "selected")
                if kind == "paths":
                    self.assertEqual(len({path for paths in selected["input_scope"]["files"].values() for path in paths}), 256)
                elif kind == "modules":
                    self.assertEqual(len(selected["input_scope"]["execution_profile"]["modules"]), 8)
                else:
                    self.assertEqual(len(selected["recipe_sources"]), 8)
                for order in (declarations, list(reversed(declarations))):
                    commands, timeout, selection = _staged_validation_inputs({"validation_commands": order}, base_dir=self.tools)
                    self.assertEqual((commands, timeout), ([*CANONICAL_VALIDATION_COMMANDS_EXECUTABLE, command], CANONICAL_VALIDATION_TIMEOUT_MS))
                    self.assertEqual(selection, {"schema_version": 1, "status": "unknown", "input_scope": None,
                                                "recipe_sources": [], "plan_content_hash": None, "reason": "selection_input_limit"})

    def test_selection_metadata_overflow_is_compact_and_order_independent(self):
        from aria_kernel.apply_engine import _staged_validation_inputs
        from aria_kernel.experiment import register_recipe

        declarations, expected_sources = [], []
        for index in range(8):
            command = "python3  -m  unittest  target_" + str(index) + "x" * 4000
            row = register_recipe(recipe_id=f"recipe-metadata-{index}", command=command, timeout_ms=60_000,
                                  deterministic=True, input_scope={"schema_version": 1, "files": {}}, base_dir=self.tools)
            normalized = " ".join(command.split())
            self.assertLessEqual(len(command.encode()), 4096)
            declarations.extend([{"cmd": command}, {"recipe_id": row["recipe_id"]}])
            expected_sources.extend([{"recipe_id": row["recipe_id"], "ledger_hash": row["ledger_hash"], "command": spelling}
                                     for spelling in (normalized, command)])
        encoded = lambda value: json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True).encode()
        self.assertGreater(len(encoded({"recipe_sources": expected_sources})), 65_536)
        for order in (declarations, list(reversed(declarations))):
            commands, timeout, selection = _staged_validation_inputs({"validation_commands": order}, base_dir=self.tools)
            self.assertEqual(commands[:len(CANONICAL_VALIDATION_COMMANDS_EXECUTABLE)], list(CANONICAL_VALIDATION_COMMANDS_EXECUTABLE))
            # The canonical suite plus the 16 declared spellings, deduplicated to 8 recipe commands.
            self.assertEqual(len(commands), len(CANONICAL_VALIDATION_COMMANDS_EXECUTABLE) + 16)
            self.assertEqual(timeout, CANONICAL_VALIDATION_TIMEOUT_MS)
            self.assertEqual(selection, {"schema_version": 1, "status": "unknown", "input_scope": None,
                                        "recipe_sources": [], "plan_content_hash": None, "reason": "selection_metadata_limit"})
            self.assertLessEqual(len(encoded(selection)), 1024)

        # The same aggregate overflow plus a ninth distinct native row has
        # the documented row-cardinality precedence in either input order.
        ninth = register_recipe(recipe_id="recipe-metadata-ninth", command="python3 -m unittest ninth_test",
                                timeout_ms=60_000, deterministic=True,
                                input_scope={"schema_version": 1, "files": {}}, base_dir=self.tools)
        both_limits = [*declarations, {"recipe_id": ninth["recipe_id"]}]
        for order in (both_limits, list(reversed(both_limits))):
            commands, timeout, selection = _staged_validation_inputs({"validation_commands": order}, base_dir=self.tools)
            self.assertEqual(len(commands), len(CANONICAL_VALIDATION_COMMANDS_EXECUTABLE) + 17)
            self.assertEqual(timeout, CANONICAL_VALIDATION_TIMEOUT_MS)
            self.assertEqual(selection, {"schema_version": 1, "status": "unknown", "input_scope": None,
                                        "recipe_sources": [], "plan_content_hash": None, "reason": "selection_input_limit"})

    def test_complete_selection_metadata_limit_includes_recipe_sources(self):
        from aria_kernel.apply_engine import _staged_validation_inputs
        from aria_kernel.experiment import register_recipe

        descriptor = {"schema_version": 1, "files": {
            "source": ["s/" + "a" * 250 + "/" + f"{index:03d}" + "/" + "b" * 250 for index in range(128)],
            "test": [], "config": [], "dependency": [],
        }}
        encode = lambda value: json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True).encode()
        self.assertLessEqual(len(encode(descriptor)), 65_536)
        command = "python3 -m unittest test_" + "method" * 80
        row = register_recipe(recipe_id="recipe-complete-cap", command=command, timeout_ms=60_000,
                              deterministic=True, input_scope=descriptor, base_dir=self.tools)
        self.assertEqual(row["input_scope"], descriptor)
        sources = [{"recipe_id": row["recipe_id"], "ledger_hash": row["ledger_hash"], "command": command}]
        self.assertLessEqual(len(encode({"recipe_sources": sources})), 65_536)
        full = {"schema_version": 1, "status": "selected", "input_scope": descriptor,
                "recipe_sources": sources, "plan_content_hash": None, "reason": None}
        self.assertGreater(len(encode(full)), 65_536)
        commands, timeout, selection = _staged_validation_inputs(
            {"validation_commands": [{"recipe_id": row["recipe_id"]}]}, base_dir=self.tools)
        self.assertEqual((commands, timeout), ([*CANONICAL_VALIDATION_COMMANDS_EXECUTABLE, command], CANONICAL_VALIDATION_TIMEOUT_MS))
        self.assertEqual(selection, {"schema_version": 1, "status": "unknown", "input_scope": None,
                                    "recipe_sources": [], "plan_content_hash": None, "reason": "selection_metadata_limit"})
        self.assertLessEqual(len(encode(selection)), 1024)

    def test_candidate_uses_staged_scope_after_recipe_reregistration(self):
        import subprocess as sp
        from aria_kernel.change_ledger import emit_change_committed
        from aria_kernel.experiment import get_recipe, register_recipe
        from aria_kernel.validation import list_validation_comparisons
        from aria_kernel.validation_runs_ledger import validation_runs_path, verify_validation_run

        plan, staged = self._ordinary_scoped_stage()
        baseline, old_rows, _logs = self._native_stage_group(staged["baseline_ref"], staged["base_sha"])
        old_action = _latest_staged_action(self.tools, staged["proposal_id"])
        native_path = validation_runs_path(self.tools)
        native_prefix = native_path.read_bytes()
        old_logs = {Path(row["log_path"]): Path(row["log_path"]).read_bytes() for row in old_rows}
        sp.run(["git", "checkout", "-q", "-b", staged["branch"]], cwd=self.repo, check=True)
        helper_path = self.scoped_prefix + "path_helper.py"
        (self.repo / helper_path).write_text("def canonical_path(value):\n    return value.removeprefix('./').removeprefix('./')\n")
        self._commit_all("normalize a second relative prefix without changing case")
        candidate_sha = _rev_parse(self.repo, "HEAD")
        emit_change_committed(change_id=staged["change_id"], commit_sha=candidate_sha,
                              actual_affected_files=[helper_path], base_dir=self.tools)
        newer_scope = json.loads(json.dumps(self.scoped_descriptor))
        newer_scope["files"]["test"] = []
        newer_scope["execution_profile"]["modules"] = []
        newer = register_recipe(recipe_id=self.scoped_recipe["recipe_id"], command=self.scoped_command,
                                timeout_ms=120_000, deterministic=True, input_scope=newer_scope, base_dir=self.tools)
        self.assertEqual(get_recipe(newer["recipe_id"], base_dir=self.tools), newer)
        self.assertNotEqual(newer["ledger_hash"], self.scoped_recipe["ledger_hash"])
        gated = run_apply_gate(proposal_id=staged["proposal_id"], change_id=staged["change_id"],
                               base_dir=self.tools, workspace_root=self.repo, runner_identity="ci-executor:stage-inputs")
        self.assertEqual(gated["status"], "ready_for_pr")
        comparison = next(row for row in list_validation_comparisons(base_dir=self.tools)
                          if row["ledger_hash"] == gated["validation_comparison_ref"])
        self.assertEqual(comparison["baseline_ref"], staged["baseline_ref"])
        candidate, rows, logs = self._native_stage_group(comparison["worktree_ref"], candidate_sha)
        self.assertTrue(native_path.read_bytes().startswith(native_prefix))
        for old_row in old_rows:
            self.assertEqual(verify_validation_run(old_row["validation_run_id"], base_dir=self.tools), old_row)
        for path, content in old_logs.items():
            self.assertEqual(path.read_bytes(), content)
        manifest = self._assert_stage_selection(gated, candidate, rows, logs, plan)
        self.assertEqual(gated["validation_input_selection"], old_action["validation_input_selection"])
        self.assertEqual(gated["validation_timeout_ms"], old_action["validation_timeout_ms"])
        self.assertEqual(baseline["validation_run_ids"], [row["validation_run_id"] for row in old_rows])
        old_manifest = json.loads(next(line.removeprefix("input_manifest: ") for line in _logs[self.scoped_command].splitlines()
                                      if line.startswith("input_manifest: ")))
        old_helper = next(item for item in old_manifest["before"]["files"] if item["path"] == helper_path)
        new_helper = next(item for item in manifest["before"]["files"] if item["path"] == helper_path)
        self.assertNotEqual(old_helper["content_hash"], new_helper["content_hash"])

    def _stage(self):
        from aria_kernel import validation as validation_module

        # `aria-tools/*` is ignored in the real repository (.gitignore:34) —
        # mirrored here because the baseline validation refuses a dirty tree,
        # and every ledger write during staging lands under aria-tools.
        (self.repo / ".gitignore").write_text("aria-tools/*\n", encoding="utf-8")
        plan = production_converged_plan(
            tools_dir=self.tools,
            workspace_root=self.repo,
            affected_paths=[FIXTURE_CHANGED_FILE],
        )
        # The agent-file write above dirties the worktree; the real
        # run_validation_commands refuses a dirty tree, exactly as it will on
        # the executor lane, so the fixture commits before staging.
        self._commit_all("fixture: converged plan agent file")
        with _fake_child_process(validation_module):
            staged = stage_converged_plan_for_pr(
                plan_id=plan.plan_id,
                workspace_root=self.repo,
                base_dir=self.tools,
            )
        return plan, staged

    def _commit_all(self, message: str) -> None:
        import subprocess as _sp
        _sp.run(["git", "add", "-A"], cwd=self.repo, check=True)
        _sp.run(
            ["git", "commit", "-q", "-m", message],
            cwd=self.repo, check=True, capture_output=True,
        )

    def _implement_on(self, branch: str) -> None:
        """What the implementer does between the envelope and the gate."""
        import subprocess as _sp
        _sp.run(["git", "checkout", "-q", "-b", branch], cwd=self.repo, check=True)
        changed = self.repo / FIXTURE_CHANGED_FILE
        changed.write_text(
            "export const WATER_QUALITY_SAMPLE_INTERVAL_MS = 30000;\n",
            encoding="utf-8",
        )
        _sp.run(["git", "add", FIXTURE_CHANGED_FILE], cwd=self.repo, check=True)
        _sp.run(
            ["git", "commit", "-q", "-m", "[ARIA-AUTO] implement the converged plan"],
            cwd=self.repo, check=True, capture_output=True,
        )

    def test_staging_mints_the_ids_the_pr_opener_demands(self) -> None:
        plan, staged = self._stage()
        self.assertTrue(staged["proposal_id"].startswith("proposal-"))
        self.assertTrue(staged["change_id"])
        self.assertRegex(staged["branch"], f"^{ARIA_IMPL_BRANCH_FRAGMENT}$")
        self.assertTrue(str(staged["baseline_ref"]).startswith("sha256:"))

        from aria_kernel.proposal import get_proposal
        proposal = get_proposal(proposal_id=staged["proposal_id"], base_dir=self.tools)
        self.assertEqual(proposal["status"], "approved_for_apply")
        self.assertEqual(proposal["source_authority"], "plan_convergence")
        # ORPHAN-CRITICAL-728 — the machine approval names the plan AND the
        # exact converged body, and it lands in the MACHINE column with
        # approval_source recorded; the operator column stays empty because
        # no operator did anything.
        self.assertEqual(proposal["approval_source"], "machine")
        self.assertIsNone(proposal["operator_approval_ref"])
        self.assertEqual(
            proposal["machine_approval_ref"],
            f"{PLAN_CONVERGED_APPROVAL_PREFIX}{plan.plan_id}:{plan.content_hash}",
        )
        # The staged suite is the spelling the validation runner accepts.
        for command in CANONICAL_VALIDATION_COMMANDS_EXECUTABLE:
            self.assertIn(command, proposal["validation_scope"]["commands"])

    def test_full_chain_converged_to_pr_dry_run(self) -> None:
        from aria_kernel import validation as validation_module

        _plan, staged = self._stage()
        self._implement_on(staged["branch"])
        with _fake_child_process(validation_module):
            gated = run_apply_gate(
                proposal_id=staged["proposal_id"],
                change_id=staged["change_id"],
                base_dir=self.tools,
                runner_identity="ci-executor:gha-test",
            )
        self.assertEqual(gated["status"], "ready_for_pr")
        self.assertTrue(gated["validation_gate_ref"])

        result = open_pr_for_action(
            proposal_id=staged["proposal_id"],
            workspace_root=self.repo,
            base_dir=self.tools,
            dry_run=True,
        )
        self.assertEqual(result["base_branch"], "main")
        # The PR is anchored to the tip of the KERNEL-MINTED branch, not to
        # whatever the working checkout happens to be on.
        self.assertEqual(
            result["head_sha"], _rev_parse(self.repo, staged["branch"]),
        )
        self.assertIn("## Provenance", result["body"])

    def test_skipping_the_gate_keeps_the_pinned_refusal(self) -> None:
        """Staging alone must NOT be enough to open a PR.

        The staged action is inert (`staged_for_implementation`): if staging
        also promoted it, the machine approval would have bought a PR with no
        validation evidence at all — the opposite of what the ref claims.
        """
        _plan, staged = self._stage()
        self._implement_on(staged["branch"])
        with self.assertRaisesRegex(GovernanceError, "validation gate"):
            open_pr_for_action(
                proposal_id=staged["proposal_id"],
                workspace_root=self.repo,
                base_dir=self.tools,
                dry_run=True,
            )

    def test_gate_refuses_a_change_id_the_staging_did_not_open(self) -> None:
        _plan, staged = self._stage()
        self._implement_on(staged["branch"])
        with self.assertRaisesRegex(GovernanceError, "apply_gate_change_id_mismatch"):
            run_apply_gate(
                proposal_id=staged["proposal_id"],
                change_id="chg-somebody-elses",
                base_dir=self.tools,
            )

    def test_gate_cli_exits_nonzero_when_the_gate_blocks(self) -> None:
        """The implementer reads the EXIT CODE, not the JSON.

        Its contract says "non-zero exit = blocked: emit the refusal envelope,
        no PR". If the arm returned 0 on a blocked gate the agent would walk
        straight into `pr create` and hit a refusal it could not diagnose.
        """
        import subprocess as _sp
        from contextlib import redirect_stdout
        import io

        from aria_kernel import validation as validation_module
        from aria_kernel.cli import main as cli_main

        _plan, staged = self._stage()
        self._implement_on(staged["branch"])

        real_run = _sp.run

        def _failing_child(argv, *args, **kwargs):
            if argv and str(argv[0]) in ("npx", "npm", "cargo"):
                return _sp.CompletedProcess(argv, 1, "", "1 test failed\n")
            return real_run(argv, *args, **kwargs)

        with patch.object(validation_module.subprocess, "run", _failing_child):
            buffer = io.StringIO()
            with redirect_stdout(buffer):
                code = cli_main(
                    [
                        "apply", "gate",
                        "--tools-dir", str(self.tools),
                        "--proposal-id", staged["proposal_id"],
                        "--change-id", staged["change_id"],
                        "--runner-identity", "ci-executor:gha-test",
                    ],
                )
        self.assertEqual(code, 1)
        row = json.loads(buffer.getvalue())
        self.assertEqual(row["status"], "blocked")

    def test_the_apply_actions_surface_keeps_its_declared_writers(self) -> None:
        """Exactly two functions in the whole kernel append to apply_actions.

        ORPHAN-CRITICAL-728 rewrites this pin. It used to grep the source of
        two HAND-NAMED functions for `append_declared_jsonl` and conclude the
        surface had one writer — while `gate_apply_action`, in the same
        module, was already the third `append_declared_jsonl(...,
        expected_surface="apply_actions")` call site. A pin that names the
        functions it checks cannot see the writer it was not told about, which
        is the only writer that matters.

        This walks EVERY module in the package by AST and collects the
        enclosing function of every append to this surface. The surface has
        two legitimate writers with different jobs — `_record_apply_action`
        OPENS an action, `gate_apply_action` PROMOTES it — and a third one
        appearing anywhere fails here by construction.
        """
        import ast

        from aria_kernel import apply_engine

        package_root = Path(apply_engine.__file__).parent
        writers: set[str] = set()
        for module_path in sorted(package_root.rglob("*.py")):
            tree = ast.parse(module_path.read_text(encoding="utf-8"))
            enclosing: dict[ast.AST, str] = {}
            for node in ast.walk(tree):
                if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                    for child in ast.walk(node):
                        enclosing.setdefault(child, node.name)
            for node in ast.walk(tree):
                if not isinstance(node, ast.Call):
                    continue
                func = node.func
                name = func.attr if isinstance(func, ast.Attribute) else getattr(func, "id", None)
                if name != "append_declared_jsonl":
                    continue
                for keyword in node.keywords:
                    if (
                        keyword.arg == "expected_surface"
                        and isinstance(keyword.value, ast.Constant)
                        and keyword.value.value == "apply_actions"
                    ):
                        writers.add(
                            f"{module_path.name}:"
                            f"{enclosing.get(node, '<module>')}"
                        )
        self.assertEqual(
            writers,
            {
                "apply_engine.py:_record_apply_action",
                "apply_engine.py:gate_apply_action",
            },
        )
        # And both producers still route through the opener rather than
        # appending themselves — the half of the old pin that was true.
        import inspect

        for producer in (
            apply_engine.plan_apply_worktree,
            apply_engine.stage_converged_plan_for_pr,
        ):
            source = inspect.getsource(producer)
            self.assertIn("_record_apply_action(", source)
            self.assertNotIn("append_declared_jsonl", source)

    def test_the_gate_can_run_from_a_second_checkout(self) -> None:
        """ORPHAN-CRITICAL-728 — `apply gate` gained `--workspace-root`.

        It read the path off the ledger row with no override, while its
        sibling `pr create` has always taken one. That works today only
        because both GHA jobs happen to check out at the same path.
        """
        import subprocess as _sp

        from aria_kernel import validation as validation_module

        _plan, staged = self._stage()
        self._implement_on(staged["branch"])
        other = self.repo.parent / "second-checkout"
        _sp.run(
            ["git", "clone", "-q", str(self.repo), str(other)],
            check=True, capture_output=True,
        )
        _sp.run(["git", "config", "user.email", "t@t.invalid"], cwd=other, check=True)
        _sp.run(["git", "config", "user.name", "t"], cwd=other, check=True)
        _sp.run(["git", "checkout", "-q", staged["branch"]], cwd=other, check=True)
        try:
            with _fake_child_process(validation_module):
                gated = run_apply_gate(
                    proposal_id=staged["proposal_id"],
                    change_id=staged["change_id"],
                    base_dir=self.tools,
                    runner_identity="ci-executor:gha-test",
                    workspace_root=other,
                )
            self.assertEqual(gated["status"], "ready_for_pr")
            # And the CLI arm forwards it, so the implementer can use it.
            import inspect

            from aria_kernel import cli

            source = inspect.getsource(cli)
            self.assertIn('a_gate.add_argument(\n        "--workspace-root"', source)
            self.assertIn("workspace_root=args.workspace_root,", source)
        finally:
            import shutil
            shutil.rmtree(other, ignore_errors=True)

    def test_the_change_rows_finding_id_resolves_to_the_plan(self) -> None:
        """ORPHAN-CRITICAL-728 — a derived POINTER, not a defaulted claim.

        `architectural_tier=3` asserted a property of the change that nobody
        measured, and was deleted. `finding_id="plan:<plan_id>"` is a
        different animal: it is an identity, in its own namespace, and it must
        look up. This is the check that keeps it that way.
        """
        from aria_kernel.apply_engine import PLAN_FINDING_ID_PREFIX
        from aria_kernel.change_ledger import get_change_chain
        from aria_kernel.plan_convergence import fold_plan_state

        plan, staged = self._stage()
        chain = get_change_chain(change_id=staged["change_id"], base_dir=self.tools)
        finding_id = chain["planned"]["finding_id"]
        self.assertTrue(finding_id.startswith(PLAN_FINDING_ID_PREFIX))
        named_plan = finding_id[len(PLAN_FINDING_ID_PREFIX):]
        self.assertEqual(named_plan, plan.plan_id)
        self.assertEqual(
            fold_plan_state(plan_id=named_plan, base_dir=self.tools)["state"],
            "CONVERGED",
        )
        # And the tier on the row is the plan's own claim, not a constant.
        self.assertEqual(
            chain["planned"]["architectural_tier"],
            plan.plan_content["architectural_tier"],
        )

    def test_a_contract_complete_converged_plan_stages_past_both_refusals(self) -> None:
        """The plan contract closes the loop trial ten died in.

        A plan that CONVERGED through the real gate carrying a tier claim and
        a validation set drawn from the contract — the canonical suite plus a
        recipe the operator registered, declared by `recipe_id` — passes the
        `plan_contract_complete` row, and staging runs the recipe's command
        beside the canonical suite instead of refusing the plan.
        """
        from aria_kernel import validation as validation_module
        from aria_kernel.experiment import register_recipe
        from aria_kernel.plan_convergence import fold_plan_state

        register_recipe(
            recipe_id="kernel-unit-suite",
            command="python3 -m unittest discover aria-kernel -p '*test*.py'",
            timeout_ms=1_500_000, deterministic=True, base_dir=self.tools,
        )
        (self.repo / ".gitignore").write_text("aria-tools/*\n", encoding="utf-8")
        plan = production_converged_plan(
            tools_dir=self.tools, workspace_root=self.repo, plan_id="plan-contract-complete",
            affected_paths=[FIXTURE_CHANGED_FILE],
            validation_commands=[{"cmd": "nx affected --target=lint"}, {"recipe_id": "kernel-unit-suite"}],
        )
        evaluated = next(
            row for row in reversed(fold_plan_state(plan_id=plan.plan_id, base_dir=self.tools)["events"])
            if row["event_type"] == "plan_evaluated"
        )
        gate = next(item for item in evaluated["payload"]["gate_decisions"] if item["gate"] == "plan_contract_complete")
        self.assertEqual(gate, {"gate": "plan_contract_complete", "passed": True, "reasons": []})
        self._commit_all("fixture: contract-complete converged plan")
        with _fake_child_process(validation_module):
            staged = stage_converged_plan_for_pr(
                plan_id=plan.plan_id, workspace_root=self.repo, base_dir=self.tools,
            )
        action = _latest_staged_action(self.tools, staged["proposal_id"])
        self.assertEqual(
            action["validation_commands"],
            [*CANONICAL_VALIDATION_COMMANDS_EXECUTABLE, "python3 -m unittest discover aria-kernel -p '*test*.py'"],
        )

    def test_staging_refuses_a_plan_that_claims_no_tier(self) -> None:
        """ORPHAN-CRITICAL-728 — no silent Tier-3 default.

        Staging used to substitute 3 whenever the plan claimed nothing, and
        `architectural_tier` is not a field any plan claims by accident: EVERY
        autonomous change entered the change ledger as Tier 3 forever, which
        reduced this repository's Tier-1..4 vocabulary to a constant an
        auditor cannot tell from a real claim.
        """
        plan = production_converged_plan(
            tools_dir=self.tools,
            workspace_root=self.repo,
            plan_id="plan-no-tier",
            affected_paths=[FIXTURE_CHANGED_FILE],
        )
        # Re-record the plan body without the tier claim by patching the
        # ledger reader's answer: the claim is the thing under test, not the
        # ledger. `converged_plan_body` is the single reader staging uses.
        from aria_kernel import apply_engine

        body = dict(plan.plan_content)
        body.pop("architectural_tier")
        with patch.object(
            apply_engine, "_intended_files_from_plan",
            wraps=apply_engine._intended_files_from_plan,
        ), patch(
            "aria_kernel.plan_convergence.plan_body_from_state",
            return_value={
                "plan_content": body,
                "revision_id": plan.revision_id,
                "content_hash": plan.content_hash,
            },
        ):
            with self.assertRaisesRegex(
                GovernanceError, "stage_requires_architectural_tier",
            ):
                stage_converged_plan_for_pr(
                    plan_id=plan.plan_id,
                    workspace_root=self.repo,
                    base_dir=self.tools,
                )

    def test_staging_refuses_a_plan_authored_validation_command(self) -> None:
        """ORPHAN-CRITICAL-728 — plan text may not become a kernel subprocess.

        `run_validation_commands` executes OUTSIDE the implementer's bwrap
        sandbox, and `validation_commands` is plan content written by one LLM
        and reviewed by others. The previous body appended anything
        `parse_allowed_command` admitted — and it admits
        `python3 -m unittest <anything>` with no target restriction and
        permits a `PYTHONPATH=` override.
        """
        from aria_kernel.apply_engine import _staged_validation_commands

        with self.assertRaisesRegex(
            GovernanceError, "stage_validation_command_not_declared",
        ):
            _staged_validation_commands(
                {"validation_commands": [
                    {"cmd": "PYTHONPATH=/tmp/evil python3 -m unittest payload"},
                ]},
                base_dir=self.tools,
            )

    def test_staging_runs_an_operator_registered_recipe(self) -> None:
        """The seam a new executable goes through: the operator recipe registry."""
        from aria_kernel.apply_engine import _staged_validation_commands
        from aria_kernel.experiment import register_recipe

        register_recipe(
            recipe_id="kernel-unit-suite",
            command="python3 -m unittest discover aria-kernel -p '*test*.py'",
            timeout_ms=1_500_000,
            deterministic=True,
            base_dir=self.tools,
        )
        commands, timeout_ms = _staged_validation_commands(
            {"validation_commands": [{"recipe_id": "kernel-unit-suite"}]},
            base_dir=self.tools,
        )
        self.assertIn(
            "python3 -m unittest discover aria-kernel -p '*test*.py'", commands,
        )
        for canonical in CANONICAL_VALIDATION_COMMANDS_EXECUTABLE:
            self.assertIn(canonical, commands)
        # The ceiling is the max of the canonical budget and the recipe's.
        self.assertEqual(timeout_ms, CANONICAL_VALIDATION_TIMEOUT_MS)

    def test_the_canonical_suite_gets_a_runnable_timeout(self) -> None:
        """ORPHAN-CRITICAL-728 — 120s could never finish `nx affected --target=test`.

        Both sides of the comparison took `run_validation_commands`'s default,
        both recorded status="failed", `_regression_status` read that as
        `no_regression`, and `evaluate_validation_gate`'s require_worktree_ok
        blocked forever — the gate could not pass whatever the code did.
        """
        from aria_kernel import validation as validation_module
        from aria_kernel.apply_engine import run_apply_gate

        self.assertGreater(CANONICAL_VALIDATION_TIMEOUT_MS, 120_000)
        _plan, staged = self._stage()
        action = _latest_staged_action(self.tools, staged["proposal_id"])
        self.assertEqual(
            action["validation_timeout_ms"], CANONICAL_VALIDATION_TIMEOUT_MS,
        )
        # And the gate measures the candidate under the SAME ceiling, off the
        # staged row — two sides measured differently are not a comparison.
        self._implement_on(staged["branch"])
        seen: list[int] = []
        real = validation_module.run_validation_commands

        def _record(**kwargs):
            seen.append(kwargs.get("timeout_ms"))
            return real(**kwargs)

        with _fake_child_process(validation_module), patch(
            "aria_kernel.apply_engine.run_validation_commands", _record,
        ):
            run_apply_gate(
                proposal_id=staged["proposal_id"],
                change_id=staged["change_id"],
                base_dir=self.tools,
                runner_identity="ci-executor:gha-test",
            )
        self.assertEqual(seen, [action["validation_timeout_ms"]])

    def test_gate_refuses_to_validate_a_tree_it_is_not_standing_on(self) -> None:
        """ORPHAN-CRITICAL-728 — validation evidence for a commit never run.

        The gate passed `commit_sha=rev-parse <branch>` while the commands
        executed in the workspace at whatever HEAD was checked out. With HEAD
        on the base branch the suite measured the base, passed, and every row
        in the `validation-runs` ledger — the ledger the merge gate joins on —
        claimed the branch tip. `gate_apply_action`'s non-empty-diff check
        cannot catch it: `git diff base..branch` is still non-empty.
        """
        import subprocess as _sp

        from aria_kernel import validation as validation_module

        _plan, staged = self._stage()
        self._implement_on(staged["branch"])
        _sp.run(["git", "checkout", "-q", "-"], cwd=self.repo, check=True)
        with _fake_child_process(validation_module):
            with self.assertRaisesRegex(
                GovernanceError, "apply_gate_head_is_not_the_branch",
            ):
                run_apply_gate(
                    proposal_id=staged["proposal_id"],
                    change_id=staged["change_id"],
                    base_dir=self.tools,
                    runner_identity="ci-executor:gha-test",
                )

    def test_staging_and_the_gate_are_profile_gated(self) -> None:
        """ORPHAN-CRITICAL-728 — a cell in ACTION_PERMISSIONS is what gates them.

        Neither entry point called `enforce_profile_for_action` and neither
        action had a cell, so the implementer's Bash allowlist admitted
        `apply gate` under `observe`, under `frozen` and with the failure
        breaker tripped — and `PROFILES_WITH_ACTION_AUTHORITY` is DERIVED from
        that table, so the breaker did not know these actions existed.
        """
        from aria_kernel.runtime_profile import (
            ACTION_PERMISSIONS,
            PROFILES_WITH_ACTION_AUTHORITY,
        )

        self.assertEqual(
            ACTION_PERMISSIONS["plan_stage"], frozenset({"strict", "autonomous"}),
        )
        self.assertEqual(
            ACTION_PERMISSIONS["apply_gate"], frozenset({"strict", "autonomous"}),
        )
        self.assertNotIn("observe", PROFILES_WITH_ACTION_AUTHORITY)

        _plan, staged = self._stage()
        self._implement_on(staged["branch"])
        set_profile(
            "observe",
            operator_approval_ref="test:orphan-critical-728:profile-gate",
            base_dir=self.tools,
            set_by="test-fixture",
        )
        with self.assertRaisesRegex(GovernanceError, "profile_violation"):
            run_apply_gate(
                proposal_id=staged["proposal_id"],
                change_id=staged["change_id"],
                base_dir=self.tools,
            )
        with self.assertRaisesRegex(GovernanceError, "profile_violation"):
            stage_converged_plan_for_pr(
                plan_id="plan-anything",
                workspace_root=self.repo,
                base_dir=self.tools,
            )

    def test_staging_refuses_a_plan_that_did_not_converge(self) -> None:
        """The approval ref claims convergence, so it may only exist when true."""
        from aria_kernel.plan_convergence import start_plan

        plan_content = {
            "schema_version": 1,
            "title": "Draft plan",
            "summary": "Not converged.",
            "affected_surfaces": [{"paths": [FIXTURE_CHANGED_FILE]}],
            "key_changes": ["change something"],
            "validation_commands": [{"cmd": "python3 -m unittest discover aria-kernel -p '*test*.py'"}],
            "evidence_refs": ["docs/aria/SPEC.md"],
        }
        start_plan(
            plan_id="plan-draft-only",
            initial_revision_id="rev-0",
            plan_content=plan_content,
            base_dir=self.tools,
        )
        with self.assertRaisesRegex(GovernanceError, "stage_requires_converged_plan"):
            stage_converged_plan_for_pr(
                plan_id="plan-draft-only",
                workspace_root=self.repo,
                base_dir=self.tools,
            )


class PushBaseBranchProtectionTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tools = _seed_tools()
        self.repo = self.tools.parent

    def tearDown(self) -> None:
        import shutil
        shutil.rmtree(self.repo, ignore_errors=True)

    def test_push_rejects_snowball_branch(self) -> None:
        # Historical ARIA work branch remains protected from direct push.
        commit_row = {
            "schema_version": 1,
            "proposal_id": "PROP-Z",
            "branch": "snowball",
            "action": "commit",
            "status": "committed",
        }
        append_declared_fixture(
            self.tools / "pr-actions.jsonl",
            commit_row,
            expected_surface="pr_actions",
        )
        with self.assertRaisesRegex(GovernanceError, "base branch push is forbidden|aria/\\.\\.\\. branches"):
            push_prepared_branch(
                proposal_id="PROP-Z",
                workspace_root=self.repo,
                base_dir=self.tools,
                dry_run=False,
            )

    def test_push_rejects_main_branch(self) -> None:
        commit_row = {
            "schema_version": 1,
            "proposal_id": "PROP-Z",
            "branch": "main",
            "action": "commit",
            "status": "committed",
        }
        append_declared_fixture(
            self.tools / "pr-actions.jsonl",
            commit_row,
            expected_surface="pr_actions",
        )
        with self.assertRaisesRegex(GovernanceError, "base branch push is forbidden|aria/\\.\\.\\. branches"):
            push_prepared_branch(
                proposal_id="PROP-Z",
                workspace_root=self.repo,
                base_dir=self.tools,
                dry_run=False,
            )


class ApplyGateSuppressionScanTests(unittest.TestCase):
    """Plan 017 Phase 3.3 — gate_apply_action diff_text optional kwarg."""

    def setUp(self) -> None:
        self.tools = _seed_tools()
        self.repo = self.tools.parent

    def tearDown(self) -> None:
        import shutil
        shutil.rmtree(self.repo, ignore_errors=True)

    def _seed_validation_gate_row(self, comparison_ref: str = "sha256:cmp-ref") -> str:
        # Validation rows live under tools/validation/. Seed a passing one.
        gate_row = {
            "schema_version": 1,
            "comparison_ref": comparison_ref,
            "status": "ready_for_pr",
            "blocked_by": [],
            "ledger_hash": "sha256:gate-ledger-hash",
            "previous_ledger_hash": None,
        }
        append_declared_fixture(
            self.tools / "validation" / "validation-gates.jsonl",
            gate_row,
            expected_surface="validation_gates",
        )
        return comparison_ref

    def _seed_proposal_and_action(self) -> str:
        proposal = _seed_proposal(tools=self.tools)
        _seed_apply_action(tools=self.tools, proposal_id=proposal["proposal_id"], status="planned")
        return proposal["proposal_id"]

    def test_clean_diff_lets_gate_pass(self) -> None:
        pid = self._seed_proposal_and_action()
        cmp_ref = self._seed_validation_gate_row()
        clean_diff = (
            "diff --git a/apps/foo.ts b/apps/foo.ts\n"
            "--- a/apps/foo.ts\n"
            "+++ b/apps/foo.ts\n"
            "@@ -1,1 +1,2 @@\n"
            " const x = 1;\n"
            "+const y = 2;\n"
        )
        # Patch evaluate_validation_gate to return our seeded shape directly.
        with patch(
            "aria_kernel.apply_engine.evaluate_validation_gate",
            return_value={
                "comparison_ref": cmp_ref,
                "status": "ready_for_pr",
                "blocked_by": [],
                "ledger_hash": "sha256:gate-ledger-hash",
            },
        ):
            row = gate_apply_action(
                proposal_id=pid,
                validation_comparison_ref=cmp_ref,
                base_dir=self.tools,
                diff_text=clean_diff,
            )
        self.assertEqual(row["status"], "ready_for_pr")
        self.assertEqual(row["suppression_matches"], [])
        self.assertNotIn("suppression_pattern", row["blocked_by"])

    def test_diff_with_ts_ignore_blocks_action(self) -> None:
        pid = self._seed_proposal_and_action()
        cmp_ref = self._seed_validation_gate_row()
        bad_diff = (
            "diff --git a/apps/foo.ts b/apps/foo.ts\n"
            "--- a/apps/foo.ts\n"
            "+++ b/apps/foo.ts\n"
            "@@ -1,1 +1,2 @@\n"
            " const x = 1;\n"
            "+// @ts-ignore\n"
        )
        with patch(
            "aria_kernel.apply_engine.evaluate_validation_gate",
            return_value={
                "comparison_ref": cmp_ref,
                "status": "ready_for_pr",
                "blocked_by": [],
                "ledger_hash": "sha256:gate-ledger-hash",
            },
        ):
            row = gate_apply_action(
                proposal_id=pid,
                validation_comparison_ref=cmp_ref,
                base_dir=self.tools,
                diff_text=bad_diff,
            )
        self.assertEqual(row["status"], "blocked")
        self.assertIn("suppression_pattern", row["blocked_by"])
        self.assertEqual(len(row["suppression_matches"]), 1)
        self.assertEqual(row["suppression_matches"][0]["category"], "ts_masking")

    def test_no_diff_text_now_fails_closed(self) -> None:
        # Plan 022 §H-1 — pre-fix gate_apply_action(diff_text=None)
        # silently skipped suppression scan and returned ready_for_pr.
        # That was the bug. Post-fix: caller MUST either pass a diff
        # explicitly OR seed the action with branch+base_sha so the
        # fallback can run `git diff base..branch`. The test now
        # asserts the new fail-closed contract.
        pid = self._seed_proposal_and_action()
        cmp_ref = self._seed_validation_gate_row()
        with patch(
            "aria_kernel.apply_engine.evaluate_validation_gate",
            return_value={
                "comparison_ref": cmp_ref,
                "status": "ready_for_pr",
                "blocked_by": [],
                "ledger_hash": "sha256:gate-ledger-hash",
            },
        ):
            with self.assertRaises(GovernanceError) as cm:
                gate_apply_action(
                    proposal_id=pid,
                    validation_comparison_ref=cmp_ref,
                    base_dir=self.tools,
                    # diff_text=None implicit
                )
        self.assertIn("suppression_scan_requires_diff_content", str(cm.exception))

    def test_empty_diff_text_explicit_rejected_post_d6(self) -> None:
        # Plan 026R §D.6 INVERSION — the pre-§D.6 contract said "an
        # explicit empty diff is a valid no-content claim; suppression
        # scan over empty input returns zero matches". §D.6 invalidates
        # that: an empty diff is NOT a clean diff. The gate now
        # raises on empty diff_text explicitly, structurally
        # impossible to pass.
        pid = self._seed_proposal_and_action()
        cmp_ref = self._seed_validation_gate_row()
        with patch(
            "aria_kernel.apply_engine.evaluate_validation_gate",
            return_value={
                "comparison_ref": cmp_ref,
                "status": "ready_for_pr",
                "blocked_by": [],
                "ledger_hash": "sha256:gate-ledger-hash",
            },
        ):
            with self.assertRaises(GovernanceError) as ctx:
                gate_apply_action(
                    proposal_id=pid,
                    validation_comparison_ref=cmp_ref,
                    base_dir=self.tools,
                    diff_text="",
                )
        self.assertIn("empty", str(ctx.exception).lower())


if __name__ == "__main__":
    unittest.main()
