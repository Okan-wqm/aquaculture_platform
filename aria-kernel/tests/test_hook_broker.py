"""ARIA-HIGH-123 — the hooks decide and journal outside the sandbox, through the broker.

The hook commands compiled into a spawn's settings used to run the whole
kernel hook inside the agent's sandbox, so the state store had to be
reachable — and writable — from inside (the first cut bound it writable:
every kernel surface forgeable). Now the settings compile a stdlib-only
CLIENT (`hook_client.py`, run by path, naming nothing but the verb) that
ships the CLI's payload to a broker served in the executor process
(`hook_broker.serve_hook_broker`) on a unix socket; the broker runs the
hook with the KERNEL's facts. One property per test:

* the broker decides a PreToolUse with the command policy and records the
  verdict on the real store under ITS request id, whatever the client sends;
* a budgeted broker admits turns against the cap the kernel compiled — the
  count lives outside the sandbox, and the cap cannot be named by the client;
* PostToolUse journals (sanitized) and session events take handoff
  snapshots, all outside;
* the client CLI reads stdin, prints the protocol JSON and exits with the
  broker's code — end to end through a subprocess, by path, with no kernel
  import inside; a missing or dead socket is a DENY for pre-tool and an
  "unrecorded" note otherwise; an oversized request is a deny;
* the settings hook command names the client, the verb and nothing else —
  no store, no request id, no cap — and the client's timeout stays below
  the settings' hook timeout;
* the broker's socket directory is gone on exit; the sweep removes one a
  killed executor left and leaves a live broker alone.
"""
from __future__ import annotations

import io
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from aria_kernel import hook_broker as hb
from aria_kernel import hook_client as hc
from aria_kernel.claude_settings import HOOK_TIMEOUT_SECONDS, build_settings, hook_client_path, hook_command
from aria_kernel.hook_broker import HOOK_BROKER_SOCKET_ENV, prune_stale_hook_brokers, serve_hook_broker
from aria_kernel.hook_client import EXIT_ALLOW, EXIT_BLOCK, call_hook
from aria_kernel.hooks import HOOK_DECISIONS_RELPATH, HOOK_DECISIONS_SURFACE, journal_rows_for
from aria_kernel.ledger import load_declared_jsonl
from aria_kernel.tool_registry import ensure_tools_dir
from aria_kernel.turn_budget import REASON_IMPLEMENTER_TURN_BUDGET_EXHAUSTED

_KERNEL_ROOT = Path(__file__).resolve().parents[1]


def _payload(tool: str, **tool_input: object) -> dict:
    return {"session_id": "sess-1", "tool_use_id": "toolu_1", "hook_event_name": "PreToolUse",
            "tool_name": tool, "tool_input": tool_input}


class _Store(unittest.TestCase):
    def setUp(self) -> None:
        self.root = Path(tempfile.mkdtemp(prefix="aria-hb-test-")).resolve()
        self.addCleanup(shutil.rmtree, self.root, True)
        self.workspace = self.root / "workspace"
        (self.workspace / "aria-kernel" / "aria_kernel").mkdir(parents=True)
        (self.workspace / ".git").mkdir()
        (self.workspace / "apps").mkdir()
        self.tools = ensure_tools_dir(self.root / "tools")

    def _decisions(self) -> list[dict]:
        path = self.tools.joinpath(*HOOK_DECISIONS_RELPATH)
        return load_declared_jsonl(path, expected_surface=HOOK_DECISIONS_SURFACE) if path.exists() else []


