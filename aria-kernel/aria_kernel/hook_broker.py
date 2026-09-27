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

One broker per spawn: created before the spawn's environment is built
(``claude_runtime.run_claude_exec``), gone when the spawn returns —
``serve_hook_broker`` is a context manager whose exit shuts the listener
down and removes the socket directory; the orphan sweep
(``prune_stale_hook_brokers``) removes directories a killed executor left
behind.
"""
from __future__ import annotations

import json
import re
import shutil
import socket
import socketserver
import tempfile
import threading
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterator

from .hook_client import EXIT_ALLOW, EXIT_BLOCK, HOOK_BROKER_SOCKET_ENV, HOOK_VERBS

# Where the broker's socket appears INSIDE the sandbox: under the sandbox's
# private /tmp tmpfs, like the signing agent's.
SANDBOX_HOOK_BROKER_SOCKET = "/tmp/aria-hook-broker.sock"
_SOCKET_DIR_PREFIX = "aria-hb-"
_SOCKET_NAME = "sock"
# The shape of a directory THIS module made (the sweep removes nothing else).
_SOCKET_DIR_RE = re.compile(r"^aria-hb-[A-Za-z0-9_]{8}$")
# Linux `sun_path` is 108 bytes including the terminator.
_UNIX_SOCKET_PATH_MAX = 107
# A hook payload carries the tool input (a Write's whole file) and the
# tool response; the CLI caps those far below this. Beyond it the request
# is refused, not read.
MAX_REQUEST_BYTES = 8 << 20
_REQUEST_TIMEOUT_SECONDS = 55.0


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

    def __init__(self, socket_path: str, *, base_dir: Path, workspace_root: Path, request_id: str,
                 turn_budget: int | None) -> None:
        self.base_dir = base_dir
        self.workspace_root = workspace_root
        self.request_id = request_id
        self.turn_budget = turn_budget
        super().__init__(socket_path, _Handler)


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
            from .hooks import run_hook

            exit_code, stdout = run_hook(
                verb, payload, base_dir=self.server.base_dir, workspace_root=self.server.workspace_root,
                request_id=self.server.request_id, turn_budget=self.server.turn_budget,
            )
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
    socket_dir = Path(tempfile.mkdtemp(prefix=_SOCKET_DIR_PREFIX))
    socket_path = socket_dir / _SOCKET_NAME
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


def _broker_answers(socket_path: Path) -> bool:
    client = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    try:
        client.settimeout(1.0)
        client.connect(str(socket_path))
        return True
    except OSError:
        return False
    finally:
        client.close()


def prune_stale_hook_brokers(*, temp_root: str | Path | None = None) -> dict[str, Any]:
    """Remove the socket directories of brokers that no longer answer (an
    executor killed outright never reached ``serve_hook_broker``'s exit)."""
    root = Path(temp_root) if temp_root is not None else Path(tempfile.gettempdir())
    swept: list[str] = []
    live: list[str] = []
    errors: list[str] = []
    for entry in sorted(root.glob(f"{_SOCKET_DIR_PREFIX}*")):
        if not entry.is_dir() or not _SOCKET_DIR_RE.match(entry.name):
            continue
        socket_path = entry / _SOCKET_NAME
        if socket_path.is_socket() and _broker_answers(socket_path):
            live.append(entry.name)
            continue
        try:
            if any(child.name != _SOCKET_NAME for child in entry.iterdir()):
                continue
            shutil.rmtree(entry)
        except OSError as exc:
            errors.append(f"{entry.name}:{type(exc).__name__}")
        else:
            swept.append(entry.name)
    return {"scanned": len(swept) + len(live) + len(errors), "swept": swept, "live": live, "errors": errors}


__all__ = [
    "HOOK_BROKER_SOCKET_ENV",
    "MAX_REQUEST_BYTES",
    "SANDBOX_HOOK_BROKER_SOCKET",
    "HookBroker",
    "HookBrokerUnavailable",
    "prune_stale_hook_brokers",
    "serve_hook_broker",
]
