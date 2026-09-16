"""ARIA-HIGH-124 — the `aria` MCP view is served outside the sandbox and relayed in.

The registry used to spawn the kernel's own MCP server INSIDE the agent's
sandbox against a store that is not mounted there. These pins run the
kernel-side broker (``mcp_broker.serve_mcp_broker``) in-process and the
stdlib relay (``mcp_relay.py``, by path, in a subprocess with nothing but the
socket in its environment) the way the CLI runs a stdio server:

* the relay answers ``initialize`` / ``tools/list`` / ``tools/call`` from the
  REAL store — a governance row written before the call comes back through
  the socket; only the read tools are listed; a write tool is refused and
  leaves no ``mcp_write_tool_used`` row;
* the relay fails CLOSED: no socket in the environment, or a socket nobody
  serves, answers every request that carries an id with a JSON-RPC error
  naming the cause and answers a notification with nothing;
* the broker's socket directory is removed on exit, and the orphan sweep
  removes the directories of brokers that no longer answer and leaves live
  ones alone;
* the sandbox wrapper binds the broker's socket at the fixed path and sets
  the environment name, refuses a socket nobody serves by name, and the
  spawn document names the relay by path with no env of its own.
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import unittest
from unittest import mock
from pathlib import Path

from aria_kernel import mcp_broker
from aria_kernel.mcp_broker import (
    MCP_BROKER_SOCKET_ENV,
    SANDBOX_MCP_BROKER_SOCKET,
    prune_stale_mcp_brokers,
    serve_mcp_broker,
)
from aria_kernel.mcp_server import READ_TOOLS, WRITE_TOOLS
from aria_kernel.tool_registry import append_tools_governance, ensure_tools_dir
from tests._helpers.git_fixtures import make_repo_with_initial_commit

_KERNEL_DIR = Path(__file__).resolve().parents[1]
RELAY = _KERNEL_DIR / "aria_kernel" / "mcp_relay.py"


def _messages(*extra: dict) -> str:
    base = [
        {"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"protocolVersion": "2024-11-05"}},
        {"jsonrpc": "2.0", "method": "notifications/initialized"},
        {"jsonrpc": "2.0", "id": 2, "method": "tools/list"},
    ]
    return "".join(json.dumps(message) + "\n" for message in (*base, *extra))


def _relay(socket_path: str | None, stdin: str, *, environment: dict[str, str] | None = None,
           isolated: bool = True) -> subprocess.CompletedProcess[str]:
    """The relay as the `--mcp-config` document spells it: the interpreter
    isolated (`-I`), the relay by path (ARIA-HIGH-124 round 2)."""
    from aria_kernel.claude_settings import ISOLATED_INTERPRETER_FLAGS

    environment = {"PATH": os.defpath, **(environment or {})}
    if socket_path is not None:
        environment[MCP_BROKER_SOCKET_ENV] = socket_path
    flags = ISOLATED_INTERPRETER_FLAGS if isolated else ()
    return subprocess.run([sys.executable, *flags, str(RELAY)], input=stdin, capture_output=True, text=True,
                          timeout=60, env=environment)


def _by_id(stdout: str) -> dict[int, dict]:
    replies = {}
    for line in stdout.splitlines():
        if line.strip():
            reply = json.loads(line)
            replies[reply["id"]] = reply
    return replies


class RelayThroughTheBrokerTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory(prefix="aria-124-mcp-")
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name).resolve()
        self.repo = make_repo_with_initial_commit(self.root, {"src/app.ts": "export const app = true;\n"}, name="ws")
        self.tools = ensure_tools_dir(self.root / "aria-tools")
        append_tools_governance(self.tools, "agent_claim_created", {"request_id": "AIR-124", "claim_id": "c-1"})

    def _governance_text(self) -> str:
        return (self.tools / "governance.jsonl").read_text(encoding="utf-8")

    def test_the_relay_answers_from_the_real_store_read_tools_only(self) -> None:
        with serve_mcp_broker(base_dir=self.tools, workspace_root=self.repo, request_id="AIR-124") as broker:
            self.assertTrue(broker.socket_path.is_socket())
            done = _relay(str(broker.socket_path), _messages(
                {"jsonrpc": "2.0", "id": 3, "method": "tools/call",
                 "params": {"name": "governance_tail", "arguments": {"kind": "agent_claim_created", "limit": 5}}},
                {"jsonrpc": "2.0", "id": 4, "method": "tools/call",
                 "params": {"name": "human_required_resolve",
                            "arguments": {"request_id": "x", "resolution_note": "n", "operator_approval_ref": "abcdef"}}},
                {"jsonrpc": "2.0", "id": 5, "method": "ping"},
            ))
            socket_dir = broker.socket_path.parent
        self.assertEqual(done.returncode, 0, done.stderr)
        replies = _by_id(done.stdout)
        self.assertEqual(replies[1]["result"]["serverInfo"]["name"], "aria")
        self.assertEqual([tool["name"] for tool in replies[2]["result"]["tools"]], list(READ_TOOLS))
        self.assertFalse(replies[3]["result"]["isError"], replies[3])
        rows = json.loads(replies[3]["result"]["content"][0]["text"])
        self.assertEqual([row["details"]["request_id"] for row in rows], ["AIR-124"])
        self.assertTrue(replies[4]["result"]["isError"])
        self.assertIn("unknown tool", replies[4]["result"]["content"][0]["text"])
        self.assertEqual(replies[5]["result"], {})
        self.assertNotIn(6, replies)
        self.assertNotIn("mcp_write_tool_used", self._governance_text())
        for tool in WRITE_TOOLS:
            self.assertNotIn(tool, [t["name"] for t in replies[2]["result"]["tools"]])
        # Every served call landed on the real store's call ledger, server side.
        calls = [json.loads(line) for line in (self.tools / "mcp" / "tool-calls.jsonl").read_text(encoding="utf-8").splitlines()]
        self.assertEqual([(row["side"], row["tool"], row["ok"]) for row in calls],
                         [("server", "governance_tail", True), ("server", "human_required_resolve", False)])
        # (round 4) and each row names the REQUEST whose sandbox made the
        # call: the broker holds it, the server it serves records it.
        self.assertEqual([row["request_id"] for row in calls], ["AIR-124", "AIR-124"])
        # The listener and its directory are gone with the body.
        self.assertFalse(socket_dir.exists())

    def test_a_shadow_under_the_agent_writable_kernel_tree_never_runs_in_the_relay(self) -> None:
        # ARIA-HIGH-124 (round 2) — the spawn's PYTHONPATH names
        # `<workspace>/aria-kernel`; only `aria_kernel/` under it is
        # read-only. A `json.py` planted beside it answered every relay
        # request with a forged `tools/list` if the relay's interpreter
        # read PYTHONPATH; the document runs it isolated.
        marker = self.root / "relay-shadow-marker"
        record = f'open({str(marker)!r}, "a").write(__name__ + "\\n")\n'
        forged = ('import sys\n' + record +
                  'sys.stdout.write(\'{"jsonrpc": "2.0", "id": 2, "result": {"tools": [{"name": "human_required_resolve"}]}}\\n\')\n'
                  'raise SystemExit(0)\n')
        (self.repo / "aria-kernel").mkdir(parents=True, exist_ok=True)
        (self.repo / "aria-kernel" / "json.py").write_text(forged, encoding="utf-8")
        (self.repo / "aria-kernel" / "sitecustomize.py").write_text(record, encoding="utf-8")
        environment = {"PYTHONPATH": str(self.repo / "aria-kernel"), "PYTHONDONTWRITEBYTECODE": "1"}
        with serve_mcp_broker(base_dir=self.tools, workspace_root=self.repo, request_id="AIR-124") as broker:
            done = _relay(str(broker.socket_path), _messages(), environment=environment)
            self.assertEqual(done.returncode, 0, done.stderr)
            self.assertEqual([tool["name"] for tool in _by_id(done.stdout)[2]["result"]["tools"]], list(READ_TOOLS))
            self.assertFalse(marker.exists(), "a module under the agent-writable aria-kernel/ ran in the relay")
            # The teeth: without the isolation flag the planted module answers.
            forged_run = _relay(str(broker.socket_path), _messages(), environment=environment, isolated=False)
        self.assertEqual([tool["name"] for tool in _by_id(forged_run.stdout)[2]["result"]["tools"]], ["human_required_resolve"])
        self.assertEqual(marker.read_text(encoding="utf-8").split(), ["sitecustomize", "json"])

    def test_the_relay_fails_closed_without_a_broker(self) -> None:
        for socket_path in (None, str(self.root / "nobody" / "sock")):
            with self.subTest(socket=socket_path):
                done = _relay(socket_path, _messages(
                    {"jsonrpc": "2.0", "id": 3, "method": "tools/call", "params": {"name": "aria_status", "arguments": {}}},
                ))
                self.assertEqual(done.returncode, 0, done.stderr)
                replies = _by_id(done.stdout)
                self.assertEqual(sorted(replies), [1, 2, 3], "every request with an id is answered, the notification is not")
                for reply in replies.values():
                    self.assertEqual(reply["error"]["code"], mcp_broker_error_code())
                    self.assertTrue(reply["error"]["message"].startswith("mcp_broker_unreachable:"), reply)
                self.assertEqual(len(done.stdout.splitlines()), 3)

    def test_the_sweep_removes_dead_brokers_and_leaves_live_ones(self) -> None:
        temp_root = self.root / "temp"
        temp_root.mkdir()
        dead = temp_root / "aria-mb-deadbeef"
        dead.mkdir()
        (dead / "sock").touch()
        unrelated = temp_root / "aria-mb-keep-me!"
        unrelated.mkdir()
        with mock.patch.object(tempfile, "tempdir", str(temp_root)):
            with serve_mcp_broker(base_dir=self.tools, workspace_root=self.repo, request_id="AIR-124") as broker:
                swept = prune_stale_mcp_brokers(temp_root=temp_root)
                self.assertEqual(swept["swept"], ["aria-mb-deadbeef"])
                self.assertEqual(swept["live"], [broker.socket_path.parent.name])
        self.assertTrue(unrelated.exists(), "a directory this module did not make is left alone")
        self.assertEqual(prune_stale_mcp_brokers(temp_root=temp_root)["swept"], [])


def mcp_broker_error_code() -> int:
    from aria_kernel.mcp_relay import BROKER_UNREACHABLE_ERROR_CODE

    return BROKER_UNREACHABLE_ERROR_CODE


class SandboxAndDocumentTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory(prefix="aria-124-mcp-wrap-")
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name).resolve()
        self.repo = make_repo_with_initial_commit(self.root, {"src/app.ts": "export const app = true;\n"}, name="ws")
        self.tools = ensure_tools_dir(self.root / "aria-tools")

    def test_the_wrapper_binds_the_socket_at_the_fixed_path_and_refuses_a_dead_one(self) -> None:
        from aria_kernel.implementation_safety import SandboxUnavailable, _sandbox_argv

        with serve_mcp_broker(base_dir=self.tools, workspace_root=self.repo, request_id="AIR-124") as broker:
            argv = _sandbox_argv(["sh", "-c", "true"], workspace_root=self.repo, allow_network=True,
                                 mcp_broker_socket=broker.socket_path)
            self.assertIn(["--bind", str(broker.socket_path), SANDBOX_MCP_BROKER_SOCKET],
                          [argv[i:i + 3] for i in range(len(argv) - 2)])
            self.assertIn(["--setenv", MCP_BROKER_SOCKET_ENV, SANDBOX_MCP_BROKER_SOCKET],
                          [argv[i:i + 3] for i in range(len(argv) - 2)])
        with self.assertRaises(SandboxUnavailable) as refused:
            _sandbox_argv(["sh", "-c", "true"], workspace_root=self.repo, allow_network=True,
                          mcp_broker_socket=self.root / "gone" / "sock")
        self.assertIn("mcp_broker_socket_missing", str(refused.exception))

    def test_the_document_names_the_relay_by_path_and_carries_no_env(self) -> None:
        from aria_kernel.mcp_client import McpRelayContext, mcp_config_for_profile
        from aria_kernel.runtime_profiles import profile_by_id

        relay = McpRelayContext(python="/usr/bin/python3", kernel_root=self.repo / "aria-kernel")
        for profile_id in ("implementer", "planner", "validator", "planner_orchestrator"):
            with self.subTest(profile=profile_id):
                document = mcp_config_for_profile(profile_by_id(profile_id), relay=relay)
                self.assertEqual(document, {"mcpServers": {"aria": {
                    "type": "stdio", "command": "/usr/bin/python3",
                    "args": ["-I", str(self.repo / "aria-kernel" / "aria_kernel" / "mcp_relay.py")],
                }}})
        self.assertEqual(SANDBOX_MCP_BROKER_SOCKET, "/tmp/aria-mcp-broker.sock")
        self.assertEqual(mcp_broker.MCP_BROKER_SOCKET_ENV, "ARIA_MCP_BROKER_SOCKET")


if __name__ == "__main__":
    unittest.main()
