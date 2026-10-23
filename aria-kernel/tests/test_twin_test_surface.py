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

ARIA-LOW-545 — a Rust file is spec evidence when the one Rust reader
(``tools/aria-adapters/rust-source.ts``, asked through ``rust-test-files.ts``
in the adapter room) finds a test function in it; the map's own rule (under
``tests/``, or the substring ``#[cfg(test)]``) is gone. The codec crate holds
the cases the two disagreed on.
"""
from __future__ import annotations

import json
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from aria_kernel import twin_test_surface
from aria_kernel.agent_invocations import _render_repository_map
from aria_kernel.twin import (
    TWIN_MAP_RELPATH,
    build_twin_map,
    read_twin_map,
    refresh_twin_map,
    twin_context_for_files,
)
from aria_kernel.twin_test_surface import RustReaderUnavailable, RustTestFiles, rust_reader_answer

REPO = Path(__file__).resolve().parents[2]

_PAGE = "web/modules/hr-module/src/pages/leaves/LeavesPage.tsx"
_SPECS = ["web/modules/hr-module/src/components/leave/LeaveBalanceWidget.spec.tsx",
          "web/modules/hr-module/src/pages/scheduling/__tests__/WeeklySchedulePage.spec.tsx"]
_PROJECT_JSON = {"name": "hr-module", "targets": {
    "build": {"executor": "nx:run-commands", "options": {"command": "npm run build"}},
    "lint": {"executor": "nx:run-commands", "options": {"command": "npm run lint"}}}}
_PACKAGE_JSON = {"name": "hr-module", "scripts": {"build": "vite build", "lint": "eslint src",
                                                   "test": "vitest run", "test:watch": "vitest"}}
# ARIA-LOW-545 — the Rust cases the map's old rule and the reader disagreed on.
_RUST_CRATE = {
    "crates/codec/Cargo.toml": "[package]\nname = \"codec\"\nversion = \"0.1.0\"\n",
    # Inline test functions: a spec. Its out-of-line test module is declared here.
    "crates/codec/src/lib.rs": ("pub fn f() {}\n#[cfg(test)]\nmod e2e_tests;\n"
                                "#[cfg(test)]\nmod tests {\n    #[test]\n    fn f() {}\n}\n"),
    # Gated where it is declared (as bytecode_e2e_tests.rs is): no #[cfg(test)]
    # in the file, and the old rule missed it.
    "crates/codec/src/e2e_tests.rs": "#[tokio::test]\nasync fn e2e() {}\n",
    # The substring in a doc comment: the old rule called it a spec.
    "crates/codec/src/mock.rs": "//! `#[cfg(test)]`-gated by the crate root.\npub struct Mock;\n",
    "crates/codec/src/plain.rs": "pub fn g() {}\n",
    "crates/codec/tests/round_trip.rs": "#[test]\nfn round_trip() {}\n",
    # A compile-fail input under tests/: the old rule called it a spec.
    "crates/codec/tests/compile_fail/no_token.rs": "fn main() { let _ = connect(); }\n",
}
_RUST_SPECS = ["crates/codec/src/e2e_tests.rs", "crates/codec/src/lib.rs", "crates/codec/tests/round_trip.rs"]
# The reader and what it needs to run, copied from this checkout into a fixture.
_READER_FILES = (
    "tools/aria-adapters/adapter-fs.ts", "tools/aria-adapters/rust-cargo.ts",
    "tools/aria-adapters/rust-source.ts", "tools/aria-adapters/rust-test-files.ts", "tools/gates/tsconfig.json",
)


def _reader_answering(test_files: list[str]):
    """A Rust reader that names ``test_files`` and reads every other asked file."""
    def read(root: Path, paths, store) -> RustTestFiles:
        return RustTestFiles(test_files=frozenset(path for path in paths if path in test_files),
                             unreadable=frozenset())
    return read


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
            **_RUST_CRATE,
            "tools/pykit/pyproject.toml": "[project]\nname = \"pykit\"\n[tool.pytest.ini_options]\n",
            "tools/pykit/tests/test_kit.py": "def test_kit():\n    pass\n",
            "tools/pykit/kit.py": "X = 1\n",
        }, "first")

    def test_the_inferred_target_and_the_specs_are_on_every_project(self) -> None:
        projects = build_twin_map(workspace_root=self.repo, base_dir=self.tools)["projects"]
        hr = projects["hr-module"]
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
        # The reader's answer, as the map attributes and renders it (the
        # reader itself runs in RustSpecEvidenceIsTheReadersAnswer).
        with patch.object(twin_test_surface, "read_rust_test_files", _reader_answering(_RUST_SPECS)):
            projects = build_twin_map(workspace_root=self.repo, base_dir=self.tools)["projects"]
        codec = projects["crates-codec"]
        self.assertEqual(codec["test_targets"], [{"name": "cargo test", "source": "Cargo.toml", "command": "cargo test"}])
        self.assertEqual(codec["spec_files"], _RUST_SPECS)
        self.assertNotIn("rust_test_files_unread", codec)
        pykit = projects["tools-pykit"]
        self.assertEqual(pykit["test_targets"], [{"name": "pytest", "source": "pyproject.toml", "command": "pytest"}])
        self.assertEqual(pykit["spec_files"], ["tools/pykit/tests/test_kit.py"])
        twin = read_twin_map(base_dir=self.tools)
        rendered = _render_repository_map(twin_context_for_files(twin, ["crates/codec/src/plain.rs"]))
        self.assertIn("test targets: `cargo test` (`cargo test`, Cargo.toml)", rendered)
        self.assertIn("spec files (3)", rendered)
        self.assertNotIn("Rust test files: not modelled", rendered)

    def test_rust_the_reader_did_not_read_is_not_modelled_never_none(self) -> None:
        # This fixture has no repository ts-node, so the reader cannot run:
        # its Rust is unread, by name, and the map does not say "no tests".
        twin = build_twin_map(workspace_root=self.repo, base_dir=self.tools)
        codec = twin["projects"]["crates-codec"]
        self.assertEqual(codec["spec_files"], [])
        self.assertEqual(codec["rust_test_files_unread"], {
            "files": 7 - 1, "reason": "missing_repo_local_dependency:node_modules/ts-node/dist/bin.js"})
        rendered = _render_repository_map(twin_context_for_files(twin, ["crates/codec/src/plain.rs"]))
        self.assertIn("spec files: none among the files read", rendered)
        self.assertIn("Rust test files: not modelled for 6 file(s) (missing_repo_local_dependency:", rendered)
        self.assertNotIn("spec files: none\n", rendered)

    def test_files_the_reader_could_not_read_are_counted_against_their_project(self) -> None:
        def read(root: Path, paths, store) -> RustTestFiles:
            return RustTestFiles(test_files=frozenset({"crates/codec/tests/round_trip.rs"}),
                                 unreadable=frozenset({"crates/codec/src/mock.rs"}))

        with patch.object(twin_test_surface, "read_rust_test_files", read):
            codec = build_twin_map(workspace_root=self.repo, base_dir=self.tools)["projects"]["crates-codec"]
        self.assertEqual(codec["spec_files"], ["crates/codec/tests/round_trip.rs"])
        self.assertEqual(codec["rust_test_files_unread"], {"files": 1, "reason": "unreadable_by_the_rust_reader"})

    def test_a_refresh_that_reads_every_rust_file_drops_the_prior_unread_record(self) -> None:
        # A night the reader could not run, then one it could: an incremental
        # refresh (no graph change) starts from the prior projects, and the
        # unread record of the first night must not survive into the second.
        build_twin_map(workspace_root=self.repo, base_dir=self.tools)
        _commit(self.repo, {"crates/codec/src/plain.rs": "pub fn g() -> u8 { 1 }\n"}, "rust edit")
        with patch.object(twin_test_surface, "read_rust_test_files", _reader_answering(_RUST_SPECS)):
            incremental = refresh_twin_map(workspace_root=self.repo, base_dir=self.tools)
            rebuild = build_twin_map(workspace_root=self.repo, base_dir=self.clean_tools)
        self.assertEqual(incremental["refresh"]["mode"], "incremental")
        self.assertNotIn("rust_test_files_unread", incremental["projects"]["crates-codec"])
        self.assertEqual(incremental["projects"], rebuild["projects"])

    def test_every_key_the_surface_emits_is_one_a_merge_replaces(self) -> None:
        surface = twin_test_surface.project_test_surface(
            self.repo, {"crates-codec": {"root": "crates/codec"}},
            twin_test_surface.SpecInventory(files=(), rust_unread=("crates/codec/src/lib.rs",), rust_unread_reason="x"))
        self.assertEqual(set(surface["crates-codec"]), set(twin_test_surface.TEST_SURFACE_KEYS))

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
        hr = build_twin_map(workspace_root=self.repo, base_dir=self.tools)["projects"]["hr-module"]
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
        self.assertIn("test:integration", [t["name"] for t in rebuild["projects"]["hr-module"]["test_targets"]])

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
        self.assertIn("test_targets", twin["projects"]["hr-module"])


class RustReaderAnswerTests(unittest.TestCase):
    """The reader's stdout is an answer about the asked files, or no answer."""

    ASKED = ["a/src/lib.rs", "a/tests/t.rs"]

    def test_a_well_formed_answer(self) -> None:
        answer = rust_reader_answer(json.dumps({"test_files": ["a/tests/t.rs"],
                                                "unreadable": [{"path": "a/src/lib.rs", "reason": "lex_failed"}]}),
                                    self.ASKED)
        self.assertEqual(answer, RustTestFiles(test_files=frozenset({"a/tests/t.rs"}),
                                               unreadable=frozenset({"a/src/lib.rs"})))

    def test_anything_else_is_no_answer(self) -> None:
        for stdout in ("not json", "[]", json.dumps({"test_files": "a/tests/t.rs", "unreadable": []}),
                       json.dumps({"test_files": [], "unreadable": ["a/src/lib.rs"]}),
                       json.dumps({"test_files": ["elsewhere.rs"], "unreadable": []}),
                       json.dumps({"test_files": ["a/tests/t.rs"], "unreadable": [{"path": "a/tests/t.rs"}]})):
            with self.subTest(stdout=stdout), self.assertRaises(RustReaderUnavailable):
                rust_reader_answer(stdout, self.ASKED)


