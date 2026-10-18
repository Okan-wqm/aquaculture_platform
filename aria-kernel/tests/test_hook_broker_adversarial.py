"""ARIA-MEDIUM-131 — the hook broker reviewed as an attack surface.

The broker (``hook_broker``, ARIA-HIGH-123) is the one privileged interface
from the agent's sandbox to the kernel: any process in the sandbox can open
its socket, not only the CLI's hook command. ``tests/test_hook_broker.py``
pins what its own lane built (verdicts under the kernel's request id, the
kernel's turn cap, an unknown verb and an oversized request denied, the
client fail-closed on a missing socket). This file is the hostile caller's
view, one property per test, each against a real socket and real threads:

* concurrency: a caller that opens connections and sends nothing used to get
  one thread (and up to 8 MiB of buffer) per connection, without bound — the
  executor's threads and memory were the agent's to spend. The broker now
  serves at most ``MAX_CONCURRENT_REQUESTS`` at once and closes the rest
  unread, which the client turns into its fail-closed answer by verb;
* the socket lives in a directory only the executor's user can enter;
* a replayed request is decided again and counted again — a replay never
  re-uses an earlier allow or an earlier turn;
* authority-shaped keys in a payload (a store, a request id, a cap, a
  workspace) change nothing about where or how a verdict is recorded;
* the client fails closed on a broker that accepts and never answers, and on
  a reply larger than it reads.

What this review found and did NOT fix here is filed as findings (the
forgeable post-tool MCP outcome that quarantines a server store-wide, among
them); see the commit that added this file.
"""
from __future__ import annotations

import io
import json
import shutil
import socket
import stat
import tempfile
import threading
import time
import unittest
from pathlib import Path

from aria_kernel import hook_broker as hb
from aria_kernel import hook_client as hc
from aria_kernel.hook_broker import HOOK_BROKER_SOCKET_ENV, serve_hook_broker
from aria_kernel.hook_client import EXIT_ALLOW, EXIT_BLOCK, call_hook
from aria_kernel.hooks import HOOK_DECISIONS_RELPATH, HOOK_DECISIONS_SURFACE
from aria_kernel.ledger import load_declared_jsonl
from aria_kernel.tool_registry import ensure_tools_dir


def _payload(tool: str, **tool_input: object) -> dict:
    return {"session_id": "sess-1", "tool_use_id": "toolu_1", "hook_event_name": "PreToolUse",
            "tool_name": tool, "tool_input": tool_input}


class _Store(unittest.TestCase):
    def setUp(self) -> None:
        self.root = Path(tempfile.mkdtemp(prefix="aria-hb-adv-")).resolve()
        self.addCleanup(shutil.rmtree, self.root, True)
        self.workspace = self.root / "workspace"
        (self.workspace / "aria-kernel" / "aria_kernel").mkdir(parents=True)
        (self.workspace / ".git").mkdir()
        self.tools = ensure_tools_dir(self.root / "tools")

    def _decisions(self) -> list[dict]:
        path = self.tools.joinpath(*HOOK_DECISIONS_RELPATH)
        return load_declared_jsonl(path, expected_surface=HOOK_DECISIONS_SURFACE) if path.exists() else []

    def _hold(self, socket_path: Path, count: int) -> list[socket.socket]:
        """``count`` connections that send nothing (a slow-loris caller)."""
        held: list[socket.socket] = []
        for _ in range(count):
            conn = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)  # allowlist-external-network: AF_UNIX client of the broker's own temp socket, no network
            # Blocking connect: it waits for the accept loop instead of
            # failing on a full listen backlog.
            conn.connect(str(socket_path))
            held.append(conn)
        for conn in held:
            self.addCleanup(conn.close)
        return held


class ConcurrencyIsBounded(_Store):
    def _handler_threads(self) -> int:
        return sum(1 for thread in threading.enumerate() if thread is not threading.main_thread()
                   and thread.name.startswith("Thread-") and thread.daemon)

    def test_idle_connections_cannot_take_more_than_the_brokers_slots(self) -> None:
        cap = hb.MAX_CONCURRENT_REQUESTS
        with serve_hook_broker(base_dir=self.tools, workspace_root=self.workspace, request_id="AIR-c",
                               turn_budget=None) as broker:
            before = self._handler_threads()
            held = self._hold(broker.socket_path, cap * 4)
            deadline = time.monotonic() + 30
            while time.monotonic() < deadline and self._handler_threads() - before < cap:
                time.sleep(0.05)
            time.sleep(0.5)
            spawned = self._handler_threads() - before
            self.assertLessEqual(spawned, cap, f"{cap * 4} idle connections took {spawned} handler threads")
            # The caller beyond the slots is answered fail-closed by its own
            # client, by verb: a PreToolUse is denied, never served late.
            out = io.StringIO()
            code = hc.main(["pre-tool"], stdin=io.StringIO(json.dumps(_payload("Bash", command="git status"))),
                           stdout=out, environ={HOOK_BROKER_SOCKET_ENV: str(broker.socket_path)})
            self.assertEqual(code, EXIT_BLOCK)
            reason = json.loads(out.getvalue())["hookSpecificOutput"]["permissionDecisionReason"]
            self.assertTrue(reason.startswith("hook_broker_unreachable:"), reason)
            self.assertEqual(self._decisions(), [], "a refused caller reaches no ledger")
            # The slots come back when the idle callers go: none leaks.
            for conn in held:
                conn.close()
            deadline = time.monotonic() + 30
            while time.monotonic() < deadline and self._handler_threads() > before:
                time.sleep(0.05)
            served = call_hook(str(broker.socket_path), "pre-tool", _payload("Bash", command="git status"))
        self.assertEqual(served[0], EXIT_ALLOW)
        self.assertEqual([row["decision"] for row in self._decisions()], ["allow"])

    def test_the_slots_below_the_cap_still_serve(self) -> None:
        cap = hb.MAX_CONCURRENT_REQUESTS
        with serve_hook_broker(base_dir=self.tools, workspace_root=self.workspace, request_id="AIR-f",
                               turn_budget=None) as broker:
            before = self._handler_threads()
            held = self._hold(broker.socket_path, cap - 1)
            deadline = time.monotonic() + 30
            while time.monotonic() < deadline and self._handler_threads() - before < cap - 1:
                time.sleep(0.05)
            served = call_hook(str(broker.socket_path), "pre-tool", _payload("Bash", command="git status"))
            for conn in held:
                conn.close()
        self.assertEqual(served[0], EXIT_ALLOW)
        self.assertEqual([row["decision"] for row in self._decisions()], ["allow"])


