"""E21-d (ORPHAN-693) — the nightly experiment trigger.

Planner selection policy, fold semantics with an injected runner, one
END-TO-END night with the REAL runner executing an allowlisted command,
and the cycle-table pin (existing precondition, record_and_continue).
"""
from __future__ import annotations

import json
import subprocess
import tempfile
import unittest
from pathlib import Path

from aria_kernel.experiment import (
    observations_path,
    register_experiment,
    register_recipe,
)
from aria_kernel.experiment_night import (
    MAX_PROBLEM_RUNS_PER_NIGHT,
    plan_night_experiments,
    run_night_experiments,
)
from aria_kernel.finding import (
    emit_finding,
    record_finding_fix_verification,
    record_finding_reproduction,
    show_finding,
)
from aria_kernel.ledger import append_declared_jsonl
from aria_kernel.tool_registry import ensure_tools_dir
from aria_kernel.workspace import ensure_workspace, workspace_paths


def _seed_repo() -> Path:
    tmp = Path(tempfile.mkdtemp(prefix="aria-night-test-"))
    for i in range(1, 4):
        path = tmp / "apps" / "farm-service" / "src" / f"module{i}.ts"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("\n".join(f"line {n}" for n in range(1, 45)) + "\n", encoding="utf-8")
    subprocess.run(["git", "init", "-q"], cwd=tmp, check=True)
    subprocess.run(["git", "config", "user.email", "aria-test@example.com"], cwd=tmp, check=True)
    subprocess.run(["git", "config", "user.name", "ARIA Test"], cwd=tmp, check=True)
    subprocess.run(["git", "add", "apps"], cwd=tmp, check=True)
    subprocess.run(["git", "commit", "-q", "-m", "seed"], cwd=tmp, check=True)
    paths = workspace_paths(tmp, tmp / "workspaces")
    ensure_workspace(paths)
    ensure_tools_dir(tmp / "aria-tools")
    return tmp


def _evidence(n: int = 3) -> list[dict[str, object]]:
    return [
        {"ref": f"apps/farm-service/src/module{i}.ts:10", "summary": f"evidence {i}"}
        for i in range(1, n + 1)
    ]


class NightBase(unittest.TestCase):
    def setUp(self) -> None:
        self.repo = _seed_repo()
        self.tools = self.repo / "aria-tools"

    def tearDown(self) -> None:
        import shutil

        shutil.rmtree(self.repo, ignore_errors=True)

    def _finding(self, *, severity: str = "LOW", suffix: str = "1") -> str:
        record = emit_finding(
            repo_root=self.repo,
            base_dir=self.tools,
            claim_type="duplication",
            claim_summary=f"Modules duplicate helper number {suffix}",
            severity=severity,
            evidences=_evidence(3),
            facts=["fact a", "fact b", "fact c"],
            scope_files=["apps/farm-service/src/module1.ts"],
        )
        return record["finding_id"]

    def _bind_experiment(self, finding_id: str, *, experiment_id: str,
                         recipe_id: str = "recipe-night",
                         expected: str = "failed") -> None:
        register_experiment(
            experiment_id=experiment_id,
            hypothesis=f"{finding_id} shows as a {expected} run",
            recipe_ref=recipe_id,
            observation_contract={"comparator": "status_equals", "expected": expected},
            finding_ref=finding_id,
            base_dir=self.tools,
        )

    def _fake_runner(self, *, matched: bool, run_status: str):
        """A runner that appends a REAL observation row (the bridge resolves
        it from the ledger) and returns it, without spawning a process."""
        counter = {"n": 0}

        def run(**kwargs):
            counter["n"] += 1
            run_id = f"night-run-{counter['n']}"
            return append_declared_jsonl(
                observations_path(self.tools),
                {
                    "schema_version": 1,
                    "recorded_at": "2026-08-16T00:00:00Z",
                    "cycle_id": kwargs.get("cycle_id"),
                    "experiment_id": kwargs.get("experiment_id"),
                    "recipe_ref": "recipe-night",
                    "hypothesis": "h",
                    "change_id": kwargs.get("change_id"),
                    "commit_sha": kwargs.get("commit_sha"),
                    "runner_identity": kwargs.get("runner_identity"),
                    "validation_run_id": run_id,
                    "validation_plan_ref": "sha256:test",
                    "comparator": "status_equals",
                    "expected": "failed",
                    "observed": run_status,
                    "matched": matched,
                    "run_status": run_status,
                },
                expected_surface="experiment_observations",
            )

        return run


