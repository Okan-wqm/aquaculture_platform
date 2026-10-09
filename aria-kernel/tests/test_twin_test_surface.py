"""ARIA-MEDIUM-382 — the repository map states every project's test targets and spec files.

Measured on plan ``plan-cyc-20261007T081056Z-auto`` (F-015, 2026-10-07): a
cross-reviewer wrote "the repository map lists no spec under web-hr-module ...
the runner may be unconfigured". hr-module's ``package.json`` runs
``vitest run`` as ``test``, nx infers it as the project's ``test`` target
(``project.json`` declares none), and two spec files under the project passed
that day. The map's project entries held no test fact, and ``LeavesPage.tsx``
has no spec of its own, so the prompt said nothing and the silence read as
"none".

The fixture mirrors that shape: an ``hr-module`` whose test target exists
only as a ``package.json`` script, two specs that test other files, and the
page the plan touches with no spec.
"""
from __future__ import annotations

import json
import subprocess
import tempfile
import unittest
from pathlib import Path

from aria_kernel.agent_invocations import _render_repository_map
from aria_kernel.twin import (
    TWIN_MAP_RELPATH,
    build_twin_map,
    read_twin_map,
    refresh_twin_map,
    twin_context_for_files,
)

_PAGE = "web/modules/hr-module/src/pages/leaves/LeavesPage.tsx"
_SPECS = ["web/modules/hr-module/src/components/leave/LeaveBalanceWidget.spec.tsx",
          "web/modules/hr-module/src/pages/scheduling/__tests__/WeeklySchedulePage.spec.tsx"]
_PROJECT_JSON = {"name": "hr-module", "targets": {
    "build": {"executor": "nx:run-commands", "options": {"command": "npm run build"}},
    "lint": {"executor": "nx:run-commands", "options": {"command": "npm run lint"}}}}
_PACKAGE_JSON = {"name": "hr-module", "scripts": {"build": "vite build", "lint": "eslint src",
                                                   "test": "vitest run", "test:watch": "vitest"}}


def _git(repo: Path, *args: str) -> str:
    return subprocess.run(["git", "-C", str(repo), *args], capture_output=True, text=True, check=True).stdout


def _commit(repo: Path, files: dict[str, str], message: str) -> None:
    for relative, text in files.items():
        (repo / relative).parent.mkdir(parents=True, exist_ok=True)
        (repo / relative).write_text(text, encoding="utf-8")
    _git(repo, "add", "-A")
    _git(repo, "-c", "user.email=twin@test", "-c", "user.name=twin", "commit", "-q", "-m", message)


