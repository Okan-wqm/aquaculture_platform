"""E21-b — a declared recipe that cannot execute is a hypothesis nobody can test.

THE DEFECT THIS EXISTS TO CATCH. ``register_recipe`` treats a command as
opaque DATA on purpose: the kernel must not learn what ``nx`` or ``cargo``
is. The cost of that correctness is that a typo, a renamed nx project, or a
verb the lane never admitted registers happily and is discovered only when
the experiment runs — which, once E21-d wires the bench into the nightly, is
at 03:00, as a failure that looks like a broken repository rather than a
broken manifest.

So the manifest is proved executable HERE, at test time, through
``validation.parse_allowed_command`` — the runner's own parser, not a second
copy of the allowlist. A copy is how the manifest gate and the runner would
come to disagree about what may run, which is the same two-readers-of-one-
convention defect the seeder next door was written to avoid.

Deliberate breaks: put ``cargo publish`` (or ``npx nx test backend-common``,
which this lane does NOT admit) in the manifest and
``test_every_declared_command_is_executable_by_the_lane`` goes red; point an
experiment at a recipe id that is not declared and
``test_every_experiment_resolves_to_a_declared_recipe`` goes red.
"""
from __future__ import annotations

import hashlib
import io
import json
import os
import subprocess
import sys
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path

_REPO_ROOT = Path(__file__).resolve().parents[3]
for _path in (_REPO_ROOT / "aria-kernel", _REPO_ROOT / "tools" / "aria-poc"):
    if str(_path) not in sys.path:
        sys.path.insert(0, str(_path))

from aria_kernel.experiment import (  # noqa: E402
    get_experiment,
    get_recipe,
    list_recipes,
    register_recipe,
    run_experiment,
)
from aria_kernel.change_ledger import emit_change_committed, emit_change_planned  # noqa: E402
from aria_kernel.runtime_profile import set_profile  # noqa: E402
from aria_kernel.tool_registry import GovernanceError, ensure_tools_binding  # noqa: E402
from aria_kernel.validation import parse_allowed_command  # noqa: E402
from aria_kernel.validation_runs_ledger import verify_validation_run  # noqa: E402
from seed_experiment_recipes import (  # noqa: E402
    assert_manifest_commands_executable,
    load_manifest,
    main,
    seed,
)


class ExperimentRecipeManifestTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.doc = load_manifest()

    def _ordinary_manifest_bench(self) -> dict:
        from tests._helpers.hermetic_git import apply_hermetic_git_env

        apply_hermetic_git_env()
        scratch = tempfile.TemporaryDirectory(prefix="aria-provision-")
        self.addCleanup(scratch.cleanup)
        self.fixture = Path(scratch.name)
        self.root = self.fixture / "source"
        self.root.mkdir()
        self.base = self.fixture / "store" / "tools"
        self.selector = "test_paths.PathTests.test_normalized_case_sensitive_deduplication"
        self.command = "python3 -m unittest -v " + self.selector
        self.contents = {
            "path_helper.py": (
                "def normalize_paths(values):\n"
                "    return sorted({value.strip() for value in values if value.strip()})\n"
            ),
            "path-config.json": '{"paths":[" beta ","Alpha","alpha","Alpha"," "]}\n',
            "requirements.txt": "# This fixture uses only the standard library.\n",
            "test_paths.py": (
                "import json, os, unittest\nfrom pathlib import Path\n"
                "from path_helper import normalize_paths\n"
                "class PathTests(unittest.TestCase):\n"
                "    def test_normalized_case_sensitive_deduplication(self):\n"
                "        values = json.loads(Path(__file__).with_name('path-config.json').read_text())['paths']\n"
                "        result = normalize_paths(values)\n"
                "        self.assertEqual(result, ['Alpha', 'alpha', 'beta'])\n"
                "        print('PROVISION_RESULT:' + json.dumps({'paths': result, 'pid': os.getpid()}))\n"
            ),
            ".gitignore": "__pycache__/\n",
        }
        for name, content in self.contents.items():
            (self.root / name).write_text(content, encoding="utf-8")
        for args in (["init", "-q"], ["config", "user.name", "ARIA fixture"],
                     ["config", "user.email", "aria@example.invalid"], ["add", "."],
                     ["commit", "-q", "-m", "ordinary provisioning behavior"]):
            subprocess.run(["git", *args], cwd=self.root, check=True, capture_output=True)
        self.commit_sha = subprocess.check_output(
            ["git", "rev-parse", "HEAD"], cwd=self.root, text=True,
        ).strip()
        ensure_tools_binding(self.base, workspace_root=self.root)
        set_profile("standard", operator_approval_ref="t", base_dir=self.base)
        planned = emit_change_planned(
            plan_id="plan-provision-paths", finding_id="F-provision-paths",
            intended_affected_files=sorted(self.contents),
            intended_validation_refs=[self.command], architectural_tier=1, base_dir=self.base,
        )
        self.change_id = planned["change_id"]
        emit_change_committed(
            change_id=self.change_id, commit_sha=self.commit_sha,
            actual_affected_files=sorted(self.contents), base_dir=self.base,
        )
        self.descriptor = {
            "schema_version": 2,
            "files": {"source": ["path_helper.py"], "test": ["test_paths.py"],
                      "config": ["path-config.json"], "dependency": ["requirements.txt"]},
            "execution_profile": {"kind": "python_unittest_public_v1", "modules": ["path_helper"]},
        }
        return {
            "schema_version": 1,
            "recipes": [{"recipe_id": "recipe-provision-paths", "command": self.command,
                         "timeout_ms": 60_000, "deterministic": True,
                         "input_scope": self.descriptor}],
            "experiments": [{"experiment_id": "exp-provision-paths",
                             "hypothesis": "normalization preserves case and removes duplicates",
                             "recipe_ref": "recipe-provision-paths",
                             "observation_contract": {"comparator": "exit_code_equals", "expected": 0}}],
        }

    def test_explicit_manifest_scope_reaches_real_native_bench(self) -> None:
        doc = self._ordinary_manifest_bench()
        manifest_path = self.fixture / "alternate-manifest.json"
        manifest_bytes = (json.dumps(doc, indent=2) + "\n").encode()
        manifest_path.write_bytes(manifest_bytes)
        output = io.StringIO()
        with redirect_stdout(output):
            exit_code = main(["--manifest", str(manifest_path), "--base-dir", str(self.base),
                              "--cycle-id", "cycle-provision"])
        self.assertEqual(exit_code, 0)
        self.assertIn("[bench] recipe declared: recipe-provision-paths\n", output.getvalue())
        self.assertIn("[bench] experiment declared: exp-provision-paths\n", output.getvalue())
        self.assertEqual(manifest_path.read_bytes(), manifest_bytes)

        observation = run_experiment(
            experiment_id="exp-provision-paths", workspace_root=self.root,
            change_id=self.change_id, commit_sha=self.commit_sha,
            runner_identity="ci-executor:provision", change_author_identity="agent:provision-planner",
            base_dir=self.base, cycle_id="cycle-provision",
        )
        self.assertEqual((observation["observed"], observation["matched"], observation["run_status"]),
                         (0, True, "ok"))
        row = verify_validation_run(observation["validation_run_id"], base_dir=self.base)
        self.assertEqual((row["cmd"], row["exit_code"], row["timed_out"]), (self.command, 0, False))
        self.assertEqual((row["commit_sha"], row["change_id"]), (self.commit_sha, self.change_id))
        log_bytes = Path(row["log_path"]).read_bytes()
        self.assertEqual(row["log_hash"], "sha256:" + hashlib.sha256(log_bytes).hexdigest())
        log = log_bytes.decode()
        self.assertIn(self.selector, log)
        self.assertIn("Ran 1 test", log)
        self.assertIn("\nOK\n", log)
        marker = json.loads(next(line.removeprefix("PROVISION_RESULT:") for line in log.splitlines()
                                 if line.startswith("PROVISION_RESULT:")))
        self.assertEqual(marker["paths"], ["Alpha", "alpha", "beta"])
        self.assertNotEqual(marker["pid"], os.getpid())

        # Metadata follows real execution/native verification for the same manifest.
        self.assertIn("input_binding", row, "seeded optional scope did not reach the real bench")
        recipe = get_recipe("recipe-provision-paths", base_dir=self.base)
        self.assertEqual(recipe["input_scope"], self.descriptor)
        self.assertEqual(recipe["cycle_id"], "cycle-provision")
        selection = observation["validation_input_selection"]
        self.assertEqual(selection["status"], "selected")
        self.assertEqual(selection["input_scope"], self.descriptor)
        self.assertEqual(selection["recipe_sources"], [{"recipe_id": recipe["recipe_id"],
                                                       "ledger_hash": recipe["ledger_hash"],
                                                       "command": self.command}])
        self.assertEqual(row["log_ref"]["sha256"], row["log_hash"])
        self.assertEqual(self.base / row["log_ref"]["uri"], Path(row["log_path"]))
        input_manifest = json.loads(next(line.removeprefix("input_manifest: ") for line in log.splitlines()
                                         if line.startswith("input_manifest: ")))
        environment = input_manifest["environment"]
        self.assertEqual(environment["observation"]["child_pid"], marker["pid"])
        self.assertEqual(environment["observation"]["phase"], "post_run")
        self.assertEqual(environment["stable"]["modules"]["path_helper"]["executed_content_binding"],
                         {"status": "unknown", "reason": "loaded_bytes_not_observed"})
        canonical = json.dumps(environment["stable"], sort_keys=True, separators=(",", ":"), ensure_ascii=True).encode()
        self.assertEqual(row["input_binding"]["runner_environment_digest"], "sha256:" + hashlib.sha256(canonical).hexdigest())
        for dimension in ("runner_environment", "dependency", "configuration_closure", "selection_closure"):
            self.assertEqual(row["input_binding"]["availability"][dimension]["status"], "unknown")
        self.assertEqual(manifest_path.read_bytes(), manifest_bytes)
        self.assertFalse((self.root / "aria-tools").exists())

    def test_direct_seed_preflights_all_scopes_without_changing_existing_ledgers(self) -> None:
        oversized = {
            "schema_version": 1,
            "files": {"source": [f"{'a' * 240}/{'b' * 240}/file-{i:03d}.py" for i in range(140)],
                      "test": [], "config": [], "dependency": []},
        }
        self.assertGreater(len(json.dumps(oversized, sort_keys=True, separators=(",", ":"),
                                          ensure_ascii=True).encode()), 65_536)
        for label, descriptor, error in (
            ("invalid_version", {"schema_version": 3, "files": {}}, "validation_input_scope_invalid"),
            ("metadata_size", oversized, "experiment_recipe_input_scope_metadata_limit"),
        ):
            with self.subTest(descriptor=label):
                doc = self._ordinary_manifest_bench()
                seed(doc, base_dir=self.base, cycle_id="cycle-existing")
                observation = run_experiment(
                    experiment_id="exp-provision-paths", workspace_root=self.root,
                    change_id=self.change_id, commit_sha=self.commit_sha,
                    runner_identity="ci-executor:provision", change_author_identity="agent:provision-planner",
                    base_dir=self.base, cycle_id="cycle-existing",
                )
                self.assertEqual((observation["observed"], observation["matched"]), (0, True))
                row = verify_validation_run(observation["validation_run_id"], base_dir=self.base)
                log_path = Path(row["log_path"])
                log_bytes = log_path.read_bytes()
                self.assertIn(b"Ran 1 test", log_bytes)
                self.assertIn(b"PROVISION_RESULT:", log_bytes)
                before = {p.relative_to(self.base): p.read_bytes() for p in self.base.rglob("*.jsonl")}
                self.assertTrue(before[Path("experiments/recipes.jsonl")])
                self.assertTrue(before[Path("experiments/experiments.jsonl")])
                self.assertTrue(before[Path("experiments/observations.jsonl")])
                proposed = {
                    "schema_version": 1,
                    "recipes": [dict(doc["recipes"][0], recipe_id="recipe-valid-first"),
                                dict(doc["recipes"][0], recipe_id="recipe-invalid-second", input_scope=descriptor)],
                    "experiments": [dict(doc["experiments"][0], experiment_id="exp-new", recipe_ref="recipe-valid-first")],
                }
                # Direct seed callers have the same preflight boundary as main.
                with self.assertRaisesRegex(GovernanceError, "^" + error + "$"):
                    seed(proposed, base_dir=self.base, cycle_id="cycle-rejected-descriptor")
                after = {p.relative_to(self.base): p.read_bytes() for p in self.base.rglob("*.jsonl")}
                self.assertEqual(after, before, "optional descriptor rejection appended a partial manifest")
                self.assertEqual(log_path.read_bytes(), log_bytes)
                self.assertEqual(verify_validation_run(observation["validation_run_id"], base_dir=self.base), row)

    def _seed_alternate_manifest(self, doc: dict, label: str) -> tuple[Path, bytes]:
        path = self.fixture / (label + ".json")
        original = (json.dumps(doc, indent=2) + "\n").encode()
        path.write_bytes(original)
        output = io.StringIO()
        with redirect_stdout(output):
            self.assertEqual(main(["--manifest", str(path), "--base-dir", str(self.base),
                                   "--cycle-id", label]), 0)
        self.assertIn("[bench] recipe declared: recipe-provision-paths\n", output.getvalue())
        self.assertIn("[bench] experiment declared: exp-provision-paths\n", output.getvalue())
        self.assertEqual(path.read_bytes(), original)
        return path, original

    def _run_provisioned_bench(self, cycle: str) -> tuple[dict, dict, bytes]:
        observation = run_experiment(
            experiment_id="exp-provision-paths", workspace_root=self.root,
            change_id=self.change_id, commit_sha=self.commit_sha,
            runner_identity="ci-executor:provision", change_author_identity="agent:provision-planner",
            base_dir=self.base, cycle_id=cycle,
        )
        self.assertEqual((observation["observed"], observation["matched"], observation["run_status"]),
                         (0, True, "ok"))
        row = verify_validation_run(observation["validation_run_id"], base_dir=self.base)
        self.assertEqual((row["cmd"], row["exit_code"], row["timed_out"]), (self.command, 0, False))
        self.assertEqual((row["change_id"], row["commit_sha"]), (self.change_id, self.commit_sha))
        log_bytes = Path(row["log_path"]).read_bytes()
        self.assertEqual(row["log_hash"], "sha256:" + hashlib.sha256(log_bytes).hexdigest())
        log = log_bytes.decode()
        self.assertIn(self.selector, log)
        self.assertIn("Ran 1 test", log)
        self.assertIn("\nOK\n", log)
        marker = json.loads(next(line.removeprefix("PROVISION_RESULT:") for line in log.splitlines()
                                 if line.startswith("PROVISION_RESULT:")))
        self.assertEqual(marker["paths"], ["Alpha", "alpha", "beta"])
        self.assertNotEqual(marker["pid"], os.getpid())
        return observation, row, log_bytes

    def test_legacy_and_null_manifest_scopes_preserve_recipe_and_run_shape(self) -> None:
        shapes = []
        for mode in ("omitted", "null"):
            with self.subTest(scope=mode):
                doc = self._ordinary_manifest_bench()
                if mode == "omitted":
                    del doc["recipes"][0]["input_scope"]
                else:
                    doc["recipes"][0]["input_scope"] = None
                manifest, original = self._seed_alternate_manifest(doc, "cycle-" + mode)
                recipe = get_recipe("recipe-provision-paths", base_dir=self.base)
                native_before = (self.base / "experiments" / "recipes.jsonl").read_bytes()
                observation, row, log_bytes = self._run_provisioned_bench("cycle-" + mode)
                self.assertNotIn("input_scope", recipe)
                self.assertNotIn("validation_input_selection", observation)
                self.assertNotIn("input_binding", row)
                self.assertNotIn("log_ref", row)
                self.assertNotIn(b"input_manifest: ", log_bytes)
                self.assertEqual((self.base / "experiments" / "recipes.jsonl").read_bytes(), native_before)
                self.assertEqual(manifest.read_bytes(), original)
                shapes.append((set(recipe), set(observation), set(row)))
        self.assertEqual(shapes[0], shapes[1])

    def test_explicit_reseed_selects_new_scope_without_rewriting_prior_proof(self) -> None:
        doc = self._ordinary_manifest_bench()
        first_manifest, original_manifest = self._seed_alternate_manifest(doc, "cycle-first")
        first_recipe = get_recipe("recipe-provision-paths", base_dir=self.base)
        first_observation, first_row, first_log = self._run_provisioned_bench("cycle-first")
        self.assertEqual(first_observation["validation_input_selection"]["recipe_sources"][0]["ledger_hash"],
                         first_recipe["ledger_hash"])
        before = {p.relative_to(self.base): p.read_bytes() for p in self.base.rglob("*.jsonl")}
        revised = json.loads(json.dumps(doc))
        revised["recipes"][0]["input_scope"]["execution_profile"]["modules"] = ["path_helper", "test_paths"]
        second_manifest, revised_manifest = self._seed_alternate_manifest(revised, "cycle-second")
        second_recipe = get_recipe("recipe-provision-paths", base_dir=self.base)
        second_observation, second_row, second_log = self._run_provisioned_bench("cycle-second")
        self.assertNotEqual(second_recipe["ledger_hash"], first_recipe["ledger_hash"])
        self.assertEqual(second_recipe["input_scope"], revised["recipes"][0]["input_scope"])
        self.assertEqual(second_observation["validation_input_selection"]["recipe_sources"],
                         [{"recipe_id": second_recipe["recipe_id"], "ledger_hash": second_recipe["ledger_hash"],
                           "command": self.command}])
        self.assertEqual(second_observation["validation_input_selection"]["input_scope"], second_recipe["input_scope"])
        self.assertIn("input_binding", second_row)
        second_environment = json.loads(next(line.removeprefix("input_manifest: ") for line in second_log.decode().splitlines()
                                             if line.startswith("input_manifest: ")))["environment"]
        self.assertEqual(set(second_environment["stable"]["modules"]), {"path_helper", "test_paths"})
        for entry in second_environment["stable"]["modules"].values():
            self.assertEqual(entry["presence"], "observed_post_run")
            self.assertEqual(entry["executed_content_binding"],
                             {"status": "unknown", "reason": "loaded_bytes_not_observed"})
        before_null = {p.relative_to(self.base): p.read_bytes() for p in self.base.rglob("*.jsonl")}
        disabled = json.loads(json.dumps(revised))
        disabled["recipes"][0]["input_scope"] = None
        third_manifest, null_manifest = self._seed_alternate_manifest(disabled, "cycle-disabled")
        latest_recipe = get_recipe("recipe-provision-paths", base_dir=self.base)
        self.assertNotEqual(latest_recipe["ledger_hash"], second_recipe["ledger_hash"])
        self.assertEqual(latest_recipe["cycle_id"], "cycle-disabled")
        self.assertNotIn("input_scope", latest_recipe)
        third_observation, third_row, third_log = self._run_provisioned_bench("cycle-disabled")
        self.assertNotIn("validation_input_selection", third_observation)
        self.assertNotIn("input_binding", third_row)
        self.assertNotIn("log_ref", third_row)
        self.assertNotIn(b"input_manifest: ", third_log)
        for relative, old_bytes in before_null.items():
            self.assertTrue((self.base / relative).read_bytes().startswith(old_bytes), str(relative))
        self.assertEqual(Path(second_row["log_path"]).read_bytes(), second_log)
        self.assertEqual(verify_validation_run(second_row["validation_run_id"], base_dir=self.base), second_row)
        self.assertEqual([r for r in list_recipes(base_dir=self.base) if r["ledger_hash"] == first_recipe["ledger_hash"]],
                         [first_recipe])
        for relative, old_bytes in before.items():
            self.assertTrue((self.base / relative).read_bytes().startswith(old_bytes), str(relative))
        self.assertEqual(Path(first_row["log_path"]).read_bytes(), first_log)
        self.assertEqual(verify_validation_run(first_row["validation_run_id"], base_dir=self.base), first_row)
        self.assertEqual(first_manifest.read_bytes(), original_manifest)
        self.assertEqual(second_manifest.read_bytes(), revised_manifest)
        self.assertEqual(third_manifest.read_bytes(), null_manifest)

    def test_manifest_optional_scope_uses_existing_validator_before_seed_writes(self) -> None:
        doc = self._ordinary_manifest_bench()
        supplied = {"schema_version": 2, "files": {"source": ["path_helper.py", "./path_helper.py"]},
                    "execution_profile": {"kind": "python_unittest_public_v1", "modules": ["path_helper", "path_helper"]}}
        expected = {"schema_version": 2,
                    "files": {"source": ["path_helper.py"], "test": [], "config": [], "dependency": []},
                    "execution_profile": {"kind": "python_unittest_public_v1", "modules": ["path_helper"]}}
        doc["recipes"][0]["input_scope"] = supplied
        before_input = json.dumps(doc, sort_keys=True)
        self._seed_alternate_manifest(doc, "cycle-canonical")
        seeded = get_recipe("recipe-provision-paths", base_dir=self.base)
        direct = register_recipe(recipe_id="recipe-direct-canonical", command=self.command,
                                 timeout_ms=60_000, deterministic=True, input_scope=supplied, base_dir=self.base)
        self.assertEqual(seeded["input_scope"], expected)
        self.assertEqual(direct["input_scope"], expected)
        self.assertEqual(json.dumps(doc, sort_keys=True), before_input)

    def test_the_manifest_declares_something(self) -> None:
        # A gate that passes over an empty list proves nothing; this fails
        # on collapse rather than on ordinary drift.
        self.assertGreaterEqual(len(self.doc["recipes"]), 2)
        self.assertGreaterEqual(len(self.doc["experiments"]), 2)

    def test_every_declared_command_is_executable_by_the_lane(self) -> None:
        for recipe in self.doc["recipes"]:
            with self.subTest(recipe_id=recipe["recipe_id"]):
                argv, _ = parse_allowed_command(str(recipe["command"]))
                self.assertTrue(argv)
        # And the seeder refuses the same manifest through the same door,
        # so an unrunnable recipe cannot be seeded even if this file is
        # never run.
        assert_manifest_commands_executable(self.doc)

    def test_every_experiment_resolves_to_a_declared_recipe(self) -> None:
        declared = {recipe["recipe_id"] for recipe in self.doc["recipes"]}
        for definition in self.doc["experiments"]:
            with self.subTest(experiment_id=definition["experiment_id"]):
                self.assertIn(definition["recipe_ref"], declared)

    def test_no_recipe_is_declared_without_an_experiment_to_test_it(self) -> None:
        """Dead data is how a manifest starts describing intentions rather
        than work: a recipe nothing references will never run, so nothing
        will ever notice when it stops working."""
        referenced = {
            definition["recipe_ref"] for definition in self.doc["experiments"]
        }
        orphaned = sorted(
            recipe["recipe_id"]
            for recipe in self.doc["recipes"]
            if recipe["recipe_id"] not in referenced
        )
        self.assertEqual(orphaned, [])

    def test_no_recipe_can_be_answered_from_a_build_cache(self) -> None:
        """A cached green measures the cache, not the tree.

        Measured while writing this file: the second run of the nx recipe
        returned exit 0 in seconds with ``[local cache]`` in its output and
        executed no test at all. An experiment whose observation can be
        served from a build cache is exactly the readiness claim E21 exists
        to end, and it gets worse on a schedule — a nightly would report a
        hypothesis confirmed every night after the last real execution.

        The kernel cannot know this: it must not learn what nx is. So the
        rule lives with the recipes, in the repo-facing lane that does.
        """
        for recipe in self.doc["recipes"]:
            argv, _ = parse_allowed_command(str(recipe["command"]))
            if argv[:2] != ["npx", "nx"]:
                continue
            with self.subTest(recipe_id=recipe["recipe_id"]):
                self.assertIn(
                    "--skip-nx-cache",
                    argv,
                    "an nx recipe without --skip-nx-cache can record a green "
                    "exit code without running anything",
                )
                # Measured on the same run: the default non-TTY renderer wrote
                # 63 KB of a 161 KB execution into the captured stream and cut
                # it mid-escape-sequence, dropping the summary and 80 of 124
                # suite results. The log is the run's content-addressed anchor
                # — a truncated one is a hash over an amputated record.
                self.assertIn(
                    "--output-style=stream",
                    argv,
                    "nx's default renderer truncates the captured output that "
                    "verify_validation_run re-hashes",
                )

    def test_the_kernel_accepts_the_whole_manifest(self) -> None:
        """The declarations are validated by the kernel's own doors —
        observation contracts, identifier shapes, timeout bounds — rather
        than by this test's idea of them."""
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp) / "aria-tools"
            set_profile("standard", operator_approval_ref="t", base_dir=base)
            recipe_ids, experiment_ids = seed(self.doc, base_dir=base, cycle_id=None)
            self.assertEqual(
                recipe_ids, [row["recipe_id"] for row in self.doc["recipes"]],
            )
            for recipe_id in recipe_ids:
                self.assertEqual(
                    get_recipe(recipe_id, base_dir=base)["recipe_id"], recipe_id,
                )
            for experiment_id in experiment_ids:
                self.assertEqual(
                    get_experiment(experiment_id, base_dir=base)["experiment_id"],
                    experiment_id,
                )


if __name__ == "__main__":
    unittest.main()
