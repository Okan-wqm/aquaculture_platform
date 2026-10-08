"""ARIA-MEDIUM-395 — the standalone `tool fixture-refresh` operator verb.

`refresh_fixture_suite` was reachable only through the superseded
heartbeat phase; with that driver dead, no fixture suite has run
automatically, so SHADOW→ACTIVE promotion evidence could only rot.
These tests pin the verb end-to-end through the real cli_main entry
point — no mocks; the fake subprocess runner is the same one the
kernel's own fixture tests use.
"""
from __future__ import annotations

import base64
import contextlib
import io
import json
import tempfile
import unittest
from pathlib import Path

from aria_kernel.cli import main as cli_main
from aria_kernel.tool_registry import register_tool

FAKE_RUNNER = Path(__file__).resolve().parent / "_helpers" / "fake_tool_runner.py"


def fake_tool_argv(output: dict) -> list[str]:
    encoded = base64.b64encode(json.dumps(output, separators=(",", ":")).encode("utf-8")).decode("ascii")
    return ["python3", FAKE_RUNNER.as_posix(), "--output-b64", encoded]


def tool_definition(**overrides) -> dict:
    payload = {
        "tool_id": "learning-adapter",
        "kind": "adapter",
        "version": "1.0.0",
        "status": "SHADOW",
        "declared_scope": ["src/**/*.ts"],
        "output_schema": {"type": "object", "required": ["observations", "findings", "read_paths", "evidence_sources"]},
        "fixture_set": "fixtures/learning-adapter",
        "health_thresholds": {"max_cost_units": 10},
        "allowed_read_globs": ["src/**/*.ts"],
        "forbidden_read_globs": [],
        "claim_types": ["learning"],
        "owner": "platform",
        "runner": {
            "type": "subprocess",
            "argv": fake_tool_argv({
                "observations": [],
                "findings": [],
                "read_paths": ["src/app.ts"],
                "evidence_sources": ["src/app.ts"],
                "cost_units": 1,
            }),
            "cwd": ".",
            "timeout_ms": 1000,
            "stdin_json": True,
        },
        "schema_version": 1,
    }
    payload.update(overrides)
    return payload


def _run(argv: list[str]) -> tuple[int, str]:
    out = io.StringIO()
    err = io.StringIO()
    with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
        try:
            code = cli_main(argv) or 0
        except SystemExit as exc:
            code = exc.code if isinstance(exc.code, int) else 1
    return code, out.getvalue()


class ToolFixtureRefreshVerbTests(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.root = Path(self._tmp.name) / "workspace"
        (self.root / "src").mkdir(parents=True)
        (self.root / "src" / "app.ts").write_text("export const app = true;\n", encoding="utf-8")
        (self.root / "package.json").write_text('{"name":"fixture"}\n', encoding="utf-8")
        (self.root / "nx.json").write_text('{"affected":{}}\n', encoding="utf-8")
        self.tools_dir = Path(self._tmp.name) / "aria-tools"
        fixture_root = self.tools_dir / "fixtures" / "learning-adapter" / "cases"
        fixture_root.mkdir(parents=True)
        (fixture_root / "clean.json").write_text(
            json.dumps({"input": {}, "expected": {"status": "ok", "max_findings": 0}}),
            encoding="utf-8",
        )

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def _argv(self, *extra: str) -> list[str]:
        return [
            "--tools-dir", str(self.tools_dir),
            "tool", "fixture-refresh",
            "--workspace-root", str(self.root),
            "--cycle-id", "cli-fixture-1",
            *extra,
        ]

    def test_scoped_refresh_passes_and_exits_zero(self) -> None:
        register_tool(tool_definition(), base_dir=self.tools_dir)
        code, out = _run(self._argv("--tool-id", "learning-adapter"))
        self.assertEqual(code, 0, out)
        payload = json.loads(out)
        self.assertEqual(payload["status"], "completed")
        self.assertEqual(payload["refreshed"][0]["tool_id"], "learning-adapter")
        self.assertEqual(payload["refreshed"][0]["status"], "current")

    def test_walk_skips_tools_without_a_fixture_set(self) -> None:
        register_tool(tool_definition(), base_dir=self.tools_dir)
        # register_tool enforces a non-empty fixture_set, so a row WITHOUT
        # one is legacy reality the walk must still survive — shape it the
        # way such rows exist in the wild (registry row missing the field).
        no_fixture = tool_definition(tool_id="no-fixture-adapter", claim_types=["other"])
        no_fixture.pop("fixture_set")
        registry_path = self.tools_dir / "registry.json"
        registry = json.loads(registry_path.read_text(encoding="utf-8"))
        registry["tools"].append(no_fixture)
        registry_path.write_text(json.dumps(registry), encoding="utf-8")
        code, out = _run(self._argv())
        self.assertEqual(code, 0, out)
        payload = json.loads(out)
        refreshed_ids = {row["tool_id"] for row in payload["refreshed"]}
        skipped_ids = set(payload["skipped_no_fixture_set"])
        self.assertIn("learning-adapter", refreshed_ids)
        self.assertIn("no-fixture-adapter", skipped_ids)

    def test_failed_suite_exits_one(self) -> None:
        register_tool(tool_definition(runner={
            "type": "subprocess",
            "argv": fake_tool_argv({
                "observations": [],
                "findings": [{
                    "id": "f-1", "rule": "r", "path": "src/app.ts", "message": "m",
                    "severity": "medium", "evidence": [{"path": "src/app.ts", "line": 1}],
                }],
                "read_paths": ["src/app.ts"],
                "evidence_sources": ["src/app.ts"],
                "cost_units": 1,
            }),
            "cwd": ".",
            "timeout_ms": 1000,
            "stdin_json": True,
        }), base_dir=self.tools_dir)
        # The case's contract says a clean run has zero findings; this runner
        # emits one, so the suite fails and the refresh is stale_or_failed.
        code, out = _run(self._argv("--tool-id", "learning-adapter"))
        self.assertEqual(code, 1, out)
        payload = json.loads(out)
        self.assertEqual(payload["refreshed"][0]["status"], "stale_or_failed")


if __name__ == "__main__":  # pragma: no cover
    unittest.main()
