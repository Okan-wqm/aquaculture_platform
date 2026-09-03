"""Plan 032 Faz 032g — MCP: kernel-owned registry, strict per-spawn config, call ledger, quarantine, own server.

Invariants:
  I-V12-MCP-01  the registry is closed-shape and refuses secret-shaped env names,
                non-https http servers and unknown keys; profiles name servers with
                `mcp_servers` (optional, validated) and the shipped grant is exactly
                planner / planner_orchestrator / implementer / validator.
  I-V12-MCP-02  the per-spawn config carries ONLY the profile's servers (minus
                quarantined); a profile-less spawn gets an empty document; the argv
                ALWAYS carries --strict-mcp-config + --mcp-config, so the repository's
                .mcp.json never reaches an autonomous agent; unnamed servers are also
                closed as `mcp__<server>` in --disallowedTools; excluded write tools
                are closed by name.
  I-V12-MCP-03  the PostToolUse hook journals `mcp__*` calls (server + tool + input
                hash, never arguments) and feeds mcp/tool-calls.jsonl; ≥10 calls with
                error rate ≥ 0.5 quarantine the server (governance row); release needs
                an operator ref.
  I-V12-MCP-04  `aria-kernel mcp serve` speaks newline JSON-RPC (initialize,
                tools/list, tools/call, ping, unknown method → -32601); read tools
                answer from the store; write tools are absent without --allow-writes
                and need an approval ref with it; every call is a server-side ledger
                row; a tool exception is an isError result, never a dead server.
  I-V12-MCP-05  the CLI floor is 2.1.221 everywhere it is pinned; .mcp.json exposes
                the same server to humans; the CLI exposes mcp serve/registry/health/
                release/config.

NOT RUN at authoring time (operator instruction 2026-09-03).
"""
from __future__ import annotations

import io
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from tests.invariants.v12 import _helpers  # noqa: F401 — sys.path

from aria_kernel import hooks, mcp_client as mc
from aria_kernel.mcp_server import READ_TOOLS, WRITE_TOOLS, AriaMcpServer
from aria_kernel.runtime_profiles import load_runtime_profiles, profile_by_id
from aria_kernel.tool_registry import GovernanceError, ensure_tools_dir

_REPO_ROOT = Path(__file__).resolve().parents[4]
_POC = _REPO_ROOT / "tools" / "aria-poc"
if str(_POC) not in sys.path:
    sys.path.insert(0, str(_POC))


