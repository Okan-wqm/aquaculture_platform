"""ARIA-HIGH-123 — the kernel-side hook broker: the sandbox asks, the kernel decides.

WHY this module exists
----------------------
The Claude Code hooks are the seam where the kernel decides a tool call
(PreToolUse: command policy + turn budget), journals it (PostToolUse) and
takes handoff snapshots (session events) — see :mod:`hooks`. They used to
run INSIDE the agent's sandbox, so the store they journal into had to be
mounted there. The first cut of ARIA-HIGH-123 mounted it writable, which
handed the agent every kernel surface the store holds (the request queue,
claims, governance, the signer registry, operator control, adjudications,
cost ledgers and the turn count itself); unmounted, the hooks lost every row
to a phantom directory on bwrap's root tmpfs.

WHAT this module does
---------------------
It serves the hooks OUTSIDE the sandbox, in the executor process, on a unix
socket the wrapper binds into the sandbox at a fixed path
(``SANDBOX_HOOK_BROKER_SOCKET``). The in-sandbox command
(:mod:`hook_client`, stdlib only, run by path) ships ``{verb, payload}`` and
gets ``{exit_code, stdout}`` back; the broker runs :func:`hooks.run_hook`
with the KERNEL's facts — the store, the workspace, the request id and the
compiled turn cap are the broker's constructor arguments, never anything the
sandbox sent — so the decision ledger, the work journal, the checkpoint and
the handoff snapshot are written by the kernel against the real store, and
the turn count lives where the agent cannot reach it. The store is not
mounted in the sandbox at all.

What the agent CAN do through the socket is what a hook could always do for
its own request: ask for a verdict on a payload (the verdict is computed
here, never supplied), have a tool call journaled (sanitized here), spend
its own turns. It cannot name another request, another cap, another store.
And the verbs the CLI cannot block on are bounded per broker
(ARIA-MEDIUM-609): a post-tool for a budgeted tool is recorded once per
tool_use_id this broker allowed in pre-tool, every other post-tool name and
each session trigger is capped, and an over-cap request is answered
EXIT_ALLOW with an ``unrecorded:over_bound`` note and writes no row — so a
sandbox process forging those verbs cannot add work-journal, MCP-call or
handoff rows without bound.

One broker per spawn: created before the spawn's environment is built
(``claude_runtime.run_claude_exec``), gone when the spawn returns —
``serve_hook_broker`` is a context manager whose exit shuts the listener
down and removes the socket directory; the orphan sweep
(``socket_holders.prune_stale_holder_sockets``, ARIA-LOW-565, over the
``socket_holders.HOOK_BROKER`` declaration) removes directories a killed
executor left behind.
"""
from __future__ import annotations

import json
import shutil
import socketserver
import threading
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterator

from .hook_client import EXIT_ALLOW, EXIT_BLOCK, HOOK_BROKER_SOCKET_ENV, HOOK_VERBS
from .socket_holders import HOOK_BROKER as _SOCKET_HOLDER

# Where the broker's socket appears INSIDE the sandbox: under the sandbox's
# private /tmp tmpfs, like the signing agent's.
SANDBOX_HOOK_BROKER_SOCKET = "/tmp/aria-hook-broker.sock"
# Linux `sun_path` is 108 bytes including the terminator.
_UNIX_SOCKET_PATH_MAX = 107
# A hook payload carries the tool input (a Write's whole file) and the
# tool response; the CLI caps those far below this. Beyond it the request
# is refused, not read.
MAX_REQUEST_BYTES = 8 << 20
_REQUEST_TIMEOUT_SECONDS = 55.0
# ARIA-MEDIUM-131 — any process in the sandbox can open the socket, not only
# the CLI's hook command, and each connection used to get its own handler
# thread holding up to MAX_REQUEST_BYTES until the request timeout: a caller
# that opened connections and sent nothing spent the executor's threads and
# memory without bound. At most this many requests are served at once (the
# CLI runs one hook per tool call, a few in parallel at most); a connection
# beyond them is closed unread, which the client answers fail-closed by verb
# (a PreToolUse is denied). Bounded memory: this many times
# MAX_REQUEST_BYTES.
MAX_CONCURRENT_REQUESTS = 16
# Pending connections the listener queues before refusing a connect: above
# the served slots, so a burst of parallel hooks waits for accept instead of
# failing its connect (the stdlib default is 5).
_LISTEN_BACKLOG = 4 * MAX_CONCURRENT_REQUESTS