class NightPlannerTests(NightBase):
    def setUp(self) -> None:
        super().setUp()
        register_recipe(
            recipe_id="recipe-night", command="npx nx test farm-service",
            timeout_ms=60000, deterministic=True, base_dir=self.tools,
        )

    def test_planner_orders_by_severity_and_discloses_caps(self) -> None:
        ids = []
        for i, severity in enumerate(["LOW", "HIGH", "MEDIUM", "LOW", "HIGH"], start=1):
            fid = self._finding(severity=severity, suffix=str(i))
            self._bind_experiment(fid, experiment_id=f"exp-{i}")
            ids.append((fid, severity))
        plan = plan_night_experiments(self.repo, base_dir=self.tools)
        self.assertEqual(len(plan["problem"]), MAX_PROBLEM_RUNS_PER_NIGHT)
        severities = [item["severity"] for item in plan["problem"]]
        self.assertEqual(severities, ["HIGH", "HIGH", "MEDIUM"])
        self.assertEqual(plan["skipped_problem"], 2)

    def test_planner_excludes_reproduced_and_closed_findings(self) -> None:
        fid = self._finding(severity="HIGH")
        self._bind_experiment(fid, experiment_id="exp-repro")
        # reproduce via the bridge so doc carries the reproduction block
        append_declared_jsonl(
            observations_path(self.tools),
            {
                "schema_version": 1, "recorded_at": "2026-08-16T00:00:00Z",
                "cycle_id": None, "experiment_id": "exp-repro",
                "recipe_ref": "recipe-night", "hypothesis": "h",
                "change_id": "change-1", "commit_sha": "a" * 40,
                "runner_identity": "t", "validation_run_id": "run-red",
                "validation_plan_ref": "sha256:test",
                "comparator": "status_equals", "expected": "failed",
                "observed": "failed", "matched": True, "run_status": "failed",
            },
            expected_surface="experiment_observations",
        )
        record_finding_reproduction(
            self.repo, finding_id=fid, validation_run_id="run-red",
            base_dir=self.tools,
        )
        plan = plan_night_experiments(self.repo, base_dir=self.tools)
        self.assertEqual(plan["problem"], [])

    def test_planner_discloses_unresolvable_finding_refs(self) -> None:
        register_experiment(
            experiment_id="exp-typo",
            hypothesis="a ref no finding answers",
            recipe_ref="recipe-night",
            observation_contract={"comparator": "status_equals", "expected": "failed"},
            finding_ref="F-999",
            base_dir=self.tools,
        )
        plan = plan_night_experiments(self.repo, base_dir=self.tools)
        self.assertEqual(plan["problem"], [])
        self.assertEqual(
            plan["unresolvable_bindings"],
            [{"experiment_id": "exp-typo", "finding_ref": "F-999"}],
        )

    def test_planner_ignores_unbound_experiments(self) -> None:
        register_experiment(
            experiment_id="exp-unbound",
            hypothesis="an unbound hypothesis about the tree",
            recipe_ref="recipe-night",
            observation_contract={"comparator": "status_equals", "expected": "failed"},
            base_dir=self.tools,
        )
        plan = plan_night_experiments(self.repo, base_dir=self.tools)
        self.assertEqual(plan["problem"], [])


