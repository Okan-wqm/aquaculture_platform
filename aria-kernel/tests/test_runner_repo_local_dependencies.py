"""ARIA-MEDIUM-508 — a runner's missing repo-local dependency is the workspace's fault, never the tool's.

``banned-phrase-adapter`` runs as ``python3 banned_phrase_adapter.py`` and spawns
the repository's ``node_modules/.bin/ts-node``. In a workspace without it the
adapter reports ``unavailable`` and exits 127. The runner recognised a missing
node dependency only from the argv the registry builds for ``npx ts-node``
runners, so this exit was priced ``crash``, and ten such runs moved the tool to
CALIBRATE (crash rate above 0.2 over the last 10 runs). That is the fault class
that quarantined six adapters on 2026-08-10: a workspace that cannot run a tool
recorded as evidence against the tool.

A runner now declares the repo-local files it executes
(``runner.repo_local_dependencies``); the registry validates the field and
derives the ts-node entry of a normalised ``npx ts-node`` runner; the runner
and the fixture-contract skip read the one registry predicate, and a run whose
dependency is absent is ``environment_unavailable`` before anything spawns.
"""

from __future__ import annotations

# ARIA-HIGH-602 — the live partition: this module reads the live checkout
# outside the kernel surface, so it runs in aria-kernel.yml's always-run
# `workspace` job (aria_kernel.live_partition), never in a skippable shard.
READS_LIVE_CHECKOUT = "the banned-phrase adapter's repo-local dependency tools/gates/banned-phrase.ts"

import json
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from _helpers.git_fixtures import make_local_git_repo  # noqa: E402

from aria_kernel.tool_registry import GovernanceError, get_tool, register_tool  # noqa: E402
from aria_kernel.tool_runner import run_tool  # noqa: E402

REPO_ROOT = Path(__file__).resolve().parents[2]
MANIFEST = REPO_ROOT / "tools" / "aria-adapters" / "banned-phrase-adapter.tool.json"
# What the reproduction workspace holds: the adapter and the gate it wraps,
# with no node_modules (an operator `tool run`, a local cycle, a checkout the
# nightly provisioning never reached).
ADAPTER_FILES = (
    "tools/aria-poc/banned_phrase_adapter.py",
    "tools/gates/banned-phrase.ts",
    "tools/gates/tsconfig.json",
)


def _git(args: list[str], cwd: Path) -> None:
    subprocess.run(
        ["git", "-c", "user.email=fixture@aria.test", "-c", "user.name=Aria Fixture", *args],
        cwd=cwd, check=True, capture_output=True,
    )