class BrokerDecidesOutside(_Store):
    def test_pre_tool_verdicts_are_the_policys_and_land_under_the_brokers_request(self) -> None:
        with serve_hook_broker(base_dir=self.tools, workspace_root=self.workspace, request_id="AIR-broker",
                               turn_budget=None) as broker:
            self.assertTrue(broker.socket_path.is_socket())
            self.assertEqual(broker.request_id, "AIR-broker")
            allowed = call_hook(str(broker.socket_path), "pre-tool", _payload("Bash", command="git status"))
            denied = call_hook(str(broker.socket_path), "pre-tool", _payload("Bash", command="curl http://x"))
            forged = call_hook(str(broker.socket_path), "pre-tool",
                               {**_payload("Bash", command="curl http://x"), "request_id": "AIR-other"})
        self.assertEqual(allowed[0], EXIT_ALLOW)
        self.assertEqual(json.loads(allowed[1])["hookSpecificOutput"]["permissionDecision"], "allow")
        self.assertEqual(denied[0], EXIT_BLOCK)
        self.assertEqual(json.loads(denied[1])["hookSpecificOutput"]["permissionDecision"], "deny")
        self.assertEqual(forged[0], EXIT_BLOCK)
        rows = self._decisions()
        self.assertEqual([row["decision"] for row in rows], ["allow", "deny", "deny"])
        self.assertEqual({row["request_id"] for row in rows}, {"AIR-broker"}, "the request id is the broker's")
        self.assertFalse(broker.socket_path.parent.exists(), "the socket directory is gone with the broker")

    def test_a_budgeted_broker_counts_turns_outside_the_sandbox(self) -> None:
        with serve_hook_broker(base_dir=self.tools, workspace_root=self.workspace, request_id="AIR-b",
                               turn_budget=1) as broker:
            first = call_hook(str(broker.socket_path), "pre-tool", _payload("Bash", command="git status"))
            second = call_hook(str(broker.socket_path), "pre-tool",
                               {**_payload("Bash", command="git status"), "turn_budget": 99})
        self.assertEqual(first[0], EXIT_ALLOW)
        self.assertEqual(second[0], EXIT_BLOCK)
        reason = json.loads(second[1])["hookSpecificOutput"]["permissionDecisionReason"]
        self.assertTrue(reason.startswith(REASON_IMPLEMENTER_TURN_BUDGET_EXHAUSTED), reason)
        rows = self._decisions()
        self.assertEqual([row["decision"] for row in rows], ["allow", "deny"])
        self.assertEqual(rows[1]["turn_budget"]["cap"], 1, "the cap is the kernel's, not the client's")

    def test_post_tool_journals_and_session_events_snapshot_outside(self) -> None:
        from aria_kernel.handoff_ledger import list_handoffs

        post = {**_payload("Bash", command="git diff --stat"), "hook_event_name": "PostToolUse",
                "tool_response": {"exit_code": 0, "stdout": "x"}}
        with serve_hook_broker(base_dir=self.tools, workspace_root=self.workspace, request_id="AIR-j",
                               turn_budget=None) as broker:
            journaled = call_hook(str(broker.socket_path), "post-tool", post)
            session = call_hook(str(broker.socket_path), "session",
                                {"session_id": "sess-9", "hook_event_name": "SessionStart"})
        self.assertEqual(journaled, (EXIT_ALLOW, ""))
        rows = journal_rows_for("AIR-j", base_dir=self.tools)
        self.assertEqual([row["command_family"] for row in rows], ["git_read"])
        self.assertEqual(rows[0]["argv_redacted"], ["git", "diff", "--stat"])
        self.assertEqual(session[0], EXIT_ALLOW)
        self.assertEqual(json.loads(session[1])["aria_session"]["trigger"], "session_start")
        self.assertEqual([row["trigger"] for row in list_handoffs(base_dir=self.tools)], ["session_start"])

    def test_an_unknown_verb_or_an_oversized_request_is_a_deny(self) -> None:
        with serve_hook_broker(base_dir=self.tools, workspace_root=self.workspace, request_id="AIR-x",
                               turn_budget=None) as broker:
            unknown = call_hook(str(broker.socket_path), "reboot", {})
            self.assertEqual(unknown[0], EXIT_BLOCK)
            self.assertIn("hook_broker_error:ValueError", unknown[1])
            with mock.patch.object(hb, "MAX_REQUEST_BYTES", 64):
                oversized = call_hook(str(broker.socket_path), "pre-tool", _payload("Bash", command="x" * 200))
        self.assertEqual(oversized[0], EXIT_BLOCK)
        self.assertIn("hook_broker_error:ValueError", oversized[1])


