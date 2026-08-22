"""ORPHAN-HIGH-779 — the fixture path-guard must survive the state-store layout.

The nightly lane binds ARIA_TOOLS_DIR to `<workspace>/.aria-state-store/tools`
(``state_store.tools_root``), so ``tools_dir.parent`` is ``.aria-state-store``,
not the repo. The pre-fix guard anchored repo_root there and rejected every
valid registry path as ``fixture_path_escape_outside_repo``; six completed
cycles (Aug 17-19) produced zero fixture rows and the nightly reports showed
nothing. These tests rebuild the exact runner shape — a checkout with a
``.git`` entry, the tools root two levels below it, the fixture corpus under
``tools/aria-adapters/fixtures/`` — and require resolution and suite
execution to work WITHOUT env overrides, from an unrelated CWD.
"""
from __future__ import annotations

import base64
import json
import os
import shutil
import tempfile
import unittest
from pathlib import Path

from aria_kernel import register_tool, run_fixture_suite
from aria_kernel.fixture_runner import resolve_fixture_dir
from aria_kernel.tool_registry import GovernanceError, ensure_tools_dir, get_tool

FAKE_RUNNER = Path(__file__).resolve().parent / "_helpers" / "fake_tool_runner.py"


def _fake_tool_argv(output: dict) -> list[str]:
    encoded = base64.b64encode(json.dumps(output, separators=(",", ":")).encode("utf-8")).decode("ascii")
    return ["python3", FAKE_RUNNER.as_posix(), "--output-b64", encoded]


class StateStoreLayoutTests(unittest.TestCase):
    def setUp(self) -> None:
        self._saved_env = {key: os.environ.get(key) for key in ("ARIA_TOOLS_DIR", "ARIA_REPO_ROOT")}
        os.environ.pop("ARIA_REPO_ROOT", None)
        os.environ.pop("ARIA_TOOLS_DIR", None)

        # The runner shape: a checkout whose .git exists (discovery anchor),
        # the state store restored inside it, tools two levels below the root.
        self.workspace = Path(tempfile.mkdtemp(prefix="aria-779-workspace-"))
        (self.workspace / ".git").mkdir()
        self.tools = self.workspace / ".aria-state-store" / "tools"
        ensure_tools_dir(self.tools)

        self.fixture_dir = self.workspace / "tools" / "aria-adapters" / "fixtures" / "x-adapter"
        (self.fixture_dir / "cases").mkdir(parents=True)
        (self.fixture_dir / "cases" / "clean.json").write_text(
            json.dumps({"input": {}, "expected": {"status": "ok", "max_findings": 0}}),
            encoding="utf-8",
        )
        # The evidence the fake adapter cites must exist in the workspace,
        # exactly like every other fixture-suite test's setUp.
        src_dir = self.workspace / "src"
        src_dir.mkdir()
        (src_dir / "app.ts").write_text("export const app = true;\n", encoding="utf-8")
        # An unrelated CWD: resolution must not depend on where the process
        # happens to stand. (The pre-fix CWD-relative first branch did.)
        self._saved_cwd = os.getcwd()
        self.neutral_cwd = Path(tempfile.mkdtemp(prefix="aria-779-cwd-"))
        os.chdir(self.neutral_cwd)

        register_tool(
            {
                "tool_id": "x-adapter",
                "kind": "adapter",
                "version": "1.0.0",
                "status": "SHADOW",
                "declared_scope": ["src/**/*.ts"],
                "output_schema": {"type": "object", "required": ["observations", "findings", "read_paths", "evidence_sources"]},
                # The registry form that ships today: a REPO-relative path.
                "fixture_set": "tools/aria-adapters/fixtures/x-adapter",
                "health_thresholds": {"max_cost_units": 10},
                "allowed_read_globs": ["src/**/*.ts"],
                "forbidden_read_globs": [],
                "claim_types": ["drift"],
                "owner": "platform",
                "runner": {
                    "type": "subprocess",
                    "argv": _fake_tool_argv(
                        {
                            "observations": [],
                            "findings": [],
                            "read_paths": ["src/app.ts"],
                            "evidence_sources": ["src/app.ts"],
                            "cost_units": 1,
                        }
                    ),
                    "cwd": ".",
                    "timeout_ms": 5000,
                    "stdin_json": True,
                },
                "schema_version": 1,
            },
            base_dir=self.tools,
        )

    def tearDown(self) -> None:
        os.chdir(self._saved_cwd)
        for key, value in self._saved_env.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value
        shutil.rmtree(self.workspace, ignore_errors=True)
        shutil.rmtree(self.neutral_cwd, ignore_errors=True)

    def test_repo_relative_fixture_set_resolves_via_git_discovery(self) -> None:
        tool = get_tool("x-adapter", self.tools)
        resolved = resolve_fixture_dir(tool, self.tools)
        self.assertEqual(resolved, self.fixture_dir.resolve())

    def test_workspace_root_threading_resolves_even_without_git(self) -> None:
        # The .git entry is the discovery anchor; a sandbox without one still
        # resolves when the phase threads its workspace_root down.
        shutil.rmtree(self.workspace / ".git")
        tool = get_tool("x-adapter", self.tools)
        resolved = resolve_fixture_dir(tool, self.tools, workspace_root=self.workspace)
        self.assertEqual(resolved, self.fixture_dir.resolve())

    def test_git_discovery_skips_worktree_stub_files(self) -> None:
        # ORPHAN-HIGH-797 — the state store is a git WORKTREE of aria/state:
        # its .git is a FILE (stub), not a directory. Discovery must not
        # anchor there or the checkout's own fixture paths read as escapes —
        # the live failure on the first fully-alive night.
        stub = self.tools.parent / ".git"
        stub.write_text("gitdir: /somewhere/else/main-worktree\n", encoding="utf-8")
        tool = get_tool("x-adapter", self.tools)
        resolved = resolve_fixture_dir(tool, self.tools)
        # Discovery walks past the stub FILE to the workspace's real .git dir.
        self.assertEqual(resolved, self.fixture_dir.resolve())

    def test_suite_actually_writes_the_row_the_six_nights_never_got(self) -> None:
        result = run_fixture_suite(
            "x-adapter",
            workspace_root=self.workspace,
            cycle_id="cyc-779-proof",
            base_dir=self.tools,
        )
        self.assertTrue(result["passed"], f"suite must pass: {result.get('failed_cases')}")
        ledger = self.tools / "fixture-runs.jsonl"
        self.assertTrue(ledger.exists(), "fixture-runs.jsonl must exist — the 779 regression")
        rows = [json.loads(line) for line in ledger.read_text(encoding="utf-8").splitlines() if line.strip()]
        self.assertTrue(any(row.get("cycle_id") == "cyc-779-proof" for row in rows))

    def test_escape_guard_still_bites_in_the_state_store_layout(self) -> None:
        tool = dict(get_tool("x-adapter", self.tools))
        tool["fixture_set"] = "../../etc/passwd"
        with self.assertRaises(GovernanceError):
            resolve_fixture_dir(tool, self.tools, workspace_root=self.workspace)


if __name__ == "__main__":
    unittest.main()