# ARIA-MEDIUM-609 — the verbs the CLI cannot block on (post-tool, session)
# are the ones a forged request can repeat without end, and each repeat used
# to write a journal, MCP or handoff row on the kernel's store. One bounded
# set is accepted per broker, priced for a legitimate spawn: a budgeted
# tool's post-tool arrives once per tool_use_id THIS broker allowed in
# pre-tool (the turn cap bounds those ids), every other tool name — the
# matcher's non-budgeted tools (Read|Grep|Glob|Agent) and any other name a
# forger picks — gets this flat per-broker cap (2x the default 120-turn cap:
# one journaled post-tool per admitted turn with headroom for parallel
# calls), and each session trigger is capped on its own (SessionStart and
# SessionEnd once, PreCompact a small constant — a session compacts rarely).
# Over the cap the request is answered EXIT_ALLOW with an
# ``unrecorded:over_bound`` note and writes no row: the CLI cannot block on
# these verbs, and a sandbox flooding them spends nothing of the kernel's.
MAX_POST_TOOL_PER_TOOL_NAME = 240
MAX_PRE_COMPACT_SESSION_EVENTS = 8


class HookBrokerUnavailable(RuntimeError):
    """The broker could not be started; ``reason`` names why."""

    def __init__(self, reason: str) -> None:
        super().__init__(reason)
        self.reason = reason


@dataclass(frozen=True)
class HookBroker:
    """The served broker: its host socket path and the request it serves."""

    socket_path: Path
    request_id: str


def _fail_closed(verb: str, reason: str) -> tuple[int, str]:
    """The reply when the broker cannot serve a request: a DENY for a
    PreToolUse and for anything that is not a known verb; an "unrecorded"
    note for the verbs the CLI cannot block on."""
    from .hooks import HookVerdict

    if verb == "post-tool":
        return EXIT_ALLOW, json.dumps({"aria_journal": f"unrecorded:{reason}"})
    if verb == "session":
        return EXIT_ALLOW, json.dumps({"aria_session": {"status": f"unrecorded:{reason}"}})
    return EXIT_BLOCK, HookVerdict("deny", reason, "", EXIT_BLOCK).to_stdout()


class _Server(socketserver.ThreadingMixIn, socketserver.UnixStreamServer):
    daemon_threads = True
    allow_reuse_address = False
    request_queue_size = _LISTEN_BACKLOG

    def __init__(self, socket_path: str, *, base_dir: Path, workspace_root: Path, request_id: str,
                 turn_budget: int | None) -> None:
        self.base_dir = base_dir
        self.workspace_root = workspace_root
        self.request_id = request_id
        self.turn_budget = turn_budget
        self._slots = threading.BoundedSemaphore(MAX_CONCURRENT_REQUESTS)
        # ARIA-MEDIUM-609 — the per-broker bounds on the unblockable verbs.
        # One lock covers all three: a forged burst is exactly the caller
        # that races them.
        self._bounds_lock = threading.Lock()
        self._allowed_tool_uses: set[str] = set()
        self._post_tool_counts: dict[str, int] = {}
        self._session_event_counts: dict[str, int] = {}
        super().__init__(socket_path, _Handler)

    def note_allowed_tool_use(self, tool_name: str, tool_use_id: str, *, allowed: bool) -> None:
        """Record that this broker's pre-tool ALLOWED ``tool_use_id`` (a
        budgeted tool's post-tool is accepted against it, once)."""
        from .turn_budget import BUDGETED_TOOL_NAMES

        if allowed and tool_name in BUDGETED_TOOL_NAMES and tool_use_id:
            with self._bounds_lock:
                self._allowed_tool_uses.add(tool_use_id)

    def accept_post_tool(self, tool_name: str, tool_use_id: str) -> bool:
        """Whether one more post-tool for ``tool_name`` is recorded.

        A budgeted tool's post-tool is accepted only for a tool_use_id this
        broker allowed in pre-tool, once; every other name is accepted up to
        ``MAX_POST_TOOL_PER_TOOL_NAME`` per broker.
        """
        from .turn_budget import BUDGETED_TOOL_NAMES

        with self._bounds_lock:
            if tool_name in BUDGETED_TOOL_NAMES:
                if tool_use_id in self._allowed_tool_uses:
                    self._allowed_tool_uses.discard(tool_use_id)
                    return True
                return False
            seen = self._post_tool_counts.get(tool_name, 0)
            if seen >= MAX_POST_TOOL_PER_TOOL_NAME:
                return False
            self._post_tool_counts[tool_name] = seen + 1
            return True

    def accept_session_event(self, trigger: str | None) -> bool:
        """Whether one more session event of ``trigger`` is recorded (None is
        an event no trigger maps to — it writes no row, so it costs nothing).
        SessionStart and SessionEnd happen once each; PreCompact as often as
        ``MAX_PRE_COMPACT_SESSION_EVENTS`` allows; any other trigger a future
        vocabulary adds is capped at one until a cap is priced for it."""
        if trigger is None:
            return True
        cap = MAX_PRE_COMPACT_SESSION_EVENTS if trigger == "pre_compact" else 1
        with self._bounds_lock:
            seen = self._session_event_counts.get(trigger, 0)
            if seen >= cap:
                return False
            self._session_event_counts[trigger] = seen + 1
            return True

    def process_request(self, request: Any, client_address: Any) -> None:
        """Serve the request in a slot, or close it unread when every slot is taken."""
        if not self._slots.acquire(blocking=False):
            self.shutdown_request(request)
            return
        try:
            super().process_request(request, client_address)
        except BaseException:
            self._slots.release()
            raise

    def process_request_thread(self, request: Any, client_address: Any) -> None:
        try:
            super().process_request_thread(request, client_address)
        finally:
            self._slots.release()