class BannedPhraseAdapterWithoutNodeModules(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        root = Path(self._tmp.name)
        self.workspace = make_local_git_repo(root, name="work", initial_commit=False)
        for rel in ADAPTER_FILES:
            target = self.workspace / rel
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(REPO_ROOT / rel, target)
        (self.workspace / "package.json").write_text("{}\n", encoding="utf-8")
        _git(["add", "--", "package.json", "tools"], self.workspace)
        _git(["commit", "-q", "-m", "fixture: the adapter without its node dependencies"], self.workspace)
        self.assertFalse((self.workspace / "node_modules").exists())
        self.tools = root / "tools-store"
        self.tools.mkdir()
        register_tool(json.loads(MANIFEST.read_text(encoding="utf-8")), base_dir=self.tools)

    def test_ten_runs_are_environment_unavailable_and_never_demote_the_tool(self) -> None:
        for attempt in range(10):
            result = run_tool(
                "banned-phrase-adapter", {}, f"cyc-no-node-{attempt}",
                workspace_root=self.workspace, base_dir=self.tools,
            )
            with self.subTest(attempt=attempt):
                self.assertEqual(result["envelope"]["status"], "environment_unavailable", result["envelope"]["runner"])
                self.assertNotEqual(result["action"], "calibrate", result)
        self.assertEqual(get_tool("banned-phrase-adapter", self.tools)["status"], "SHADOW")
        runner = result["envelope"]["runner"]
        # Nothing spawned, and the record names what the workspace lacks.
        self.assertIsNone(runner["exit_code"])
        self.assertIn("node_modules/.bin/ts-node", runner["stderr_sample"])

    def test_the_manifest_declares_the_file_the_adapter_spawns(self) -> None:
        sys.path.insert(0, str(REPO_ROOT / "tools" / "aria-poc"))
        try:
            import banned_phrase_adapter
        finally:
            sys.path.remove(str(REPO_ROOT / "tools" / "aria-poc"))
        declared = json.loads(MANIFEST.read_text(encoding="utf-8"))["runner"]["repo_local_dependencies"]
        self.assertEqual(declared, [Path(banned_phrase_adapter.GATE_TS_NODE).as_posix()])


class BannedPhraseFixtureSuiteWithoutNodeModules(unittest.TestCase):
    """ARIA-MEDIUM-570 — the fixture lane spawns the same adapter in the same
    room, so it asks the same registry predicate: a workspace without the
    runner's dependency refuses the suite by name (a blocked refresh) instead
    of writing a `crash` verdict on the tool, which CALIBRATE -> SHADOW reads."""

    FIXTURE_SET = "tools/aria-adapters/fixtures/banned-phrase-adapter"

    def setUp(self) -> None:
        BannedPhraseAdapterWithoutNodeModules.setUp(self)
        shutil.copytree(REPO_ROOT / self.FIXTURE_SET, self.workspace / self.FIXTURE_SET)
        _git(["add", "--", self.FIXTURE_SET], self.workspace)
        _git(["commit", "-q", "-m", "fixture: the adapter's fixture set"], self.workspace)

    def test_the_suite_is_refused_by_name_and_no_verdict_is_written(self) -> None:
        from aria_kernel.fixture_runner import fixture_runs_path, refresh_fixture_suites, run_fixture_suite
        from aria_kernel.ledger import load_jsonl

        with self.assertRaisesRegex(GovernanceError, r"runner_dependency_missing:node_modules/\.bin/ts-node"):
            run_fixture_suite("banned-phrase-adapter", workspace_root=self.workspace, cycle_id="cyc-no-node",
                              base_dir=self.tools)
        refreshed = refresh_fixture_suites(workspace_root=self.workspace, cycle_id="cyc-no-node", base_dir=self.tools)
        self.assertEqual([entry["status"] for entry in refreshed["tools"]], ["blocked"])
        self.assertIn("runner_dependency_missing:node_modules/.bin/ts-node", refreshed["tools"][0]["reason"])
        runs = fixture_runs_path(self.tools)
        self.assertEqual(load_jsonl(runs) if runs.exists() else [], [], "no suite verdict on the tool")


class RunnerDependencyContract(unittest.TestCase):
    def _runner(self, **overrides: object) -> dict:
        runner = {
            "type": "subprocess", "argv": ["python3", "banned_phrase_adapter.py"], "cwd": "tools/aria-poc",
            "timeout_ms": 1000, "stdin_json": True,
        }
        runner.update(overrides)
        return runner

    def test_a_normalised_ts_node_runner_derives_its_dependency(self) -> None:
        from aria_kernel.tool_registry import runner_repo_local_dependencies, validate_runner_definition

        runner = validate_runner_definition(self._runner(argv=["npx", "ts-node", "tools/x.ts"], cwd="."))
        self.assertEqual(runner_repo_local_dependencies(runner), ("node_modules/ts-node/dist/bin.js",))
        nested = validate_runner_definition(self._runner(argv=["npx", "ts-node", "x.ts"], cwd="tools/aria-adapters"))
        self.assertEqual(
            runner_repo_local_dependencies(nested), ("tools/aria-adapters/node_modules/ts-node/dist/bin.js",),
        )

    def test_a_declared_dependency_joins_the_derived_one(self) -> None:
        from aria_kernel.tool_registry import runner_repo_local_dependencies, validate_runner_definition

        runner = validate_runner_definition(self._runner(
            argv=["npx", "ts-node", "x.ts"], cwd=".", repo_local_dependencies=["node_modules/eslint/bin/eslint.js"],
        ))
        self.assertEqual(
            runner_repo_local_dependencies(runner),
            ("node_modules/eslint/bin/eslint.js", "node_modules/ts-node/dist/bin.js"),
        )

    def test_a_runner_without_dependencies_declares_none(self) -> None:
        from aria_kernel.tool_registry import runner_repo_local_dependencies, validate_runner_definition

        self.assertEqual(runner_repo_local_dependencies(validate_runner_definition(self._runner())), ())

    def test_a_dependency_outside_the_workspace_is_refused(self) -> None:
        from aria_kernel.tool_registry import validate_runner_definition

        for bad in (["../node_modules/x"], ["/usr/bin/node"], [""], "node_modules/x", [3], ["a/../../x"]):
            with self.subTest(declared=bad):
                with self.assertRaises(GovernanceError) as raised:
                    validate_runner_definition(self._runner(repo_local_dependencies=bad))
                self.assertIn("runner.repo_local_dependencies", str(raised.exception))

    def test_the_missing_ones_are_named(self) -> None:
        from aria_kernel.tool_registry import missing_repo_local_dependencies, validate_runner_definition

        with tempfile.TemporaryDirectory() as tmp:
            workspace = Path(tmp)
            (workspace / "node_modules" / "present").mkdir(parents=True)
            (workspace / "node_modules" / "present" / "bin.js").write_text("", encoding="utf-8")
            runner = validate_runner_definition(self._runner(
                repo_local_dependencies=["node_modules/present/bin.js", "node_modules/absent/bin.js"],
            ))
            self.assertEqual(
                missing_repo_local_dependencies(runner, workspace_root=workspace),
                ["node_modules/absent/bin.js"],
            )


if __name__ == "__main__":
    unittest.main()
