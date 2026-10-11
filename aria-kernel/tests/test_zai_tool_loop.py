"""ARIA-HIGH-434 — the Z.ai write runtime decides with the Claude writer's gate and acts in its room.

Operator decision 2026-10-10/11: while the Claude quota window is spent, the
write seats (the implementer, the worker lane) move to Z.ai too. The 2026-09-11
policy forbids handing the Z.ai key to the claude CLI, so the kernel runs its
own function-calling loop (`tools/aria-poc/zai_tool_loop.py`). What makes that
safe is that it adds no policy of its own: every call is decided by the
function the hook broker runs for the CLI, and executed in the room the CLI's
tools run in.

Everything here is real except the vendor — a local HTTP server standing in
for api.z.ai, reached through `zai_runtime`'s own urllib transport: the bwrap
room (skipped on a host whose bwrap cannot build it), the kernel's hooks and
ledgers, the git checkout, the store binding. One property per test:

* an Edit the gate admits lands in the workspace, from inside the room, and is
  journaled and counted as the CLI's would be;
* golden parity: for a fixed set of payloads (an allowed Edit, a denied
  `curl`, a Write under `.github/`, a Write outside the workspace, the turn
  past the cap) the loop's decision and reason are exactly what
  `hooks.run_hook` answers for the Claude CLI's payload on an identical store,
  row for row; a `.env` Read is refused by the settings document's own rule
  (the CLI's PreToolUse matcher never sends a Read to the hook);
* a refused call writes nothing; the room itself refuses a write under a
  READONLY path even when asked directly (EROFS, the OS layer);
* the transcript is Claude stream-json the existing readers read, and the
  usage is the sum of every turn's;
* the Z.ai key is in no room: not its environment, not its argv, under no bind
  source, not readable from inside, not in the transcript or the store;
* the kernel's MCP view answers `plan_verify` in-process (the implementer
  contract's first step), and a non-kernel MCP server is refused by name;
* a quota refusal mid-loop ends it with the transport's own classification;
  the completion cap ends a loop that never answers.
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch

_REPO_ROOT = Path(__file__).resolve().parents[2]
_POC_DIR = _REPO_ROOT / "tools" / "aria-poc"
_KERNEL_DIR = _REPO_ROOT / "aria-kernel"
for _path in (_POC_DIR, _KERNEL_DIR):
    if str(_path) not in sys.path:
        sys.path.insert(0, str(_path))

from aria_kernel.agent_runtime_profile import read_agent_runtime_profile  # noqa: E402
from aria_kernel.hooks import HOOK_DECISIONS_RELPATH, WORK_JOURNAL_RELPATH, run_hook  # noqa: E402
from aria_kernel.ledger import load_declared_jsonl  # noqa: E402
from aria_kernel.tool_registry import ensure_tools_binding  # noqa: E402

from tests._helpers.git_fixtures import make_repo_with_initial_commit  # noqa: E402
from tests.test_ci_executor_native_zai import _Vendor  # noqa: E402

SECRET = "zai-loop-secret-4c1d0b7e-not-a-real-key"
SOURCE = "apps/farm-service/src/sample-interval.ts"


def _turn(calls: list[tuple[str, str, dict]], *, rid: str, content: str = "") -> dict:
    return {"id": rid, "model": "glm-5.3", "choices": [{"index": 0, "finish_reason": "tool_calls", "message": {
        "role": "assistant", "content": content,
        "tool_calls": [{"id": call_id, "type": "function", "function": {"name": name, "arguments": json.dumps(args)}}
                       for call_id, name, args in calls]}}],
        "usage": {"prompt_tokens": 100, "completion_tokens": 10}}


def _final(content: str, *, rid: str) -> dict:
    return {"id": rid, "model": "glm-5.3", "choices": [{"index": 0, "finish_reason": "stop", "message": {
        "role": "assistant", "content": content}}], "usage": {"prompt_tokens": 120, "completion_tokens": 30}}


class _LoopFixture(unittest.TestCase):
    """A git checkout bound to its store, a key file at its 0600 boundary
    OUTSIDE the checkout, and a scripted vendor."""

    def setUp(self) -> None:
        from aria_kernel.implementation_safety import sandbox_backend

        if sandbox_backend() is None:
            self.skipTest("bwrap is not usable on this host; the room cannot be built")
        scratch = tempfile.TemporaryDirectory(prefix="aria-434-loop-")
        self.addCleanup(scratch.cleanup)
        self.root = Path(scratch.name).resolve()
        self.repo = self._checkout("repo")
        self.tools = ensure_tools_binding(self.repo / "aria-tools", workspace_root=self.repo)
        secrets = self.root / "secrets"
        secrets.mkdir()
        self.key_file = secrets / "zai.key"
        self.key_file.write_text(SECRET + "\n", encoding="utf-8")
        self.key_file.chmod(0o600)
        self.vendor = _Vendor().start()
        self.addCleanup(self.vendor.stop)
        environment = {"ARIA_ZAI_API_KEY_FILE": str(self.key_file), "ARIA_ZAI_ENDPOINT": self.vendor.base_url}
        patcher = patch.dict(os.environ, environment)
        patcher.start()
        self.addCleanup(patcher.stop)
        os.environ.pop("ARIA_ZAI_API_KEY", None)
        os.environ.pop("ARIA_JOB_DEADLINE_EPOCH", None)

    def _checkout(self, name: str, *, turn_cap: int | None = None) -> Path:
        files = {
            ".gitignore": "aria-tools/\n",
            SOURCE: "export const sampleIntervalMs = 60000;\n",
            ".env": "FIXTURE_SECRET_SHAPE=not-a-secret\n",
            ".github/workflows/ci.yml": "name: ci\n",
        }
        if turn_cap is not None:
            files["aria-config/genesis_policy.json"] = json.dumps(
                {"implementer_turn_budget": {"budgeted_turns": turn_cap}}) + "\n"
        return make_repo_with_initial_commit(self.root, files, name=name)

    def _seat(self, *, repo: Path | None = None, tools: Path | None = None, request_id: str = "AIR-zai-loop-1"):
        from zai_tool_loop import RoomSeat

        return RoomSeat(
            agent_profile=read_agent_runtime_profile("aria-implementer", repo_root=_REPO_ROOT),
            workspace_root=repo or self.repo, tools_dir=tools or self.tools, request_id=request_id,
            role="implementation", target_agent="aria-implementer",
        )

    def _loop(self, seat=None, *, timeout_seconds: int = 120):
        from zai_runtime import prepare_zai_context
        from zai_tool_loop import run_zai_tool_loop

        context = prepare_zai_context(dict(os.environ))
        return run_zai_tool_loop(context, seat=seat or self._seat(), model="glm-5.3", effort="max",
                                 system="SYSTEM", user="USER", timeout_seconds=timeout_seconds)

    def _rows(self, tools: Path, relpath: tuple[str, ...], surface: str) -> list[dict]:
        path = tools.joinpath(*relpath)
        return load_declared_jsonl(path, expected_surface=surface) if path.exists() else []

    def _decisions(self, tools: Path | None = None) -> list[dict]:
        return self._rows(tools or self.tools, HOOK_DECISIONS_RELPATH, "hook_decisions")

    def _tool_results(self) -> dict[str, dict]:
        """What the model was told for each call id: the vendor saw it."""
        answers: dict[str, dict] = {}
        for request in self.vendor.received:
            for message in request["json"].get("messages", []):
                if message.get("role") == "tool":
                    answers[message["tool_call_id"]] = message
        return answers


class AnAdmittedEditLandsThroughTheRoom(_LoopFixture):
    def test_an_allowed_edit_lands_and_is_journaled_and_counted(self) -> None:
        self.vendor.script = [
            (200, _turn([("c1", "Read", {"file_path": SOURCE}),
                         ("c2", "Edit", {"file_path": str(self.repo / SOURCE), "old_string": "60000",
                                         "new_string": "30000"})], rid="r1")),
            (200, _final('{"status": "submitted"}', rid="r2")),
        ]
        result = self._loop()
        self.assertEqual((result.returncode, result.stop_reason, result.final_message),
                         (0, "completed", '{"status": "submitted"}'))
        self.assertEqual((self.repo / SOURCE).read_text(encoding="utf-8"), "export const sampleIntervalMs = 30000;\n")
        answers = self._tool_results()
        self.assertIn("60000", answers["c1"]["content"], "the Read ran in the room and returned the file")
        self.assertIn("has been updated", answers["c2"]["content"])
        edit_rows = [row for row in self._decisions() if row["tool_use_id"] == "c2"]
        self.assertEqual([(row["tool_name"], row["decision"], row["reason"]) for row in edit_rows],
                         [("Edit", "allow", "write_inside_workspace")])
        self.assertIn("turn_budget", edit_rows[0], "the turn was admitted against the cap, in the ledger's transaction")
        journal = self._rows(self.tools, WORK_JOURNAL_RELPATH, "agent_work_journal")
        self.assertEqual([(row["tool_use_id"], row["command_family"]) for row in journal],
                         [("c1", "file_read"), ("c2", "file_write")])
        self.assertEqual(len(self.vendor.received), 2)
        offered = sorted(tool["function"]["name"] for tool in self.vendor.received[0]["json"]["tools"])
        self.assertEqual([name for name in offered if not name.startswith("mcp__")],
                         ["Bash", "Edit", "Glob", "Grep", "Read", "Write"])
        self.assertIn("mcp__aria__plan_verify", offered)


# The golden set: each entry is a call the model makes and the payload the
# Claude CLI would send its PreToolUse hook for the same call.
_GOLDEN = (
    ("g-edit", "Edit", {"file_path": SOURCE, "old_string": "60000", "new_string": "45000"}),
    ("g-curl", "Bash", {"command": "curl https://example.com/x"}),
    ("g-github", "Write", {"file_path": ".github/workflows/ci.yml", "content": "name: pwned\n"}),
    ("g-escape", "Write", {"file_path": "../outside.txt", "content": "x\n"}),
    ("g-status", "Bash", {"command": "git status --porcelain"}),
    ("g-over-cap", "Bash", {"command": "git status"}),
)


class GoldenParityWithTheClaudeHook(_LoopFixture):
    """Parity proven, not asserted: the same payloads through `hooks.run_hook`
    on an identical store must yield the same decisions and reasons."""

    def setUp(self) -> None:
        super().setUp()
        self.repo = self._checkout("loop-repo", turn_cap=2)
        self.tools = ensure_tools_binding(self.repo / "aria-tools", workspace_root=self.repo)
        self.twin = self._checkout("cli-repo", turn_cap=2)
        self.twin_tools = ensure_tools_binding(self.twin / "aria-tools", workspace_root=self.twin)

    def _cli_answers(self) -> list[tuple[str, str]]:
        from aria_kernel.claude_settings import build_settings
        from aria_kernel.runtime_profiles import profile_by_id
        from claude_runtime import UsageRecording, _hook_context

        recording = UsageRecording(request_id="AIR-zai-loop-1", role="implementation",
                                   target_agent="aria-implementer", base_dir=self.twin_tools)
        settings = build_settings(profile_by_id("implementer"),
                                  hook_context=_hook_context(usage_recording=recording, workspace_root=self.twin))
        cap = settings["_aria"]["turn_budget"]
        self.assertEqual(cap, 2, "the document's cap is the workspace policy's")
        answers = []
        for call_id, name, arguments in _GOLDEN:
            exit_code, stdout = run_hook("pre-tool", {
                "session_id": "cli", "tool_use_id": call_id, "hook_event_name": "PreToolUse",
                "tool_name": name, "tool_input": arguments}, base_dir=self.twin_tools, workspace_root=self.twin,
                request_id="AIR-zai-loop-1", turn_budget=cap)
            output = json.loads(stdout)["hookSpecificOutput"]
            answers.append((output["permissionDecision"], output["permissionDecisionReason"]))
        return answers

    def test_every_golden_payload_gets_the_hooks_own_decision_and_reason(self) -> None:
        self.vendor.script = [
            (200, _turn([(call_id, name, args) for call_id, name, args in _GOLDEN]
                        + [("g-env", "Read", {"file_path": ".env"})], rid="r1")),
            (200, _final("done", rid="r2")),
        ]
        result = self._loop()
        self.assertEqual(result.returncode, 0)
        expected = self._cli_answers()
        loop_rows = {row["tool_use_id"]: row for row in self._decisions()}
        cli_rows = {row["tool_use_id"]: row for row in self._decisions(self.twin_tools)}
        answers = self._tool_results()
        # The two stores are twins at two paths: a reason that names its
        # workspace (a path escape) is compared with the path named alike.
        loop_ws, cli_ws = str(self.repo), str(self.twin)
        expected = [(decision, reason.replace(cli_ws, loop_ws)) for decision, reason in expected]
        for (call_id, _name, _args), (decision, reason) in zip(_GOLDEN, expected):
            with self.subTest(call=call_id):
                self.assertEqual((loop_rows[call_id]["decision"], loop_rows[call_id]["reason"]), (decision, reason))
                # The row's own clock, session and chain hashes differ by
                # construction; every other field is the hook's.
                volatile = ("recorded_at", "session_id", "turn_budget", "ledger_hash", "previous_ledger_hash")
                strip = lambda row, ws: {k: (v.replace(ws, "<ws>") if isinstance(v, str) else v)  # noqa: E731
                                         for k, v in row.items() if k not in volatile}
                self.assertEqual(strip(loop_rows[call_id], loop_ws), strip(cli_rows[call_id], cli_ws),
                                 "the same row, field for field")
                self.assertEqual(loop_rows[call_id].get("turn_budget", {}).get("cap"),
                                 cli_rows[call_id].get("turn_budget", {}).get("cap"))
                if decision == "deny":
                    self.assertEqual(answers[call_id]["content"], reason, "the model reads the hook's own reason")
        self.assertEqual([decision for decision, _ in expected], ["allow", "deny", "deny", "deny", "allow", "deny"])
        self.assertTrue(expected[1][1].startswith("command_policy_deny:"), expected[1])
        self.assertEqual(expected[2][1], "readonly_path:.github/")
        self.assertTrue(expected[3][1].startswith("path_escape:"), expected[3])
        self.assertTrue(expected[5][1].startswith("implementer_turn_budget_exhausted"), expected[5])
        # The `.env` Read: the CLI's PreToolUse matcher never sends a Read to
        # the hook; the settings document's rule refuses it, and nothing is
        # read or recorded as a hook verdict.
        self.assertEqual(answers["g-env"]["content"], "permission_rule_deny:Read(./.env)")
        self.assertNotIn("g-env", loop_rows)
        self.assertNotIn("not-a-secret", json.dumps(self.vendor.received))
        # Nothing a refusal named was written.
        self.assertEqual((self.repo / ".github/workflows/ci.yml").read_text(encoding="utf-8"), "name: ci\n")
        self.assertFalse((self.root / "outside.txt").exists())
        self.assertEqual((self.repo / SOURCE).read_text(encoding="utf-8"), "export const sampleIntervalMs = 45000;\n")
        self.assertEqual((result.tool_calls, result.refused_calls), (7, 5))


# ARIA-HIGH-443 — each first line is an allowed command; bash -c runs the rest.
_SMUGGLED_LINES = (
    ("n-env", "git status\nprintenv"),
    ("n-chmod", "git status\nchmod 777 apps"),
    ("n-push", "git status\ngit push origin HEAD"),
)


class ALineBreakIsACommandSeparator(_LoopFixture):
    """ARIA-HIGH-443 — the shared gate read `git status\\nprintenv` as one argv.

    `command_policy.argv_of` (shlex) turned the newline into whitespace, the
    operator detector never saw it, and the room's `bash -c` ran every line:
    the environment printed, `apps` went 0o777, a push ran (refused only by
    the missing remote). The same payload reached the Claude path's hook.
    """

    def test_the_room_refuses_each_smuggled_line_and_runs_none(self) -> None:
        apps_mode = (self.repo / "apps").stat().st_mode
        self.vendor.script = [
            (200, _turn([(call_id, "Bash", {"command": command}) for call_id, command in _SMUGGLED_LINES], rid="r1")),
            (200, _final("done", rid="r2")),
        ]
        result = self._loop()
        rows = {row["tool_use_id"]: row for row in self._decisions()}
        answers = self._tool_results()
        for call_id, _command in _SMUGGLED_LINES:
            with self.subTest(call=call_id):
                self.assertEqual(rows[call_id]["decision"], "deny")
                self.assertTrue(rows[call_id]["reason"].startswith("command_policy_deny:BashDenylistHit"),
                                rows[call_id]["reason"])
                self.assertEqual(answers[call_id]["content"], rows[call_id]["reason"])
        self.assertEqual((result.tool_calls, result.refused_calls), (3, 3))
        self.assertEqual((self.repo / "apps").stat().st_mode, apps_mode, "chmod never ran")
        self.assertNotIn("PATH=", json.dumps(self.vendor.received), "printenv never ran")

    def test_the_claude_hook_refuses_the_same_payloads(self) -> None:
        for call_id, command in _SMUGGLED_LINES:
            with self.subTest(call=call_id):
                exit_code, stdout = run_hook("pre-tool", {
                    "session_id": "cli", "tool_use_id": call_id, "hook_event_name": "PreToolUse",
                    "tool_name": "Bash", "tool_input": {"command": command}},
                    base_dir=self.tools, workspace_root=self.repo, request_id="AIR-zai-loop-1")
                output = json.loads(stdout)["hookSpecificOutput"]
                self.assertEqual(output["permissionDecision"], "deny", output)
                self.assertTrue(output["permissionDecisionReason"].startswith("command_policy_deny:BashDenylistHit"))


class TheRoomIsTheWritersRoom(_LoopFixture):
    def _room(self):
        from zai_tool_loop import _Room, room_policy

        seat = self._seat()
        room = _Room(seat, room_policy(seat))
        self.addCleanup(room.close)
        return room

    def test_the_os_refuses_a_readonly_write_even_without_the_gate(self) -> None:
        room = self._room()
        code, out, err, _interrupted, _ms = room.run(
            [room.interpreter, "-I", "-c",
             "import sys\ntry:\n    open(sys.argv[1], 'w').write('x')\n    print('written')\n"
             "except OSError as exc:\n    print(type(exc).__name__, exc.errno)", str(self.repo / ".github/workflows/ci.yml")],
            stdin="", timeout_seconds=30)
        self.assertEqual(code, 0, err)
        self.assertEqual(out.strip(), "OSError 30", "EROFS: READONLY_PATHS are read-only at the syscall level")
        self.assertEqual((self.repo / ".github/workflows/ci.yml").read_text(encoding="utf-8"), "name: ci\n")

    def test_the_key_is_in_no_room(self) -> None:
        room = self._room()
        probe = ("import json, os, socket, sys\n"
                 "def readable(p):\n    try:\n        open(p).read(); return True\n    except OSError:\n        return False\n"
                 "try:\n    socket.create_connection(('127.0.0.1', int(sys.argv[2])), timeout=2).close(); net = True\n"
                 "except OSError:\n    net = False\n"
                 "print(json.dumps({'env': sorted(os.environ), 'values': ' '.join(os.environ.values()),"
                 " 'key_readable': readable(sys.argv[1]), 'network': net}))")
        port = self.vendor.base_url.rsplit(":", 1)[1]
        argv = room.argv([room.interpreter, "-I", "-c", probe, str(self.key_file), port], timeout_seconds=30)
        self.assertNotIn(SECRET, " ".join(argv))
        code, out, err, _interrupted, _ms = room.run([room.interpreter, "-I", "-c", probe, str(self.key_file), port],
                                                     stdin="", timeout_seconds=30)
        self.assertEqual(code, 0, err)
        seen = json.loads(out)
        from aria_kernel.agent_env import SECRET_SHAPED_ENV_NAME

        self.assertEqual([name for name in seen["env"] if SECRET_SHAPED_ENV_NAME.search(name)], [])
        self.assertNotIn("ARIA_ZAI_API_KEY_FILE", seen["env"])
        self.assertFalse([name for name in seen["env"] if name.startswith(("CLAUDE_", "ANTHROPIC_"))])
        self.assertNotIn(SECRET, seen["values"])
        self.assertNotIn(str(self.key_file), seen["values"])
        self.assertFalse(seen["key_readable"], "the key file is under no bind source")
        self.assertFalse(seen["network"], "the room has no network: the vendor on loopback is unreachable")

    def test_a_room_that_would_bind_the_key_refuses_to_stand(self) -> None:
        from claude_runtime import ClaudePolicyViolation

        inside = self.repo / "keys" / "zai.key"
        inside.parent.mkdir()
        inside.write_text(SECRET + "\n", encoding="utf-8")
        inside.chmod(0o600)
        with patch.dict(os.environ, {"ARIA_ZAI_API_KEY_FILE": str(inside)}):
            room = self._room()
            with self.assertRaises(ClaudePolicyViolation) as refused:
                room.argv(["/bin/true"], timeout_seconds=10)
        self.assertIn("zai_room_binds_the_credential", str(refused.exception))

    def test_the_secret_reaches_no_transcript_and_no_ledger(self) -> None:
        self.vendor.script = [
            (200, _turn([("c1", "Bash", {"command": "git status --porcelain"})], rid="r1")),
            (200, _final("ok", rid="r2")),
        ]
        result = self._loop()
        self.assertEqual(result.returncode, 0)
        self.assertNotIn(SECRET.encode(), result.raw_body)
        for path in self.tools.rglob("*"):
            if path.is_file():
                self.assertNotIn(SECRET.encode(), path.read_bytes(), path)
        self.assertTrue(all(request["authorization"] == "Bearer " + SECRET for request in self.vendor.received),
                        "the key rides the Authorization header to the vendor and nowhere else")


class TheTranscriptAndTheUsage(_LoopFixture):
    def test_the_transcript_is_claude_stream_json_and_the_usage_is_summed(self) -> None:
        from claude_runtime import extract_final_message, extract_usage, parse_claude_jsonl

        self.vendor.script = [
            (200, _turn([("c1", "Glob", {"pattern": "apps/**/*.ts"})], rid="r1", content="looking")),
            (200, _turn([("c2", "Grep", {"pattern": "sampleIntervalMs", "output_mode": "content"})], rid="r2")),
            (200, _final('{"status": "submitted"}', rid="r3")),
        ]
        observed: list[dict] = []
        from zai_tool_loop import RoomSeat

        seat = self._seat()
        seat = RoomSeat(**{**seat.__dict__, "spawn_control": type("C", (), {
            "should_cancel": None, "on_event": staticmethod(observed.append)})()})
        result = self._loop(seat)
        events = parse_claude_jsonl(result.raw_body.decode("utf-8"))
        self.assertEqual(extract_final_message(events), '{"status": "submitted"}')
        self.assertEqual(extract_usage(events), {"input_tokens": 320, "output_tokens": 50})
        self.assertEqual(result.usage, {"input_tokens": 320, "output_tokens": 50})
        self.assertEqual([event["type"] for event in events],
                         ["system", "assistant", "user", "assistant", "user", "assistant", "result"])
        self.assertEqual(result.provider_session_ids, ("r1", "r2", "r3"))
        self.assertEqual(tuple(observed), events, "the progress observer saw every event as it landed")
        results = [block for event in events if event["type"] == "user" for block in event["message"]["content"]]
        self.assertIn(str(self.repo / SOURCE), results[0]["content"])
        self.assertIn(":1:export const sampleIntervalMs", results[1]["content"])

    def test_a_turn_without_usage_makes_the_whole_usage_unknown(self) -> None:
        bare = _final("ok", rid="r1")
        bare.pop("usage")
        self.vendor.script = [(200, bare)]
        self.assertIsNone(self._loop().usage, "unknown usage is never priced as zero")


class TheKernelsMcpView(_LoopFixture):
    def test_plan_verify_is_served_in_process_and_recorded(self) -> None:
        self.vendor.script = [
            (200, _turn([("m1", "mcp__aria__plan_verify", {"plan_id": "plan-x", "content_hash": "sha256:00"}),
                         ("m2", "mcp__aria__human_required_resolve", {"request_id": "x"})], rid="r1")),
            (200, _final("ok", rid="r2")),
        ]
        self.assertEqual(self._loop().returncode, 0)
        answers = self._tool_results()
        self.assertTrue(answers["m1"]["content"], "the kernel's server answered (an unknown plan is its error)")
        self.assertEqual(answers["m2"]["content"], "tool_not_offered:mcp__aria__human_required_resolve")
        calls = self._rows(self.tools, ("mcp", "tool-calls.jsonl"), "mcp_tool_calls")
        self.assertEqual([(row["server"], row["tool"], row["request_id"], row["side"]) for row in calls],
                         [("aria", "plan_verify", "AIR-zai-loop-1", "server")])

    def test_a_server_the_kernel_does_not_serve_is_refused_by_name(self) -> None:
        from aria_kernel.mcp_client import McpRegistry, McpServerSpec
        from claude_runtime import ClaudePolicyViolation

        stdio = McpServerSpec(name="aria", transport="stdio", command="x", args=(), url=None, env_passthrough=(),
                              include=("*",), exclude=(), timeout_seconds=30, manifest_version=1)
        with patch("aria_kernel.mcp_client.load_mcp_registry", return_value=McpRegistry(servers={"aria": stdio})):
            with self.assertRaises(ClaudePolicyViolation) as refused:
                self._loop()
        self.assertIn("zai_room_mcp_server_unsupported:aria", str(refused.exception))


class TheLoopEndsByName(_LoopFixture):
    def test_a_quota_refusal_mid_loop_carries_the_transports_classification(self) -> None:
        self.vendor.script = [
            (200, _turn([("c1", "Read", {"file_path": SOURCE})], rid="r1")),
            (429, {"error": {"code": "1113", "message": "insufficient balance"}}),
        ]
        result = self._loop()
        self.assertEqual((result.returncode, result.stop_reason), (1, "vendor_refused"))
        self.assertEqual(result.exhaustion_signature, "zai_quota_refusal")

    def test_the_completion_cap_ends_a_loop_that_never_answers(self) -> None:
        from zai_tool_loop import COMPLETIONS_PER_BUDGETED_TURN

        self.repo = self._checkout("capped", turn_cap=1)
        self.tools = ensure_tools_binding(self.repo / "aria-tools", workspace_root=self.repo)
        cap = COMPLETIONS_PER_BUDGETED_TURN * 1
        self.vendor.script = [(200, _turn([(f"c{n}", "Read", {"file_path": SOURCE})], rid=f"r{n}")) for n in range(cap + 3)]
        result = self._loop()
        self.assertEqual((result.returncode, result.stop_reason, result.completions), (1, "completion_cap", cap))
        self.assertEqual(len(self.vendor.received), cap)

    def test_a_cancel_stops_the_loop_at_its_next_boundary(self) -> None:
        from zai_tool_loop import RoomSeat

        self.vendor.script = [(200, _turn([("c1", "Read", {"file_path": SOURCE})], rid="r1"))] * 3
        asked: list[int] = []

        class Control:
            on_event = None
            cancelled = False
            cancel_signal = None

            @staticmethod
            def should_cancel() -> bool:
                asked.append(1)
                return len(asked) > 1

        control = Control()
        result = self._loop(RoomSeat(**{**self._seat().__dict__, "spawn_control": control}))
        self.assertEqual((result.stop_reason, control.cancelled, control.cancel_signal),
                         ("operator_cancelled", True, "sigterm"))
        self.assertEqual(len(self.vendor.received), 1)


class TheSpawnLaneRungIsTheLoop(_LoopFixture):
    """The legacy lane (no adaptive policy): a write-capable profile's zai
    rung runs the loop, and what the executor reads off the rung's result —
    the stream it writes as the transcript, the envelope it builds, the usage
    it records — reads the loop's turns."""

    def test_the_rung_returns_the_stream_and_the_envelope_reads_its_answer(self) -> None:
        import ci_executor
        from claude_runtime import UsageRecording, parse_claude_jsonl

        self.vendor.script = [
            (200, _turn([("s1", "Read", {"file_path": SOURCE})], rid="r1")),
            (200, _final('{"status": "submitted", "details": {"note": "read it"}}', rid="r2")),
        ]
        recording = UsageRecording(request_id="AIR-zai-loop-1", role="implementation",
                                   target_agent="aria-implementer", base_dir=self.tools)
        result = ci_executor._run_zai_as_claude_result(
            prompt_text="CONTRACT + REQUEST", model="glm-5.3", timeout_seconds=60, usage_recording=recording,
            effort="max", room=self._seat())
        self.assertEqual((result.returncode, result.model, result.failure_class), (0, "glm-5.3", None))
        self.assertEqual(parse_claude_jsonl(result.stdout), result.events)
        envelope = ci_executor._build_envelope_from_claude_output(
            raw_stdout=result.stdout, request_id="AIR-zai-loop-1", claim_id="CL-1", agent_id="ci-executor:x",
            role="implementation", subagent_type="aria-implementer", must_satisfy=[], dispatch_model=result.model,
            usage=result.usage)
        self.assertEqual(envelope["details"].get("note"), "read it")
        self.assertEqual(self.vendor.received[0]["json"]["messages"][1]["content"], "CONTRACT + REQUEST",
                         "the rendered request is the user turn, byte for byte")
        rows = [row for row in self._rows(self.tools, ("knowledge-graph", "context-usage.jsonl"), "context_usage")
                if row.get("request_id") == "AIR-zai-loop-1"]
        self.assertEqual([(row["model"], row["input_tokens"], row["output_tokens"]) for row in rows],
                         [("glm-5.3", 220, 40)])


class RoomOverhead(_LoopFixture):
    """Measured, recorded in the review file: what one room costs."""

    def test_one_room_per_call_costs_well_under_a_second(self) -> None:
        from zai_tool_loop import _Room, room_policy

        seat = self._seat()
        room = _Room(seat, room_policy(seat))
        self.addCleanup(room.close)
        samples = []
        for _ in range(5):
            started = time.monotonic()
            code, _out, err, _interrupted, _ms = room.run(["/bin/true"], stdin="", timeout_seconds=30)
            samples.append(time.monotonic() - started)
            self.assertEqual(code, 0, err)
        median = sorted(samples)[len(samples) // 2]
        sys.stderr.write(f"\nzai room per-call overhead: median {median * 1000:.0f} ms over {len(samples)}\n")
        self.assertLess(median, 2.0)


if __name__ == "__main__":
    unittest.main()