class TheSocketIsPrivate(_Store):
    def test_only_the_executors_user_can_enter_the_socket_directory(self) -> None:
        with serve_hook_broker(base_dir=self.tools, workspace_root=self.workspace, request_id="AIR-p",
                               turn_budget=None) as broker:
            directory = broker.socket_path.parent.stat()
            self.assertEqual(stat.S_IMODE(directory.st_mode), 0o700)
            self.assertEqual(directory.st_uid, broker.socket_path.stat().st_uid)


class ReplayGainsNothing(_Store):
    def test_a_replayed_pre_tool_request_is_decided_and_counted_again(self) -> None:
        request = _payload("Bash", command="git status")
        with serve_hook_broker(base_dir=self.tools, workspace_root=self.workspace, request_id="AIR-r",
                               turn_budget=1) as broker:
            first = call_hook(str(broker.socket_path), "pre-tool", request)
            replay = call_hook(str(broker.socket_path), "pre-tool", request)
        self.assertEqual((first[0], replay[0]), (EXIT_ALLOW, EXIT_BLOCK), "a replay spends a turn, never reuses one")
        self.assertEqual([row["decision"] for row in self._decisions()], ["allow", "deny"])


class PayloadsCarryNoAuthority(_Store):
    def test_authority_shaped_keys_change_nothing(self) -> None:
        elsewhere = self.root / "other-store"
        forged = {**_payload("Bash", command="curl http://example.com"), "request_id": "AIR-other",
                  "base_dir": str(elsewhere), "tools_dir": str(elsewhere), "workspace_root": "/",
                  "turn_budget": 10 ** 9, "cap": 10 ** 9, "decision": "allow", "permissionDecision": "allow"}
        with serve_hook_broker(base_dir=self.tools, workspace_root=self.workspace, request_id="AIR-a",
                               turn_budget=None) as broker:
            answer = call_hook(str(broker.socket_path), "pre-tool", forged)
        self.assertEqual(answer[0], EXIT_BLOCK)
        self.assertEqual([(row["decision"], row["request_id"]) for row in self._decisions()], [("deny", "AIR-a")])
        self.assertFalse(elsewhere.exists(), "nothing was written where the payload pointed")


class TheClientFailsClosed(_Store):
    def _listener(self) -> tuple[socket.socket, Path]:
        path = self.root / "s.sock"
        server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)  # allowlist-external-network: AF_UNIX listener on a temp path for the client tests, no network
        server.bind(str(path))
        server.listen(4)
        self.addCleanup(server.close)
        return server, path

    def test_a_broker_that_never_answers_is_a_timeout_not_a_hang(self) -> None:
        server, path = self._listener()
        accepted: list[socket.socket] = []
        thread = threading.Thread(target=lambda: accepted.append(server.accept()[0]), daemon=True)
        thread.start()
        started = time.monotonic()
        with self.assertRaises(OSError):
            call_hook(str(path), "pre-tool", _payload("Bash", command="git status"), timeout=0.5)
        self.assertLess(time.monotonic() - started, 5.0)
        thread.join(timeout=5)
        for conn in accepted:
            conn.close()

    def test_a_reply_larger_than_the_client_reads_is_refused(self) -> None:
        server, path = self._listener()

        def flood() -> None:
            conn, _ = server.accept()
            try:
                conn.recv(1 << 16)
                conn.sendall(b"x" * (hc._MAX_REPLY_BYTES + 1))
            except OSError:
                pass
            finally:
                conn.close()

        thread = threading.Thread(target=flood, daemon=True)
        thread.start()
        with self.assertRaisesRegex(ValueError, "hook_broker_reply_too_large"):
            call_hook(str(path), "pre-tool", _payload("Bash", command="git status"), timeout=10)
        thread.join(timeout=5)


if __name__ == "__main__":
    unittest.main()