class ClientCommand(_Store):
    def test_the_settings_compile_the_client_by_path_with_nothing_but_the_verb(self) -> None:
        from aria_kernel.runtime_profiles import profile_by_id

        context = {"python": "/usr/bin/python3", "kernel_root": str(self.workspace / "aria-kernel"),
                   "tools_dir": str(self.tools), "workspace_root": str(self.workspace), "request_id": "AIR-1"}
        settings = build_settings(profile_by_id("implementer"), hook_context=context)
        command = settings["hooks"]["PreToolUse"][0]["hooks"][0]["command"]
        self.assertEqual(command, f"/usr/bin/python3 {self.workspace / 'aria-kernel' / 'aria_kernel' / 'hook_client.py'} pre-tool")
        for forbidden in ("--tools-dir", str(self.tools), "--request-id", "AIR-1", "--turn-budget", "-m aria_kernel"):
            self.assertNotIn(forbidden, command)
        self.assertEqual(settings["_aria"]["turn_budget"], 60, "the cap stays in the document for the broker")
        self.assertEqual(hook_client_path(_KERNEL_ROOT), _KERNEL_ROOT / "aria_kernel" / "hook_client.py")
        with self.assertRaises(ValueError):
            hook_command(python="python3", kernel_root=_KERNEL_ROOT, verb="reboot")

    def test_the_client_imports_only_the_standard_library_and_stays_below_the_hook_timeout(self) -> None:
        import ast

        source = (_KERNEL_ROOT / "aria_kernel" / "hook_client.py").read_text(encoding="utf-8")
        modules = {
            (node.names[0].name if isinstance(node, ast.Import) else node.module or "").split(".")[0]
            for node in ast.walk(ast.parse(source)) if isinstance(node, (ast.Import, ast.ImportFrom))
        }
        self.assertEqual(modules, {"__future__", "json", "os", "socket", "sys"})
        self.assertLess(hc.CLIENT_TIMEOUT_SECONDS, HOOK_TIMEOUT_SECONDS)

    def test_the_client_subprocess_talks_to_the_broker_end_to_end(self) -> None:
        client = self.workspace / "aria-kernel" / "aria_kernel" / "hook_client.py"
        shutil.copy(hook_client_path(_KERNEL_ROOT), client)
        command = hook_command(python=sys.executable, kernel_root=self.workspace / "aria-kernel", verb="pre-tool")
        with serve_hook_broker(base_dir=self.tools, workspace_root=self.workspace, request_id="AIR-e2e",
                               turn_budget=None) as broker:
            env = {"PATH": os.environ.get("PATH", ""), HOOK_BROKER_SOCKET_ENV: str(broker.socket_path)}
            denied = subprocess.run(["sh", "-c", command], input=json.dumps(_payload("Bash", command="rm -rf /")),
                                    capture_output=True, text=True, env=env, timeout=30)
            allowed = subprocess.run(["sh", "-c", command], input=json.dumps(_payload("Bash", command="git status")),
                                     capture_output=True, text=True, env=env, timeout=30)
        self.assertEqual(denied.returncode, EXIT_BLOCK, denied.stderr)
        self.assertEqual(json.loads(denied.stdout)["hookSpecificOutput"]["permissionDecision"], "deny")
        self.assertEqual(allowed.returncode, EXIT_ALLOW, allowed.stderr)
        self.assertEqual(json.loads(allowed.stdout)["hookSpecificOutput"]["permissionDecision"], "allow")
        self.assertEqual([row["decision"] for row in self._decisions()], ["deny", "allow"])
        self.assertEqual({row["request_id"] for row in self._decisions()}, {"AIR-e2e"})

    def test_a_missing_or_dead_socket_fails_closed_by_verb(self) -> None:
        def run(verb: str, environ: dict[str, str]) -> tuple[int, dict]:
            out = io.StringIO()
            code = hc.main([verb], stdin=io.StringIO(json.dumps(_payload("Bash", command="git status"))),
                           stdout=out, environ=environ)
            return code, json.loads(out.getvalue())

        code, body = run("pre-tool", {})
        self.assertEqual(code, EXIT_BLOCK)
        self.assertEqual(body["hookSpecificOutput"]["permissionDecision"], "deny")
        self.assertIn("hook_broker_unreachable:no_socket_in_environment", body["hookSpecificOutput"]["permissionDecisionReason"])
        code, body = run("pre-tool", {HOOK_BROKER_SOCKET_ENV: str(self.root / "dead.sock")})
        self.assertEqual(code, EXIT_BLOCK)
        self.assertIn("hook_broker_unreachable:FileNotFoundError", body["hookSpecificOutput"]["permissionDecisionReason"])
        code, body = run("post-tool", {})
        self.assertEqual((code, body), (EXIT_ALLOW, {"aria_journal": "unrecorded:hook_broker_unreachable:no_socket_in_environment"}))
        code, body = run("session", {})
        self.assertEqual((code, body["aria_session"]["status"]), (EXIT_ALLOW, "unrecorded:hook_broker_unreachable:no_socket_in_environment"))
        out = io.StringIO()
        self.assertEqual(hc.main(["reboot"], stdin=io.StringIO("{}"), stdout=out, environ={}), EXIT_BLOCK)
        self.assertIn("unknown hook verb", out.getvalue())
        # The deny the client prints on its own is the shape the kernel's
        # verdict prints, so the CLI reads one protocol.
        from aria_kernel.hooks import HookVerdict

        self.assertEqual(json.loads(hc._deny_stdout("why")), json.loads(HookVerdict("deny", "why", "Bash", EXIT_BLOCK).to_stdout()))


class SweepTests(_Store):
    def test_the_sweep_removes_a_dead_brokers_directory_and_leaves_a_live_one(self) -> None:
        temp_root = self.root / "temp"
        temp_root.mkdir()
        (temp_root / "aria-hb-dead0000").mkdir()
        (temp_root / "aria-hb-dead0000" / "sock").write_text("", encoding="utf-8")
        (temp_root / "aria-hb-test-fixture-root").mkdir()
        with mock.patch.object(tempfile, "tempdir", str(temp_root)):
            with serve_hook_broker(base_dir=self.tools, workspace_root=self.workspace, request_id="AIR-s",
                                   turn_budget=None) as broker:
                swept = prune_stale_hook_brokers(temp_root=temp_root)
                self.assertTrue(broker.socket_path.is_socket())
                self.assertEqual(call_hook(str(broker.socket_path), "pre-tool", _payload("Bash", command="git status"))[0],
                                 EXIT_ALLOW, "the live broker still answers after the sweep")
        self.assertEqual(swept["swept"], ["aria-hb-dead0000"])
        self.assertEqual(swept["live"], [broker.socket_path.parent.name])
        self.assertTrue((temp_root / "aria-hb-test-fixture-root").exists(), "not the sweep's to remove")
        self.assertEqual(prune_stale_hook_brokers(temp_root=temp_root)["swept"], [])


if __name__ == "__main__":
    unittest.main()