class RustSpecEvidenceIsTheReadersAnswer(unittest.TestCase):
    """The real reader, in the real adapter room, on a fixture repository."""

    def setUp(self) -> None:
        from aria_kernel.implementation_safety import sandbox_backend

        if not (REPO / "node_modules" / "ts-node" / "dist" / "bin.js").is_file():
            self.skipTest("this checkout has no repository ts-node to run the Rust reader with")
        if sandbox_backend() is None:
            self.skipTest("no adapter-room backend on this host")
        tmp = tempfile.TemporaryDirectory(prefix="aria-545-")
        self.addCleanup(tmp.cleanup)
        self.repo = Path(tmp.name) / "repo"
        self.repo.mkdir()
        self.tools = Path(tmp.name) / "aria-tools"
        _git(self.repo, "init", "-q")
        _commit(self.repo, {**_RUST_CRATE, **{path: (REPO / path).read_text(encoding="utf-8")
                                              for path in _READER_FILES}}, "rust")
        # Installed, untracked: the room binds it as the dependency tree.
        (self.repo / "node_modules").symlink_to(REPO / "node_modules", target_is_directory=True)

    def test_the_map_lists_the_rust_files_the_reader_finds_tests_in(self) -> None:
        twin = build_twin_map(workspace_root=self.repo, base_dir=self.tools)
        codec = twin["projects"]["crates-codec"]
        self.assertNotIn("rust_test_files_unread", codec, codec.get("rust_test_files_unread"))
        self.assertEqual(codec["spec_files"], _RUST_SPECS)


if __name__ == "__main__":
    unittest.main()
