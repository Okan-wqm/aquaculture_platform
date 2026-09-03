"""Plan 032 Faz 032b-2 — the hooks decide at the moment the tool fires, and
the journal never carries a secret.

Invariants:
  I-V12-HOOK-01  a write-capable spawn under a kernel profile carries a
                 `--settings` file with permission rules AND the five kernel
                 hooks; a profiled write spawn with no ledger context refuses.
  I-V12-HOOK-02  PreToolUse: an allowed command → allow; a denied/chained/
                 unlisted command → deny (exit 2); an Edit under READONLY_PATHS
                 or outside the workspace → deny; a raising policy → deny.
  I-V12-HOOK-03  every verdict lands on `hooks/decisions.jsonl`.
  I-V12-HOOK-04  PostToolUse writes a SANITIZED journal row: family, redacted
                 argv, command hash, external_effect — never the raw command;
                 a quoted secret is redacted and its pattern class named.
  I-V12-HOOK-05  session hooks produce a handoff snapshot with the matching
                 trigger.
  I-V12-HOOK-06  the CLI `hook` verbs read stdin and print the protocol JSON.

NOT RUN at authoring time (operator instruction 2026-09-03).
"""
from __future__ import annotations

import io
import json
import os
import sys
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from unittest import mock

from tests.invariants.v12 import _helpers  # noqa: F401 — sys.path

from aria_kernel import hooks
from aria_kernel.claude_settings import HOOK_EVENTS, build_settings, settings_hash, write_settings_file
from aria_kernel.governance_reader import read_governance_rows  # noqa: F401 — import guard
from aria_kernel.handoff_ledger import list_handoffs
from aria_kernel.ledger import load_declared_jsonl
from aria_kernel.runtime_profiles import profile_by_id
from aria_kernel.tool_registry import ensure_tools_dir

_REPO_ROOT = Path(__file__).resolve().parents[4]
_POC = _REPO_ROOT / "tools" / "aria-poc"
if str(_POC) not in sys.path:
    sys.path.insert(0, str(_POC))


def _payload(tool: str, **tool_input) -> dict:
    return {
        "session_id": "sess-1", "tool_use_id": "toolu_1", "hook_event_name": "PreToolUse",
        "tool_name": tool, "tool_input": tool_input, "cwd": "/w",
    }


class SettingsCarryRulesAndHooks(unittest.TestCase):
    def test_I_V12_HOOK_01_profiled_settings_have_rules_and_every_hook(self) -> None:
        ctx = {"python": "python3", "kernel_root": "/w/aria-kernel", "tools_dir": "/t", "workspace_root": "/w", "request_id": "AIR-1"}
        settings = build_settings(profile_by_id("implementer"), hook_context=ctx)
        self.assertEqual(set(settings["hooks"]), set(HOOK_EVENTS))
        self.assertIn("Bash(curl*)", settings["permissions"]["deny"])
        self.assertIn("Read(./.env)", settings["permissions"]["deny"])
        self.assertIn("WebFetch", settings["permissions"]["deny"])
        # Faz 032d: the implementer holds the external-write grant, so its ONE allowed
        # push is projected; a closed-grant write profile (worker) never gets it.
        self.assertIn("Bash(git push origin aria-impl-*)", settings["permissions"]["allow"])
        closed = build_settings(profile_by_id("worker"), hook_context=ctx)
        self.assertNotIn("Bash(git push origin aria-impl-*)", closed["permissions"]["allow"])
        self.assertIn("Bash(git push*)", closed["permissions"]["deny"])
        command = settings["hooks"]["PreToolUse"][0]["hooks"][0]["command"]
        self.assertIn("-m aria_kernel hook pre-tool", command)
        self.assertIn("--request-id AIR-1", command)
        self.assertTrue(settings_hash(settings).startswith("sha256:"))
        self.assertEqual(settings_hash(settings), settings_hash(build_settings(profile_by_id("implementer"), hook_context=ctx)))
        preview = build_settings(profile_by_id("judge_opus"), hook_context=None)
        self.assertNotIn("hooks", preview)
        with tempfile.TemporaryDirectory() as tmp:
            path = write_settings_file(settings, directory=tmp, request_id="AIR/1 x")
            self.assertTrue(path.name.startswith("aria-settings-"))
            self.assertEqual(oct(path.stat().st_mode & 0o777), "0o600")
            self.assertEqual(json.loads(path.read_text())["_aria"]["profile"], "implementer")

    def test_I_V12_HOOK_01_a_write_spawn_without_ledger_context_refuses(self) -> None:
        import claude_runtime

        profile = type("P", (), {"profile_id": "implementer"})()
        with self.assertRaises(claude_runtime.ClaudePolicyViolation):
            claude_runtime._write_spawn_settings(
                agent_profile=profile, usage_recording=None, workspace_root="/w", write_capable=True,
            )
        with tempfile.TemporaryDirectory() as tmp, mock.patch.dict(os.environ, {"RUNNER_TEMP": tmp}):
            path = claude_runtime._write_spawn_settings(
                agent_profile=profile, usage_recording=None, workspace_root="/w", write_capable=False,
            )
            self.assertTrue(path and path.exists())
        self.assertIsNone(claude_runtime._write_spawn_settings(
            agent_profile=None, usage_recording=None, workspace_root="/w", write_capable=True,
        ))