class TwinTestSurface(unittest.TestCase):
    def setUp(self) -> None:
        tmp = tempfile.TemporaryDirectory(prefix="aria-382-")
        self.addCleanup(tmp.cleanup)
        self.repo = Path(tmp.name) / "repo"
        self.repo.mkdir()
        self.tools = Path(tmp.name) / "aria-tools"
        self.clean_tools = Path(tmp.name) / "clean-tools"
        _git(self.repo, "init", "-q")
        _commit(self.repo, {
            "web/modules/hr-module/project.json": json.dumps(_PROJECT_JSON),
            "web/modules/hr-module/package.json": json.dumps(_PACKAGE_JSON),
            _PAGE: "export const LeavesPage = 1;\n",
            **{spec: "export const spec = 1;\n" for spec in _SPECS},
            "apps/hr-service/project.json": json.dumps({"name": "hr-service", "targets": {
                "test": {"executor": "@nx/jest:jest", "options": {"jestConfig": "apps/hr-service/jest.config.ts"}}}}),
            "apps/hr-service/src/main.ts": "export const main = 1;\n",
            "libs/untested/project.json": json.dumps({"name": "untested", "targets": {"build": {}}}),
            "libs/untested/src/index.ts": "export const x = 1;\n",
            "libs/bare/src/index.ts": "export const bare = 1;\n",
            # Review MEDIUM-2 — a Rust crate and a Python project, which nx manifests do not describe.
            "crates/codec/Cargo.toml": "[package]\nname = \"codec\"\nversion = \"0.1.0\"\n",
            "crates/codec/src/lib.rs": "pub fn f() {}\n#[cfg(test)]\nmod tests {}\n",
            "crates/codec/src/plain.rs": "pub fn g() {}\n",
            "crates/codec/tests/round_trip.rs": "#[test]\nfn round_trip() {}\n",
            "tools/pykit/pyproject.toml": "[project]\nname = \"pykit\"\n[tool.pytest.ini_options]\n",
            "tools/pykit/tests/test_kit.py": "def test_kit():\n    pass\n",
            "tools/pykit/kit.py": "X = 1\n",
        }, "first")

    def test_the_inferred_target_and_the_specs_are_on_every_project(self) -> None:
        projects = build_twin_map(workspace_root=self.repo, base_dir=self.tools)["projects"]
        hr = projects["web-hr-module"]
        self.assertEqual(hr["test_targets"], [
            {"name": "test", "source": "package.json", "command": "vitest run"},
            {"name": "test:watch", "source": "package.json", "command": "vitest"},
        ])
        self.assertEqual(hr["spec_files"], sorted(_SPECS))
        self.assertEqual(projects["hr-service"]["test_targets"],
                         [{"name": "test", "source": "project.json", "command": "@nx/jest:jest"}])
        # A project with neither still carries the fact, as an empty list.
        self.assertEqual((projects["untested"]["test_targets"], projects["untested"]["spec_files"]), ([], []))

    def test_a_rust_crate_and_a_python_project_report_their_runners(self) -> None:
        projects = build_twin_map(workspace_root=self.repo, base_dir=self.tools)["projects"]
        codec = projects["crates-codec"]
        self.assertEqual(codec["test_targets"], [{"name": "cargo test", "source": "Cargo.toml", "command": "cargo test"}])
        # Integration tests under tests/ and modules with #[cfg(test)]; a plain module is not a spec.
        self.assertEqual(codec["spec_files"], ["crates/codec/src/lib.rs", "crates/codec/tests/round_trip.rs"])
        pykit = projects["tools-pykit"]
        self.assertEqual(pykit["test_targets"], [{"name": "pytest", "source": "pyproject.toml", "command": "pytest"}])
        self.assertEqual(pykit["spec_files"], ["tools/pykit/tests/test_kit.py"])
        twin = read_twin_map(base_dir=self.tools)
        rendered = _render_repository_map(twin_context_for_files(twin, ["crates/codec/src/plain.rs"]))
        self.assertIn("test targets: `cargo test` (`cargo test`, Cargo.toml)", rendered)
        self.assertIn("spec files (2)", rendered)

    def test_a_project_whose_manifest_is_not_read_says_not_modelled_never_none(self) -> None:
        twin = build_twin_map(workspace_root=self.repo, base_dir=self.tools)
        self.assertFalse(twin["projects"]["bare"]["test_surface_modelled"])
        rendered = _render_repository_map(twin_context_for_files(twin, ["libs/bare/src/index.ts"]))
        self.assertIn("test targets: not modelled", rendered)
        self.assertNotIn("none declared or inferred", rendered)

    def test_the_planner_prompt_states_the_runner_for_a_file_with_no_spec_of_its_own(self) -> None:
        twin = build_twin_map(workspace_root=self.repo, base_dir=self.tools)
        context = twin_context_for_files(twin, [_PAGE])
        self.assertEqual(context["files"][0]["tests"], [])
        rendered = _render_repository_map(context)
        self.assertIn("test targets: `test` (`vitest run`, package.json)", rendered)
        self.assertIn(f"spec files (2): `{sorted(_SPECS)[0]}`", rendered)
        # A row sealed from a v1 map has no test facts and renders exactly as it was sealed.
        sealed = {**context, "impacted_projects": [[name, {k: v for k, v in meta.items() if k in (
            "layer", "depends_on", "dependents")}] for name, meta in context["impacted_projects"]]}
        self.assertNotIn("test targets", _render_repository_map(sealed))

    def test_a_project_with_no_runner_says_so_in_words(self) -> None:
        twin = build_twin_map(workspace_root=self.repo, base_dir=self.tools)
        rendered = _render_repository_map(twin_context_for_files(twin, ["libs/untested/src/index.ts"]))
        self.assertIn("test targets: none declared or inferred", rendered)
        self.assertIn("spec files: none", rendered)

    def test_an_nx_included_scripts_list_narrows_the_inferred_targets(self) -> None:
        narrowed = dict(_PACKAGE_JSON, nx={"includedScripts": ["test"]})
        _commit(self.repo, {"web/modules/hr-module/package.json": json.dumps(narrowed)}, "narrow")
        hr = build_twin_map(workspace_root=self.repo, base_dir=self.tools)["projects"]["web-hr-module"]
        self.assertEqual([target["name"] for target in hr["test_targets"]], ["test"])

    def test_a_refresh_equals_a_rebuild_after_a_new_spec_and_a_new_script(self) -> None:
        build_twin_map(workspace_root=self.repo, base_dir=self.tools)
        scripts = dict(_PACKAGE_JSON["scripts"], **{"test:integration": "vitest run -c vitest.int.ts"})
        _commit(self.repo, {
            "web/modules/hr-module/package.json": json.dumps(dict(_PACKAGE_JSON, scripts=scripts)),
            "web/modules/hr-module/src/pages/leaves/LeavesPage.spec.tsx":
                "import { LeavesPage } from './LeavesPage';\n",
        }, "second")
        incremental = refresh_twin_map(workspace_root=self.repo, base_dir=self.tools)
        self.assertEqual(incremental["refresh"]["mode"], "incremental")
        rebuild = build_twin_map(workspace_root=self.repo, base_dir=self.clean_tools)
        self.assertEqual(incremental["projects"], rebuild["projects"])
        self.assertIn("test:integration", [t["name"] for t in rebuild["projects"]["web-hr-module"]["test_targets"]])

    def test_a_map_written_before_the_test_surface_is_rebuilt_whole(self) -> None:
        build_twin_map(workspace_root=self.repo, base_dir=self.tools)
        path = self.tools / TWIN_MAP_RELPATH
        legacy = json.loads(path.read_text(encoding="utf-8"))
        legacy["schema_version"] = 1
        for meta in legacy["projects"].values():
            meta.pop("test_targets")
            meta.pop("spec_files")
        path.write_text(json.dumps(legacy), encoding="utf-8")
        twin = refresh_twin_map(workspace_root=self.repo, base_dir=self.tools)
        self.assertEqual(twin["refresh"], {"mode": "full", "reason": "schema_changed"})
        self.assertIn("test_targets", twin["projects"]["web-hr-module"])


if __name__ == "__main__":
    unittest.main()