class _Store(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.root = Path(self._tmp.name)
        self.ws = self.root / "repo"
        self.ws.mkdir()
        subprocess.run(["git", "init", "-q", str(self.ws)], check=True)
        self.tools = ensure_tools_dir(self.root / "aria-tools")

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def _registry(self, servers: dict) -> mc.McpRegistry:
        path = self.root / "reg.json"
        path.write_text(json.dumps({"schema_version": 1, "servers": servers}), encoding="utf-8")
        return mc.load_mcp_registry(path)


class RegistryAndProfiles(_Store):
    def test_I_V12_MCP_01_closed_registry_and_profile_grant(self) -> None:
        shipped = mc.load_mcp_registry()
        self.assertEqual(list(shipped.servers), ["aria"])
        self.assertIn("human_required_resolve", shipped.servers["aria"].exclude)
        self.assertFalse(shipped.servers["aria"].allows_tool("human_required_resolve"))
        self.assertTrue(shipped.servers["aria"].allows_tool("search"))
        good = {"transport": "stdio", "command": "python3", "args": [], "env_passthrough": ["PYTHONPATH"], "tools": {"include": ["*"]}}
        self.assertEqual(list(self._registry({"ok": good}).servers), ["ok"])
        for bad in (
            {**good, "env_passthrough": ["GH_TOKEN"]},
            {**good, "env_passthrough": ["lowercase"]},
            {**good, "surprise": 1},
            {**good, "transport": "websocket"},
            {"transport": "http", "url": "http://insecure"},
            {**good, "timeout_seconds": 0},
            {**good, "tools": {"allow": ["*"]}},
        ):
            with self.assertRaises(GovernanceError, msg=str(bad)):
                self._registry({"bad": bad})
        with self.assertRaises(GovernanceError):
            self._registry({"Bad Name": good})
        grants = {pid: p.mcp_servers for pid, p in load_runtime_profiles().items()}
        self.assertEqual({pid for pid, s in grants.items() if s}, {"planner", "planner_orchestrator", "implementer", "validator"})
        self.assertTrue(all(s in {(), ("aria",)} for s in grants.values()))


class SpawnConfigIsStrict(_Store):
    def test_I_V12_MCP_02_only_the_profile_servers_and_always_strict(self) -> None:
        impl = profile_by_id("implementer")
        cfg = mc.mcp_config_for_profile(impl, environ={"PYTHONPATH": "aria-kernel", "GH_TOKEN": "never"})
        self.assertEqual(list(cfg["mcpServers"]), ["aria"])
        self.assertEqual(cfg["mcpServers"]["aria"]["env"], {"PYTHONPATH": "aria-kernel"})
        self.assertNotIn("never", json.dumps(cfg))
        self.assertEqual(mc.mcp_config_for_profile(profile_by_id("judge_opus")), {"mcpServers": {}})
        self.assertEqual(mc.mcp_config_for_profile(None), {"mcpServers": {}})
        self.assertEqual(mc.mcp_tool_rules(profile_by_id("judge_opus")), ("mcp__aria",))
        self.assertEqual(set(mc.mcp_tool_rules(impl)), {"mcp__aria__human_required_resolve", "mcp__aria__runtime_signal_ingest"})
        registry = self._registry({"aria": {"transport": "stdio", "command": "python3"}, "other": {"transport": "http", "url": "https://x"}})
        with self.assertRaises(GovernanceError):
            mc.mcp_config_for_profile(type("P", (), {"mcp_servers": ("nope",)})(), registry=registry)
        import claude_runtime

        argv = claude_runtime.build_claude_exec_argv(model="opus", mcp_config_path="/tmp/m.json", strict_mcp_config=True)
        self.assertIn("--strict-mcp-config", argv)
        self.assertEqual(argv[argv.index("--mcp-config") + 1], "/tmp/m.json")
        source = (_POC / "claude_runtime.py").read_text(encoding="utf-8")
        self.assertIn('argv.extend(["--strict-mcp-config", "--mcp-config", str(mcp_config_path)])', source)
        disallowed, _scope, _env = claude_runtime._envelope_from_profile(profile_by_id("worker"))
        self.assertIn("mcp__aria", disallowed)
        path = mc.write_mcp_config_file({"mcpServers": {}}, directory=self.root / "cfg")
        self.assertEqual(oct(path.stat().st_mode & 0o777), "0o600")
        self.assertEqual(json.loads(path.read_text(encoding="utf-8")), {"mcpServers": {}})


class CallsAreLedgeredAndQuarantined(_Store):
    def test_I_V12_MCP_03_journal_health_quarantine_release(self) -> None:
        payload = {"session_id": "s", "tool_use_id": "t", "tool_name": "mcp__aria__search",
                   "tool_input": {"query": "ghp_" + "A" * 40}, "tool_response": {"is_error": False}}
        code, _ = hooks.run_hook("post-tool", payload, base_dir=self.tools, workspace_root=self.ws, request_id="AIR-1")
        self.assertEqual(code, 0)
        journal = hooks.journal_rows_for("AIR-1", base_dir=self.tools)
        self.assertEqual((journal[0]["command_family"], journal[0]["mcp_server"], journal[0]["mcp_tool"]), ("mcp", "aria", "search"))
        self.assertNotIn("ghp_", json.dumps(journal), "arguments never enter the journal")
        self.assertTrue(journal[0]["input_hash"].startswith("sha256:"))
        self.assertEqual(mc.evaluate_mcp_health("aria", base_dir=self.tools)["calls"], 1)
        for i in range(11):
            hooks.run_hook("post-tool", {**payload, "tool_use_id": f"t{i}", "tool_response": {"is_error": True}},
                           base_dir=self.tools, workspace_root=self.ws, request_id="AIR-1")
        health = mc.evaluate_mcp_health("aria", base_dir=self.tools)
        self.assertTrue(health["quarantined"])
        self.assertGreaterEqual(health["error_rate"], mc.QUARANTINE_ERROR_RATE)
        self.assertIn(mc.MCP_QUARANTINED_EVENT, (self.tools / "governance.jsonl").read_text(encoding="utf-8"))
        self.assertEqual(mc.mcp_config_for_profile(profile_by_id("implementer"), base_dir=self.tools), {"mcpServers": {}}, "quarantined servers drop out of every spawn")
        with self.assertRaises(ValueError):
            mc.release_quarantine("aria", base_dir=self.tools, operator_ref="")
        mc.release_quarantine("aria", base_dir=self.tools, operator_ref="op-1")
        self.assertFalse(mc.evaluate_mcp_health("aria", base_dir=self.tools)["quarantined"])
        self.assertEqual(mc.split_mcp_tool("Bash"), None)
        self.assertEqual(mc.split_mcp_tool("mcp__aria"), ("aria", "*"))


class ServerSpeaksTheProtocol(_Store):
    def _roundtrip(self, server: AriaMcpServer, messages: list[dict]) -> list[dict]:
        out = io.StringIO()
        server.serve(io.StringIO("\n".join(json.dumps(m) for m in messages) + "\n"), out)
        return [json.loads(line) for line in out.getvalue().splitlines()]

    def test_I_V12_MCP_04_read_tools_write_gate_errors(self) -> None:
        server = AriaMcpServer(base_dir=self.tools, workspace_root=self.ws)
        responses = self._roundtrip(server, [
            {"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"protocolVersion": "2024-11-05"}},
            {"jsonrpc": "2.0", "method": "notifications/initialized"},
            {"jsonrpc": "2.0", "id": 2, "method": "tools/list"},
            {"jsonrpc": "2.0", "id": 3, "method": "tools/call", "params": {"name": "delivery_status", "arguments": {}}},
            {"jsonrpc": "2.0", "id": 4, "method": "tools/call", "params": {"name": "human_required_resolve", "arguments": {"request_id": "x", "resolution_note": "n", "operator_approval_ref": "abcdef"}}},
            {"jsonrpc": "2.0", "id": 5, "method": "tools/call", "params": {"name": "handoff_read", "arguments": {}}},
            {"jsonrpc": "2.0", "id": 6, "method": "nope"},
            {"jsonrpc": "2.0", "id": 7, "method": "ping"},
        ])
        by_id = {r["id"]: r for r in responses}
        self.assertEqual(by_id[1]["result"]["serverInfo"]["name"], "aria")
        self.assertTrue(server.initialized)
        names = [t["name"] for t in by_id[2]["result"]["tools"]]
        self.assertEqual(names, list(READ_TOOLS), "write tools absent without --allow-writes")
        self.assertFalse(by_id[3]["result"]["isError"])
        self.assertIn("verified_prs", json.loads(by_id[3]["result"]["content"][0]["text"]))
        self.assertTrue(by_id[4]["result"]["isError"])
        self.assertTrue(by_id[5]["result"]["isError"], "a tool exception is an error result")
        self.assertEqual(by_id[6]["error"]["code"], -32601)
        self.assertEqual(by_id[7]["result"], {})
        calls = mc.load_declared_jsonl(self.tools.joinpath(*mc.TOOL_CALLS_RELPATH), expected_surface=mc.TOOL_CALLS_SURFACE)
        self.assertEqual([(c["side"], c["tool"], c["ok"]) for c in calls], [("server", "delivery_status", True), ("server", "human_required_resolve", False), ("server", "handoff_read", False)])
        writer = AriaMcpServer(base_dir=self.tools, workspace_root=self.ws, allow_writes=True)
        self.assertEqual([t["name"] for t in writer.tools()], list(READ_TOOLS + WRITE_TOOLS))
        refused = writer.call_tool("runtime_signal_ingest", {"source": "operator", "service": "svc", "summary": "s", "code_refs": ["a.py"], "operator_approval_ref": "x"})
        self.assertTrue(refused["isError"], "short approval ref refused")
        done = writer.call_tool("runtime_signal_ingest", {"source": "operator", "service": "svc", "summary": "s", "code_refs": ["a.py"], "operator_approval_ref": "approve-123"})
        self.assertFalse(done["isError"], done)
        self.assertIn("mcp_write_tool_used", (self.tools / "governance.jsonl").read_text(encoding="utf-8"))
        proc = subprocess.run([sys.executable, "-m", "aria_kernel", "mcp", "serve", "--workspace-root", str(self.ws), "--tools-dir", str(self.tools)],
                              input=json.dumps({"jsonrpc": "2.0", "id": 1, "method": "tools/list"}) + "\n", capture_output=True, text=True, timeout=60,
                              env={**os.environ, "PYTHONPATH": str(_REPO_ROOT / "aria-kernel")})
        self.assertEqual(proc.returncode, 0, proc.stderr[-300:])
        self.assertEqual(json.loads(proc.stdout.splitlines()[0])["id"], 1)


class FloorAndSurfaces(_Store):
    def test_I_V12_MCP_05_floor_mcp_json_cli(self) -> None:
        from aria_kernel.doctor import CLAUDE_CLI_VERSION_FLOOR

        self.assertEqual(CLAUDE_CLI_VERSION_FLOOR, "2.1.221")
        for rel in (".github/workflows/aria-agent-executor.yml", ".github/workflows/aria-auto-cycle.yml", "scripts/aria/provision_runner.sh",
                    "tools/aria-poc/ci_executor_contract_proven.md"):
            text = (_REPO_ROOT / rel).read_text(encoding="utf-8")
            self.assertIn("2.1.221", text, rel)
            self.assertNotIn("2.1.197", text, rel)
        mcp_json = json.loads((_REPO_ROOT / ".mcp.json").read_text(encoding="utf-8"))
        self.assertEqual(mcp_json["mcpServers"]["aria"]["args"][:4], ["-m", "aria_kernel", "mcp", "serve"])
        from aria_kernel.cli import build_parser

        parser = build_parser()
        self.assertTrue(parser.parse_args(["mcp", "serve", "--allow-writes"]).allow_writes)
        self.assertEqual(parser.parse_args(["mcp", "release", "--server", "aria", "--operator-ref", "r"]).server, "aria")
        self.assertEqual(parser.parse_args(["mcp", "config", "--profile", "implementer"]).profile, "implementer")


if __name__ == "__main__":
    unittest.main()