class _Handler(socketserver.StreamRequestHandler):
    timeout = _REQUEST_TIMEOUT_SECONDS
    server: _Server

    def handle(self) -> None:
        verb = ""
        try:
            raw = self.rfile.read(MAX_REQUEST_BYTES + 1)
            if len(raw) > MAX_REQUEST_BYTES:
                raise ValueError("hook_request_too_large")
            message = json.loads(raw.decode("utf-8") or "{}")
            verb = str(message.get("verb") or "") if isinstance(message, dict) else ""
            if verb not in HOOK_VERBS:
                raise ValueError(f"unknown_hook_verb:{verb[:32]!r}")
            payload = message.get("payload")
            if not isinstance(payload, dict):
                payload = {}
            # ARIA-MEDIUM-609 — the verbs the CLI cannot block on are bounded
            # per broker BEFORE the hook runs, so an over-cap request writes
            # no row; the trigger vocabulary is hooks' own (it maps an event
            # to the trigger that would write a handoff row).
            from .hooks import _SESSION_TRIGGERS, run_hook

            tool_name = str(payload.get("tool_name") or "")
            tool_use_id = str(payload.get("tool_use_id") or "")
            if verb == "post-tool" and not self.server.accept_post_tool(tool_name, tool_use_id):
                exit_code, stdout = EXIT_ALLOW, json.dumps({"aria_journal": "unrecorded:over_bound"})
            elif verb == "session" and not self.server.accept_session_event(
                    _SESSION_TRIGGERS.get(str(payload.get("hook_event_name") or ""))):
                exit_code, stdout = EXIT_ALLOW, json.dumps({"aria_session": {"status": "unrecorded:over_bound"}})
            else:
                exit_code, stdout = run_hook(
                    verb, payload, base_dir=self.server.base_dir, workspace_root=self.server.workspace_root,
                    request_id=self.server.request_id, turn_budget=self.server.turn_budget,
                )
                if verb == "pre-tool":
                    self.server.note_allowed_tool_use(tool_name, tool_use_id, allowed=exit_code == EXIT_ALLOW)
        except Exception as exc:  # noqa: BLE001 — a hook the broker cannot serve is a deny, never a dead broker
            exit_code, stdout = _fail_closed(verb, f"hook_broker_error:{type(exc).__name__}")
        try:
            self.wfile.write(json.dumps({"exit_code": exit_code, "stdout": stdout}).encode("utf-8"))
        except OSError:
            return


@contextmanager
def serve_hook_broker(
    *,
    base_dir: str | Path,
    workspace_root: str | Path,
    request_id: str,
    turn_budget: int | None,
) -> Iterator[HookBroker]:
    """Serve the hooks of one spawn for the body, on a fresh socket.

    ``base_dir`` is the store the hooks journal into, ``workspace_root`` the
    tree the spawn runs in, ``request_id`` the request it serves and
    ``turn_budget`` the cap the kernel compiled into the spawn's settings
    (``claude_settings.build_settings``; None for an unbudgeted spawn) — the
    kernel's facts, fixed for the broker's life. The listener is shut down
    and the socket directory removed on every exit of the body.
    """
    socket_dir = _SOCKET_HOLDER.make_directory()
    socket_path = socket_dir / _SOCKET_HOLDER.socket_name
    server: _Server | None = None
    thread: threading.Thread | None = None
    try:
        if len(str(socket_path).encode()) > _UNIX_SOCKET_PATH_MAX:
            raise HookBrokerUnavailable("socket_path_too_long")
        try:
            server = _Server(
                str(socket_path), base_dir=Path(base_dir), workspace_root=Path(workspace_root).resolve(),
                request_id=str(request_id), turn_budget=turn_budget,
            )
        except OSError as exc:
            raise HookBrokerUnavailable(f"listener_failed:{type(exc).__name__}") from exc
        thread = threading.Thread(target=server.serve_forever, kwargs={"poll_interval": 0.2},
                                  name=f"aria-hook-broker-{request_id}", daemon=True)
        thread.start()
        yield HookBroker(socket_path=socket_path, request_id=str(request_id))
    finally:
        if server is not None:
            server.shutdown()
            server.server_close()
        if thread is not None:
            thread.join(timeout=5.0)
        shutil.rmtree(socket_dir, ignore_errors=True)


__all__ = [
    "HOOK_BROKER_SOCKET_ENV",
    "MAX_CONCURRENT_REQUESTS",
    "MAX_POST_TOOL_PER_TOOL_NAME",
    "MAX_PRE_COMPACT_SESSION_EVENTS",
    "MAX_REQUEST_BYTES",
    "SANDBOX_HOOK_BROKER_SOCKET",
    "HookBroker",
    "HookBrokerUnavailable",
    "serve_hook_broker",
]