class NightFoldTests(NightBase):
    def setUp(self) -> None:
        super().setUp()
        register_recipe(
            recipe_id="recipe-night", command="npx nx test farm-service",
            timeout_ms=60000, deterministic=True, base_dir=self.tools,
        )

    def test_matched_red_run_confirms_finding(self) -> None:
        fid = self._finding(severity="HIGH")
        self._bind_experiment(fid, experiment_id="exp-1")
        payload = run_night_experiments(
            self.repo, cycle_id="cycle-n1", base_dir=self.tools,
            runner=self._fake_runner(matched=True, run_status="failed"),
        )
        self.assertEqual(len(payload["reproduced"]), 1)
        self.assertEqual(payload["errors"], [])
        self.assertEqual(show_finding(self.repo, fid)["certainty"], "CONFIRMED")

    def test_unmatched_run_is_refuted_not_promoted(self) -> None:
        fid = self._finding(severity="HIGH")
        self._bind_experiment(fid, experiment_id="exp-1")
        payload = run_night_experiments(
            self.repo, cycle_id="cycle-n1", base_dir=self.tools,
            runner=self._fake_runner(matched=False, run_status="ok"),
        )
        self.assertEqual(payload["reproduced"], [])
        self.assertEqual(len(payload["refuted"]), 1)
        self.assertEqual(show_finding(self.repo, fid)["certainty"], "OBSERVED")

    def _resolved_binding(self) -> str:
        fid = self._finding(severity="HIGH")
        self._bind_experiment(fid, experiment_id="exp-1")
        # The SOLUTION experiment: same recipe, green contract, same finding.
        self._bind_experiment(
            fid, experiment_id="exp-1-fix", expected="ok",
        )
        for run_id, experiment_id, expected, status in (
            ("run-red", "exp-1", "failed", "failed"),
            ("run-green", "exp-1-fix", "ok", "ok"),
        ):
            append_declared_jsonl(
                observations_path(self.tools),
                {
                    "schema_version": 1, "recorded_at": "2026-08-16T00:00:00Z",
                    "cycle_id": None, "experiment_id": experiment_id,
                    "recipe_ref": "recipe-night", "hypothesis": "h",
                    "change_id": "change-fix", "commit_sha": "a" * 40,
                    "runner_identity": "t", "validation_run_id": run_id,
                    "validation_plan_ref": "sha256:test",
                    "comparator": "status_equals", "expected": expected,
                    "observed": status, "matched": expected == status,
                    "run_status": status,
                },
                expected_surface="experiment_observations",
            )
        record_finding_reproduction(
            self.repo, finding_id=fid, validation_run_id="run-red",
            base_dir=self.tools,
        )
        record_finding_fix_verification(
            self.repo, finding_id=fid, validation_run_id="run-green",
            base_dir=self.tools,
        )
        return fid

    def test_regression_rerun_still_fixed(self) -> None:
        fid = self._resolved_binding()
        payload = run_night_experiments(
            self.repo, cycle_id="cycle-n2", base_dir=self.tools,
            runner=self._fake_runner(matched=True, run_status="ok"),
        )
        self.assertEqual(len(payload["still_fixed"]), 1)
        self.assertEqual(payload["regressions"], [])
        self.assertEqual(show_finding(self.repo, fid)["status"], "RESOLVED")

    def test_regression_rerun_red_emits_governance_signal(self) -> None:
        fid = self._resolved_binding()
        payload = run_night_experiments(
            self.repo, cycle_id="cycle-n2", base_dir=self.tools,
            runner=self._fake_runner(matched=False, run_status="failed"),
        )
        self.assertEqual(len(payload["regressions"]), 1)
        governance = (self.tools / "governance.jsonl").read_text(encoding="utf-8")
        self.assertIn("experiment_regression_detected", governance)
        # judgment lanes own the response; the finding stays RESOLVED here
        self.assertEqual(show_finding(self.repo, fid)["status"], "RESOLVED")


