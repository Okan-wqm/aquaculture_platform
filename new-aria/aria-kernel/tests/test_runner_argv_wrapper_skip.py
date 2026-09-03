"""Plan 023 v3 §C-5 — runner argv wrapper-skip + allowlist shape.

Pre-Plan-023 surface_manifest_validator.py:200-206 picked the first
arg ending in .ts/.py/.js as the "script" path:

    script_arg = next(
        (a for a in argv if a.endswith(".ts") or a.endswith(".py") or a.endswith(".js")),
        None,
    )

For argv = ["node", "./node_modules/ts-node/dist/bin.js", "real-adapter.ts"]
the first match is "bin.js" — the runner wrapper, not the adapter.
The validator then existence-checks bin.js (which exists) and reports
no failure, never validating that real-adapter.ts is reachable. An
adapter could ship missing or moved without the registry sync test
catching it.

Plan 023 v3 §C-5 fix: explicitly skip known runner wrappers (node,
ts-node, python3, npx, deno, bun, plus regex for
node_modules/.../bin.{js,cjs,mjs}) when picking the script arg.

Plus: the registry-stub allowlist (aria-tools/registry-stub-allowlist.json)
gained shape-validation. Pre-Plan-023 the validator only checked tool_id
membership; entries with empty `justification` or missing
`plan_021_stream_a_owner` were silently accepted. Post-fix, both fields
must be non-empty strings.
"""
from __future__ import annotations

import json
import shutil
import tempfile
import unittest
from pathlib import Path

from aria_kernel.surface_manifest_validator import (
    validate_registry_adapter_sync,
    validate_registry_runner_paths,
)


def _seed(tmp: Path) -> Path:
    repo = tmp / "repo"
    (repo / "aria-tools").mkdir(parents=True)
    (repo / "tools" / "aria-poc").mkdir(parents=True)
    (repo / "tools" / "aria-adapters").mkdir(parents=True)
    return repo