class PreToolUseDecides(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.ws = Path(self._tmp.name).resolve()
        (self.ws / "aria-kernel" / "aria_kernel").mkdir(parents=True)
        (self.ws / "apps").mkdir()

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def test_I_V12_HOOK_02_bash_verdicts(self) -> None:
        allow = hooks.decide_pre_tool(_payload("Bash", command="git status --porcelain"), workspace_root=self.ws)
        self.assertEqual((allow.decision, allow.exit_code), ("allow", 0))
        for command in ("curl https://x", "git status && rm -rf /", "rm -rf /", "git push --force origin x", "echo $GH_TOKEN"):
            verdict = hooks.decide_pre_tool(_payload("Bash", command=command), workspace_root=self.ws)
            self.assertEqual((verdict.decision, verdict.exit_code), ("deny", 2), command)
        api = hooks.decide_pre_tool(_payload("Bash", command="gh api /repos/o/r/branches/main/protection"), workspace_root=self.ws)
        self.assertEqual(api.decision, "deny")
        out = json.loads(allow.to_stdout())
        self.assertEqual(out["hookSpecificOutput"]["permissionDecision"], "allow")

    def test_I_V12_HOOK_02_write_verdicts(self) -> None:
        ok = hooks.decide_pre_tool(_payload("Edit", file_path=str(self.ws / "apps" / "x.ts")), workspace_root=self.ws)
        self.assertEqual(ok.decision, "allow")
        kernel = hooks.decide_pre_tool(_payload("Write", file_path=str(self.ws / "aria-kernel" / "aria_kernel" / "cli.py")), workspace_root=self.ws)
        self.assertEqual(kernel.decision, "deny")
        self.assertIn("readonly_path", kernel.reason)
        escape = hooks.decide_pre_tool(_payload("Edit", file_path="/etc/passwd"), workspace_root=self.ws)
        self.assertEqual(escape.decision, "deny")
        missing = hooks.decide_pre_tool(_payload("Edit"), workspace_root=self.ws)
        self.assertEqual(missing.reason, "write_target_missing")
        other = hooks.decide_pre_tool(_payload("Read", file_path="/etc/hostname"), workspace_root=self.ws)
        self.assertEqual(other.decision, "allow")

    def test_I_V12_HOOK_02_a_raising_policy_is_a_deny(self) -> None:
        with mock.patch.object(hooks, "verify_bash_command_allowed", side_effect=RuntimeError("boom")):
            verdict = hooks.decide_pre_tool(_payload("Bash", command="git status"), workspace_root=self.ws)
        self.assertEqual((verdict.decision, verdict.exit_code), ("deny", 2))
        self.assertIn("hook_error:RuntimeError", verdict.reason)


class LedgersAreWritten(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.root = Path(self._tmp.name).resolve()
        self.tools = self.root / "aria-tools"
        ensure_tools_dir(self.tools)

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def test_I_V12_HOOK_03_every_verdict_is_recorded(self) -> None:
        code, out = hooks.run_hook("pre-tool", _payload("Bash", command="git status"), base_dir=self.tools, workspace_root=self.root, request_id="AIR-1")
        self.assertEqual(code, 0)
        code2, _ = hooks.run_hook("pre-tool", _payload("Bash", command="curl x"), base_dir=self.tools, workspace_root=self.root, request_id="AIR-1")
        self.assertEqual(code2, 2)
        rows = load_declared_jsonl(self.tools.joinpath(*hooks.HOOK_DECISIONS_RELPATH), expected_surface=hooks.HOOK_DECISIONS_SURFACE)
        self.assertEqual([r["decision"] for r in rows], ["allow", "deny"])
        self.assertEqual(rows[0]["request_id"], "AIR-1")

    def test_I_V12_HOOK_04_journal_rows_are_sanitized(self) -> None:
        secret = "ghp_" + "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"  # built, so no scanner sees a literal token
        payload = _payload("Bash", command=f"git push origin aria-impl-abc123 --token {secret}")
        payload["hook_event_name"] = "PostToolUse"
        payload["tool_response"] = {"exit_code": 0, "stdout": "ok", "stderr": ""}
        code, _ = hooks.run_hook("post-tool", payload, base_dir=self.tools, workspace_root=self.root, request_id="AIR-1")
        self.assertEqual(code, 0)
        rows = hooks.journal_rows_for("AIR-1", base_dir=self.tools)
        self.assertEqual(len(rows), 1)
        row = rows[0]
        self.assertEqual(row["command_family"], "git_push")
        self.assertTrue(row["external_effect"])
        self.assertTrue(row["command_hash"].startswith("sha256:"))
        self.assertNotIn(secret, json.dumps(row))
        self.assertTrue({"github_pat", "github_token_family", "github_token"} & set(row["redaction_types"]), row["redaction_types"])
        self.assertNotIn("command", row)
        self.assertEqual(row["exit_code"], 0)
        edit = _payload("Edit", file_path=str(self.root / "apps" / "x.ts"))
        edit["hook_event_name"] = "PostToolUse"
        hooks.run_hook("post-tool", edit, base_dir=self.tools, workspace_root=self.root, request_id="AIR-1")
        rows = hooks.journal_rows_for("AIR-1", base_dir=self.tools)
        self.assertEqual(rows[-1]["command_family"], "file_write")
        self.assertEqual(rows[-1]["files_touched"], [str(self.root / "apps" / "x.ts")])

    def test_I_V12_HOOK_05_session_hooks_take_handoff_snapshots(self) -> None:
        for event, trigger in (("SessionStart", "session_start"), ("PreCompact", "pre_compact"), ("SessionEnd", "session_stop")):
            payload = {"session_id": "sess-9", "hook_event_name": event}
            code, out = hooks.run_hook("session", payload, base_dir=self.tools, workspace_root=self.root, request_id="AIR-1")
            self.assertEqual(code, 0)
            self.assertEqual(json.loads(out)["aria_session"]["trigger"], trigger)
        triggers = [row["trigger"] for row in list_handoffs(base_dir=self.tools)]
        self.assertEqual(triggers, ["session_start", "pre_compact", "session_stop"])

    def test_I_V12_HOOK_06_the_cli_reads_stdin_and_prints_the_protocol(self) -> None:
        from aria_kernel.cli import main

        payload = json.dumps(_payload("Bash", command="curl x"))
        buf = io.StringIO()
        with mock.patch.object(sys, "stdin", io.StringIO(payload)), redirect_stdout(buf):
            code = main(["hook", "pre-tool", "--tools-dir", str(self.tools), "--workspace-root", str(self.root), "--request-id", "AIR-1"])
        self.assertEqual(code, 2)
        self.assertEqual(json.loads(buf.getvalue())["hookSpecificOutput"]["permissionDecision"], "deny")


if __name__ == "__main__":
    unittest.main()