class NightIntegrationTests(unittest.TestCase):
    """Real runner, real subprocess. The workspace must be CLEAN for
    run_validation_commands, so state roots live OUTSIDE the git tree:
    tools as a sibling, findings redirected via ARIA_REPO_STATE_ROOT —
    exactly the production shape (aria-findings is gitignored there)."""

    def setUp(self) -> None:
        import os

        self.tmp = Path(tempfile.mkdtemp(prefix="aria-night-int-"))
        self.repo = self.tmp / "workspace"
        for i in range(1, 4):
            path = self.repo / "apps" / "farm-service" / "src" / f"module{i}.ts"
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text("line\n", encoding="utf-8")
        subprocess.run(["git", "init", "-q"], cwd=self.repo, check=True)
        subprocess.run(["git", "config", "user.email", "aria-test@example.com"], cwd=self.repo, check=True)
        subprocess.run(["git", "config", "user.name", "ARIA Test"], cwd=self.repo, check=True)
        subprocess.run(["git", "add", "apps"], cwd=self.repo, check=True)
        subprocess.run(["git", "commit", "-q", "-m", "seed"], cwd=self.repo, check=True)
        paths = workspace_paths(self.repo, self.tmp / "workspaces")
        ensure_workspace(paths)
        self.tools = self.tmp / "aria-tools"
        ensure_tools_dir(self.tools)
        self._env_prev = os.environ.get("ARIA_REPO_STATE_ROOT")
        os.environ["ARIA_REPO_STATE_ROOT"] = str(self.tmp / "state")

    def tearDown(self) -> None:
        import os
        import shutil

        if self._env_prev is None:
            os.environ.pop("ARIA_REPO_STATE_ROOT", None)
        else:
            os.environ["ARIA_REPO_STATE_ROOT"] = self._env_prev
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _finding(self, **kwargs):
        return NightBase._finding(self, **kwargs)

    def _bind_experiment(self, *args, **kwargs):
        return NightBase._bind_experiment(self, *args, **kwargs)

    def _ordinary_scoped_problem(self):
        from aria_kernel.runtime_profile import set_profile
        from aria_kernel.tool_registry import ensure_tools_binding

        contents = {
            "paths.py": (
                "import json\nfrom pathlib import Path\nfrom path_helper import canonical_path\n"
                "def unique_paths(paths):\n"
                "    config = json.loads(Path('path-config.json').read_text())\n"
                "    values = [canonical_path(p) for p in paths]\n"
                "    if not config['case_sensitive']:\n"
                "        values = [p.lower() for p in values]\n"
                "    return sorted(set(values))\n"
            ),
            "path_helper.py": "def canonical_path(value):\n    return value.removeprefix('./').lower()\n",
            "path-config.json": '{"case_sensitive": true}\n',
            "test_paths.py": (
                "import os, unittest\nfrom paths import unique_paths\n"
                "class PathTests(unittest.TestCase):\n"
                "    def test_normalized_case_sensitive_deduplication(self):\n"
                "        print('NIGHT_CHILD:' + str(os.getpid()))\n"
                "        self.assertEqual(unique_paths(['./src/A.py', 'src/a.py', 'src/A.py']),\n"
                "                         ['src/A.py', 'src/a.py'])\n"
            ),
            ".gitignore": "__pycache__/\n",
        }
        for name, value in contents.items():
            (self.repo / name).write_text(value, encoding="utf-8")
        self._commit_scoped_change("ordinary case-sensitive path fixture")
        set_profile("standard", operator_approval_ref="test:night-inputs", base_dir=self.tools)
        ensure_tools_binding(self.tools, workspace_root=self.repo)
        self.scoped_selector = "test_paths.PathTests.test_normalized_case_sensitive_deduplication"
        self.scoped_descriptor = {
            "schema_version": 2,
            "files": {"source": ["paths.py"], "test": ["test_paths.py"],
                      "config": ["path-config.json"], "dependency": ["path_helper.py"]},
            "execution_profile": {"kind": "python_unittest_public_v1", "modules": ["path_helper"]},
        }
        self.scoped_recipe = register_recipe(
            recipe_id="recipe-scoped-night", command="python3 -m unittest -v " + self.scoped_selector,
            timeout_ms=60_000, deterministic=True, input_scope=self.scoped_descriptor, base_dir=self.tools,
        )
        finding = emit_finding(
            repo_root=self.repo, base_dir=self.tools, claim_type="wrong_code",
            claim_summary="Path normalization loses case-sensitive distinctions", severity="MEDIUM",
            evidences=[{"ref": "path_helper.py:2", "summary": "The helper lowercases each normalized path"}],
            facts=["path-config.json requests case-sensitive deduplication"], scope_files=["path_helper.py"],
        )
        fid = finding["finding_id"]
        self._bind_experiment(fid, experiment_id="exp-scoped-problem", recipe_id=self.scoped_recipe["recipe_id"])
        result = run_night_experiments(self.repo, cycle_id="cycle-scoped-problem", base_dir=self.tools)
        self.assertEqual(result["errors"], [])
        self.assertEqual(len(result["reproduced"]), 1)
        self.assertEqual(result["refuted"], [])
        observation, row, log = self._native_scoped_run(result["reproduced"][0]["validation_run_id"], failed=True)
        self.assertEqual(show_finding(self.repo, fid)["certainty"], "CONFIRMED")
        self.assertEqual(show_finding(self.repo, fid)["reproduction"]["validation_run_id"], row["validation_run_id"])
        return fid, observation, row, log

    def _commit_scoped_change(self, message):
        subprocess.run(["git", "add", "-A"], cwd=self.repo, check=True)
        subprocess.run(["git", "commit", "-q", "-m", message], cwd=self.repo, check=True)
        return subprocess.run(["git", "rev-parse", "HEAD"], cwd=self.repo, check=True,
                              capture_output=True, text=True).stdout.strip()

    def _native_scoped_run(self, run_id, *, failed):
        from aria_kernel.experiment import list_experiment_observations
        from aria_kernel.validation_runs_ledger import verify_validation_run

        observation = next(row for row in list_experiment_observations(base_dir=self.tools)
                           if row["validation_run_id"] == run_id)
        row = verify_validation_run(run_id, base_dir=self.tools)
        self.assertEqual(row["change_id"], observation["change_id"])
        self.assertEqual(row["commit_sha"], observation["commit_sha"])
        self.assertEqual(row["cmd"], self.scoped_recipe["command"])
        self.assertEqual((row["exit_code"], row["timed_out"]), (1 if failed else 0, False))
        self.assertEqual((observation["matched"], observation["run_status"]), (True, "failed" if failed else "ok"))
        log = Path(row["log_path"]).read_bytes()
        text = log.decode()
        self.assertIn(self.scoped_selector.rsplit(".", 1)[1], text)
        self.assertIn("Ran 1 test", text)
        self.assertIn("AssertionError:" if failed else "\nOK\n", text)
        self.assertIn("NIGHT_CHILD:", text)
        return observation, row, log

    def _assert_scoped_night_receipt(self, observation, row, log):
        import hashlib

        self.assertIn("input_binding", row, "real night dispatch omitted the recipe-selected input descriptor")
        selection = observation["validation_input_selection"]
        self.assertEqual(selection, {
            "schema_version": 1, "status": "selected", "input_scope": self.scoped_descriptor,
            "recipe_sources": [{"recipe_id": self.scoped_recipe["recipe_id"],
                                "ledger_hash": self.scoped_recipe["ledger_hash"], "command": row["cmd"]}],
            "plan_content_hash": None, "reason": None,
        })
        text = log.decode()
        manifest = json.loads(next(line.removeprefix("input_manifest: ") for line in text.splitlines()
                                   if line.startswith("input_manifest: ")))
        self.assertEqual(manifest["roles"], self.scoped_descriptor["files"])
        env = manifest["environment"]
        pid = int(next(line.split(":", 1)[1] for line in text.splitlines() if line.startswith("NIGHT_CHILD:")))
        self.assertEqual(env["observation"]["child_pid"], pid)
        self.assertEqual(set(env["stable"]["modules"]), {"path_helper"})
        digest = "sha256:" + hashlib.sha256(json.dumps(env["stable"], sort_keys=True,
                                                     separators=(",", ":"), ensure_ascii=True).encode()).hexdigest()
        self.assertEqual(row["input_binding"]["runner_environment_digest"], digest)
        for dimension in ("dependency", "runner_environment", "selection_closure", "configuration_closure"):
            self.assertEqual(row["input_binding"]["availability"][dimension]["status"], "unknown")
        self.assertEqual(env["stable"]["modules"]["path_helper"]["executed_content_binding"]["status"], "unknown")

    def test_problem_branch_selects_recipe_scope_for_real_behavior_failure(self):
        _fid, observation, row, log = self._ordinary_scoped_problem()
        self._assert_scoped_night_receipt(observation, row, log)

    def test_regression_branch_reuses_native_fix_lineage_and_selects_recipe_scope(self):
        from aria_kernel.change_ledger import emit_change_committed
        from aria_kernel.experiment import run_experiment
        from aria_kernel.finding import _events_path, list_fix_verified_bindings
        from aria_kernel.validation_runs_ledger import validation_runs_path, verify_validation_run

        fid, problem, red_row, red_log = self._ordinary_scoped_problem()
        (self.repo / "path_helper.py").write_text("def canonical_path(value):\n    return value.removeprefix('./')\n")
        fix_sha = self._commit_scoped_change("preserve case-sensitive paths")
        emit_change_committed(change_id=problem["change_id"], commit_sha=fix_sha,
                              actual_affected_files=["path_helper.py"], base_dir=self.tools)
        self._bind_experiment(fid, experiment_id="exp-scoped-solution", recipe_id=self.scoped_recipe["recipe_id"], expected="ok")
        fixed = run_experiment(experiment_id="exp-scoped-solution", workspace_root=self.repo,
                               change_id=problem["change_id"], commit_sha=fix_sha,
                               runner_identity="ci-executor:night-fix", base_dir=self.tools)
        _fixed, green_row, green_log = self._native_scoped_run(fixed["validation_run_id"], failed=False)
        event = record_finding_fix_verification(self.repo, finding_id=fid,
                                                validation_run_id=fixed["validation_run_id"], base_dir=self.tools)
        self.assertEqual(event["observation_ledger_hash"], fixed["ledger_hash"])
        self.assertEqual(show_finding(self.repo, fid)["closes_in_commit"], fix_sha)
        bindings = list_fix_verified_bindings(self.repo)
        self.assertEqual(len(bindings), 1)
        self.assertEqual(bindings[0]["validation_run_id"], fixed["validation_run_id"])
        saved = {path: path.read_bytes() for path in (observations_path(self.tools),
                 validation_runs_path(self.tools), _events_path(self.repo))}

        result = run_night_experiments(self.repo, cycle_id="cycle-scoped-regression", base_dir=self.tools)
        self.assertEqual(result["errors"], [])
        self.assertEqual(result["reproduced"], [])
        self.assertEqual(result["regressions"], [])
        self.assertEqual(len(result["still_fixed"]), 1)
        observation, row, log = self._native_scoped_run(result["still_fixed"][0]["validation_run_id"], failed=False)
        self.assertNotIn(row["validation_run_id"], {red_row["validation_run_id"], green_row["validation_run_id"]})
        self.assertEqual((row["change_id"], row["commit_sha"]), (problem["change_id"], fix_sha))
        self.assertEqual(show_finding(self.repo, fid)["status"], "RESOLVED")
        for path, original in saved.items():
            self.assertTrue(path.read_bytes().startswith(original))
        for old_row, old_log in ((red_row, red_log), (green_row, green_log)):
            self.assertEqual(verify_validation_run(old_row["validation_run_id"], base_dir=self.tools), old_row)
            self.assertEqual(Path(old_row["log_path"]).read_bytes(), old_log)
        self._assert_scoped_night_receipt(observation, row, log)

    def test_real_runner_reproduces_finding_end_to_end(self) -> None:
        # A recipe whose command is REAL and allowlisted, and deterministically
        # red: unittest against a module that does not exist.
        register_recipe(
            recipe_id="recipe-real-red",
            command="python3 -m unittest aria_night_no_such_module_xyz",
            timeout_ms=60000, deterministic=True, base_dir=self.tools,
        )
        fid = self._finding(severity="HIGH")
        self._bind_experiment(
            fid, experiment_id="exp-real", recipe_id="recipe-real-red",
        )
        payload = run_night_experiments(
            self.repo, cycle_id="cycle-real", base_dir=self.tools,
        )
        self.assertEqual(payload["errors"], [])
        self.assertEqual(len(payload["reproduced"]), 1)
        doc = show_finding(self.repo, fid)
        self.assertEqual(doc["certainty"], "CONFIRMED")
        self.assertEqual(doc["reproduction"]["recipe_ref"], "recipe-real-red")


class NightPhaseRegistrationTests(unittest.TestCase):
    def test_phase_registered_with_existing_precondition_and_error_policy(self) -> None:
        from aria_kernel.cycle import CYCLE_PHASES, CYCLE_PRECONDITIONS, WRITES_PERMITTED

        phases = {p.name: p for p in CYCLE_PHASES}
        self.assertIn("experiment_night", phases)
        phase = phases["experiment_night"]
        self.assertIs(phase.precondition, WRITES_PERMITTED)
        self.assertTrue(any(phase.precondition is known for known in CYCLE_PRECONDITIONS))
        self.assertEqual(phase.on_error, "record_and_continue")
        self.assertEqual(phase.stage, "post_tool")


if __name__ == "__main__":
    unittest.main()
