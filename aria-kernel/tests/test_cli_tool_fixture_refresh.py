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

import subprocess

from aria_kernel.cli import main as cli_main
from aria_kernel.tool_registry import ensure_tools_binding, register_tool

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
        # Review of #1898 (F1) — the verb runs only against the store's own
        # checkout at a clean, committed HEAD.
        self._git("init", "-q", "-b", "main")
        self._commit("fixture workspace")
        # The verb certifies only a HEAD already on origin/main.
        self.origin = Path(self._tmp.name) / "origin.git"
        subprocess.run(["git", "init", "-q", "--bare", str(self.origin)], check=True)
        self._git("remote", "add", "origin", str(self.origin))
        self._git("push", "-q", "origin", "HEAD:main")
        self.tools_dir = Path(self._tmp.name) / "aria-tools"
        ensure_tools_binding(self.tools_dir, workspace_root=self.root)
        fixture_root = self.tools_dir / "fixtures" / "learning-adapter" / "cases"
        fixture_root.mkdir(parents=True)
        (fixture_root / "clean.json").write_text(
            json.dumps({"input": {}, "expected": {"status": "ok", "max_findings": 0}}),
            encoding="utf-8",
        )

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def _git(self, *args: str, cwd: Path | None = None) -> str:
        return subprocess.run(
            ["git", "-C", str(cwd or self.root), *args], check=True, capture_output=True, text=True,
        ).stdout.strip()

    def _commit(self, message: str, cwd: Path | None = None) -> None:
        self._git("add", "-A", cwd=cwd)
        self._git("-c", "user.email=t@example.invalid", "-c", "user.name=t", "-c", "commit.gpgsign=false",
                  "commit", "-q", "--allow-empty", "-m", message, cwd=cwd)

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
        self.assertEqual(payload["tools"][0]["tool_id"], "learning-adapter")
        self.assertEqual(payload["tools"][0]["status"], "current")
        self.assertEqual(payload["workspace_commit_sha"], self._git("rev-parse", "HEAD"))

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
        refreshed_ids = {row["tool_id"] for row in payload["tools"]}
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
        self.assertEqual(payload["tools"][0]["status"], "stale_or_failed")

    def test_workspace_root_is_required(self) -> None:
        register_tool(tool_definition(), base_dir=self.tools_dir)
        code, _ = _run(["--tools-dir", str(self.tools_dir), "tool", "fixture-refresh", "--cycle-id", "c"])
        self.assertEqual(code, 2)

    def test_a_dirty_checkout_is_refused_and_writes_no_evidence(self) -> None:
        register_tool(tool_definition(), base_dir=self.tools_dir)
        (self.root / "src" / "app.ts").write_text("export const app = false;\n", encoding="utf-8")
        code, out = _run(self._argv("--tool-id", "learning-adapter"))
        self.assertEqual(code, 1, out)
        self.assertEqual(json.loads(out)["status"], "refused")
        self.assertIn("fixture_refresh_workspace_dirty", json.loads(out)["reason"])
        self.assertFalse((self.tools_dir / "fixture-runs.jsonl").exists()
                         and (self.tools_dir / "fixture-runs.jsonl").read_text(encoding="utf-8").strip())

    def test_index_flags_cannot_hide_a_modified_file(self) -> None:
        register_tool(tool_definition(), base_dir=self.tools_dir)
        for flag in ("--assume-unchanged", "--skip-worktree"):
            with self.subTest(flag=flag):
                (self.root / "src" / "app.ts").write_text("export const app = 'changed';\n", encoding="utf-8")
                self._git("update-index", flag, "src/app.ts")
                self.assertEqual(self._git("status", "--porcelain"), "")  # git status alone is fooled
                code, out = _run(self._argv("--tool-id", "learning-adapter"))
                self.assertEqual(code, 1, out)
                self.assertIn("fixture_refresh_workspace_index_flags_hide_changes", json.loads(out)["reason"])
                self._git("update-index", flag.replace("--", "--no-"), "src/app.ts")
                self._git("checkout", "--", "src/app.ts")

    def test_a_clean_branch_not_on_origin_main_is_refused(self) -> None:
        register_tool(tool_definition(), base_dir=self.tools_dir)
        self._git("checkout", "-q", "-b", "feature")
        (self.root / "src" / "app.ts").write_text("export const app = 'unmerged';\n", encoding="utf-8")
        self._commit("unmerged change")
        code, out = _run(self._argv("--tool-id", "learning-adapter"))
        self.assertEqual(code, 1, out)
        self.assertIn("fixture_refresh_head_not_on_origin_main", json.loads(out)["reason"])

    def test_an_unreachable_origin_is_refused(self) -> None:
        register_tool(tool_definition(), base_dir=self.tools_dir)
        self._git("remote", "remove", "origin")
        code, out = _run(self._argv("--tool-id", "learning-adapter"))
        self.assertEqual(code, 1, out)
        self.assertIn("fixture_refresh_origin_unavailable", json.loads(out)["reason"])

    def test_the_check_hands_on_the_resolved_checkout(self) -> None:
        from aria_kernel.fixture_runner import require_pinned_fixture_workspace

        link = Path(self._tmp.name) / "link-to-workspace"
        link.symlink_to(self.root)
        resolved, head = require_pinned_fixture_workspace(link, base_dir=self.tools_dir)
        self.assertEqual(resolved, self.root.resolve())
        self.assertEqual(head, self._git("rev-parse", "HEAD"))

    def test_a_checkout_the_store_is_not_bound_to_is_refused(self) -> None:
        register_tool(tool_definition(), base_dir=self.tools_dir)
        other = Path(self._tmp.name) / "other"
        other.mkdir()
        self._git("init", "-q", cwd=other)
        self._commit("other", cwd=other)
        code, out = _run([
            "--tools-dir", str(self.tools_dir), "tool", "fixture-refresh",
            "--workspace-root", str(other), "--cycle-id", "c", "--tool-id", "learning-adapter",
        ])
        self.assertEqual(code, 1, out)
        self.assertIn("fixture_refresh_workspace_not_bound_checkout", json.loads(out)["reason"])

    def test_a_named_tool_without_a_fixture_set_is_refused_by_name(self) -> None:
        register_tool(tool_definition(), base_dir=self.tools_dir)
        no_fixture = tool_definition(tool_id="no-fixture-adapter", claim_types=["other"])
        no_fixture.pop("fixture_set")
        registry_path = self.tools_dir / "registry.json"
        registry = json.loads(registry_path.read_text(encoding="utf-8"))
        registry["tools"].append(no_fixture)
        registry_path.write_text(json.dumps(registry), encoding="utf-8")
        code, out = _run(self._argv("--tool-id", "no-fixture-adapter"))
        self.assertEqual(code, 1, out)
        self.assertIn("fixture_refresh_tool_has_no_fixture_set: no-fixture-adapter", json.loads(out)["reason"])

    def test_a_blocked_refresh_reaches_governance_from_the_verb(self) -> None:
        register_tool(tool_definition(), base_dir=self.tools_dir)
        import shutil

        shutil.rmtree(self.tools_dir / "fixtures" / "learning-adapter" / "cases")
        code, out = _run(self._argv("--tool-id", "learning-adapter"))
        self.assertEqual(code, 1, out)
        self.assertEqual(json.loads(out)["tools"][0]["status"], "blocked")
        governance = (self.tools_dir / "governance.jsonl").read_text(encoding="utf-8")
        self.assertIn("fixture_refresh_blocked", governance)


if __name__ == "__main__":  # pragma: no cover
    unittest.main()