class RunnerWrapperSkipTests(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = Path(tempfile.mkdtemp(prefix="aria-c5-wrap-"))
        self.repo = _seed(self._tmp)

    def tearDown(self) -> None:
        shutil.rmtree(self._tmp, ignore_errors=True)

    def _write_registry(self, tools: list[dict]) -> None:
        (self.repo / "aria-tools" / "registry.json").write_text(
            json.dumps({"schema_version": 2, "tools": tools}, indent=2),
            encoding="utf-8",
        )

    def test_direct_python3_adapter_existence_validated(self) -> None:
        """Baseline regression: argv = ['python3', 'real_parser.py']
        with the file present passes. Validator picks real_parser.py
        as the script arg correctly."""
        (self.repo / "tools" / "aria-poc" / "real_parser.py").write_text("# adapter\n")
        self._write_registry([{
            "tool_id": "alpha",
            "runner": {
                "argv": ["python3", "real_parser.py"],
                "cwd": "tools/aria-poc",
            },
        }])
        failures = validate_registry_runner_paths(
            repo_root=self.repo, base_dir="aria-tools",
        )
        self.assertEqual(failures, [])

    def test_ts_node_wrapper_skipped_real_adapter_validated(self) -> None:
        """argv = ['node', 'node_modules/ts-node/dist/bin.js', 'adapter.ts']
        Pre-fix the validator picked bin.js. Post-fix: bin.js is
        recognized as a wrapper and skipped; adapter.ts is the real
        script arg and gets existence-checked."""
        (self.repo / "tools" / "aria-poc" / "adapter.ts").write_text("// adapter\n")
        self._write_registry([{
            "tool_id": "alpha",
            "runner": {
                "argv": ["node", "node_modules/ts-node/dist/bin.js", "adapter.ts"],
                "cwd": "tools/aria-poc",
            },
        }])
        failures = validate_registry_runner_paths(
            repo_root=self.repo, base_dir="aria-tools",
        )
        self.assertEqual(failures, [])

    def test_ts_node_wrapper_skipped_missing_adapter_caught(self) -> None:
        """The wrapper-skip exposes a missing real adapter that pre-fix
        would have been masked because bin.js existed."""
        # Only bin.js exists; adapter.ts missing.
        bin_js_dir = self.repo / "tools" / "aria-poc" / "node_modules" / "ts-node" / "dist"
        bin_js_dir.mkdir(parents=True)
        (bin_js_dir / "bin.js").write_text("// runner\n")
        self._write_registry([{
            "tool_id": "alpha",
            "runner": {
                "argv": ["node", "node_modules/ts-node/dist/bin.js", "missing-adapter.ts"],
                "cwd": "tools/aria-poc",
            },
        }])
        failures = validate_registry_runner_paths(
            repo_root=self.repo, base_dir="aria-tools",
        )
        self.assertEqual(len(failures), 1)
        self.assertEqual(failures[0]["reason"], "runner_script_missing")
        self.assertIn("missing-adapter.ts", failures[0]["expected_path"])

    def test_argv_with_only_wrappers_rejects(self) -> None:
        """argv = ['node', 'ts-node'] (no real script) → no script_arg
        found; validator emits runner_argv_no_non_wrapper_script_path."""
        self._write_registry([{
            "tool_id": "alpha",
            "runner": {"argv": ["node", "ts-node"], "cwd": "."},
        }])
        failures = validate_registry_runner_paths(
            repo_root=self.repo, base_dir="aria-tools",
        )
        self.assertTrue(any(
            f.get("reason") == "runner_argv_no_non_wrapper_script_path"
            for f in failures
        ), f"failures: {failures!r}")

    def test_npx_ts_node_argv_real_adapter_validated(self) -> None:
        """Real-world adapter argv pattern: ['npx', 'ts-node', '--project',
        'tsconfig.json', 'adapter.ts']. Wrapper-skip recognizes 'npx' +
        'ts-node' as wrappers; tsconfig.json is the --project arg
        (skipped because not a script suffix); adapter.ts is the script."""
        (self.repo / "tools" / "aria-poc" / "adapter.ts").write_text("// adapter\n")
        self._write_registry([{
            "tool_id": "alpha",
            "runner": {
                "argv": ["npx", "ts-node", "--project", "tsconfig.json", "adapter.ts"],
                "cwd": "tools/aria-poc",
            },
        }])
        failures = validate_registry_runner_paths(
            repo_root=self.repo, base_dir="aria-tools",
        )
        self.assertEqual(failures, [])


class AllowlistShapeTests(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = Path(tempfile.mkdtemp(prefix="aria-c5-shape-"))
        self.repo = _seed(self._tmp)

    def tearDown(self) -> None:
        shutil.rmtree(self._tmp, ignore_errors=True)

    def _write_registry_with_stub(self, tool_id: str = "stub-tool") -> None:
        (self.repo / "aria-tools" / "registry.json").write_text(
            json.dumps({"schema_version": 2, "tools": [{
                "tool_id": tool_id,
                "runner": {"argv": ["python3", "shadow_runner.py", tool_id], "cwd": "tools/aria-poc"},
            }]}, indent=2),
            encoding="utf-8",
        )

    def _write_allowlist(self, entries: list[dict]) -> None:
        (self.repo / "aria-tools" / "registry-stub-allowlist.json").write_text(
            json.dumps({"schema_version": 1, "entries": entries}, indent=2),
            encoding="utf-8",
        )

    def test_valid_entry_passes(self) -> None:
        self._write_registry_with_stub()
        self._write_allowlist([{
            "tool_id": "stub-tool",
            "justification": "Plan 021 Stream A pending parser implementation",
            "plan_021_stream_a_owner": "platform-data-team",
        }])
        failures = validate_registry_adapter_sync(
            repo_root=self.repo, base_dir="aria-tools",
        )
        # No allowlist-shape failures; stub-runner allowlisting works.
        self.assertEqual(
            [f for f in failures
             if f.get("reason") in {"allowlist_entry_shape_invalid", "unallowlisted_stub_runner"}],
            [],
        )

    def test_empty_justification_rejects(self) -> None:
        self._write_registry_with_stub()
        self._write_allowlist([{
            "tool_id": "stub-tool",
            "justification": "",  # empty
            "plan_021_stream_a_owner": "platform-data-team",
        }])
        failures = validate_registry_adapter_sync(
            repo_root=self.repo, base_dir="aria-tools",
        )
        shape_failures = [f for f in failures if f.get("reason") == "allowlist_entry_shape_invalid"]
        self.assertEqual(len(shape_failures), 1)
        self.assertEqual(shape_failures[0]["tool_id"], "stub-tool")

    def test_missing_owner_rejects(self) -> None:
        self._write_registry_with_stub()
        self._write_allowlist([{
            "tool_id": "stub-tool",
            "justification": "valid reason text here",
            # plan_021_stream_a_owner missing
        }])
        failures = validate_registry_adapter_sync(
            repo_root=self.repo, base_dir="aria-tools",
        )
        shape_failures = [f for f in failures if f.get("reason") == "allowlist_entry_shape_invalid"]
        self.assertEqual(len(shape_failures), 1)


if __name__ == "__main__":
    unittest.main()
