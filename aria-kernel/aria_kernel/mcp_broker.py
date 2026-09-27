"""ARIA-HIGH-124 — the kernel-side MCP broker: the `aria` server, served outside the sandbox.

WHY this module exists
----------------------
The kernel's `aria` MCP server (``mcp_server.AriaMcpServer``) is a read
view of the durable state store. The registry used to spawn it INSIDE the
agent's sandbox, where the store is not mounted (ARIA-HIGH-123): it served
an empty phantom, journaled into that phantom, and — as ``python3 -m
aria_kernel`` — could have been shadowed by a package the agent wrote into
its own worktree. A view of the store has to be served where the store is.

WHAT this module does
---------------------
It serves the `aria` MCP server OUTSIDE the sandbox, in the executor
process, on a unix socket the wrapper binds into the sandbox at a fixed
path (``SANDBOX_MCP_BROKER_SOCKET``). The in-sandbox end is the stdlib-only
relay (``mcp_relay``, run by path), which pumps the CLI's newline-delimited
JSON-RPC to the socket and the answers back. Each connection is served by
its own ``AriaMcpServer`` over the KERNEL's facts — the store and the
workspace are the broker's constructor arguments, never anything the
sandbox sent — with ``allow_writes=False`` unconditionally: an agent role
gets the read tools; the write tools exist for operators through
``aria-kernel mcp serve --allow-writes`` and are unreachable here by
construction. Every call lands on ``mcp/tool-calls.jsonl`` against the real
store, as before.

One broker per spawn, like the hook broker: created before the spawn's
environment is built (``claude_runtime.run_claude_exec``), gone when the
spawn returns — ``serve_mcp_broker`` is a context manager whose exit shuts
the listener down and removes the socket directory; the orphan sweep
(``prune_stale_mcp_brokers``) removes directories a killed executor left.
"""
from __future__ import annotations

import io
import re
import shutil
import socket
import socketserver
import tempfile
import threading
import time
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterator

from .mcp_relay import MCP_BROKER_SOCKET_ENV

# Where the broker's socket appears INSIDE the sandbox: under the sandbox's
# private /tmp tmpfs, like the hook broker's and the signing agent's.
SANDBOX_MCP_BROKER_SOCKET = "/tmp/aria-mcp-broker.sock"
_SOCKET_DIR_PREFIX = "aria-mb-"
_SOCKET_NAME = "sock"
_SOCKET_DIR_RE = re.compile(r"^aria-mb-[A-Za-z0-9_]{8}$")
# Linux `sun_path` is 108 bytes including the terminator.
_UNIX_SOCKET_PATH_MAX = 107
# One JSON-RPC line at most this long is read; the CLI's tool arguments
# are far below it. Beyond it the connection is closed, not read.
MAX_LINE_BYTES = 1 << 20


class McpBrokerUnavailable(RuntimeError):
    """The broker could not be started; ``reason`` names why."""

    def __init__(self, reason: str) -> None:
        super().__init__(reason)
        self.reason = reason


@dataclass(frozen=True)
class McpBroker:
    """The served broker: its host socket path and the request it serves."""

    socket_path: Path
    request_id: str


class _Server(socketserver.ThreadingMixIn, socketserver.UnixStreamServer):
    daemon_threads = True
    allow_reuse_address = False

    def __init__(self, socket_path: str, *, base_dir: Path, workspace_root: Path, request_id: str) -> None:
        self.base_dir = base_dir
        self.workspace_root = workspace_root
        self.request_id = request_id
        super().__init__(socket_path, _Handler)


class _Handler(socketserver.StreamRequestHandler):
    server: _Server

    def handle(self) -> None:
        from .mcp_server import AriaMcpServer

        server = AriaMcpServer(base_dir=self.server.base_dir, workspace_root=self.server.workspace_root,
                               allow_writes=False, request_id=self.server.request_id)
        reader = io.TextIOWrapper(self.rfile, encoding="utf-8", errors="replace")
        writer = io.TextIOWrapper(self.wfile, encoding="utf-8", write_through=True)
        try:
            server.serve(_BoundedLines(reader), writer)
        except (OSError, ValueError):
            return


class _BoundedLines:
    """An iterator over the connection's lines that closes on an overlong one."""

    def __init__(self, reader: io.TextIOWrapper) -> None:
        self._reader = reader

    def __iter__(self) -> "_BoundedLines":
        return self

    def __next__(self) -> str:
        line = self._reader.readline(MAX_LINE_BYTES + 1)
        if not line:
            raise StopIteration
        if len(line) > MAX_LINE_BYTES:
            raise ValueError("mcp_line_too_long")
        return line


@contextmanager
def serve_mcp_broker(*, base_dir: str | Path, workspace_root: str | Path, request_id: str) -> Iterator[McpBroker]:
    """Serve the `aria` MCP read view of one spawn for the body, on a fresh
    socket. ``base_dir`` is the store the view reads, ``workspace_root`` the
    tree the spawn runs in — the kernel's facts, fixed for the broker's
    life. The listener is shut down and the socket directory removed on
    every exit of the body."""
    socket_dir = Path(tempfile.mkdtemp(prefix=_SOCKET_DIR_PREFIX))
    socket_path = socket_dir / _SOCKET_NAME
    server: _Server | None = None
    thread: threading.Thread | None = None
    try:
        if len(str(socket_path).encode()) > _UNIX_SOCKET_PATH_MAX:
            raise McpBrokerUnavailable("socket_path_too_long")
        try:
            server = _Server(
                str(socket_path), base_dir=Path(base_dir), workspace_root=Path(workspace_root).resolve(),
                request_id=str(request_id),
            )
        except OSError as exc:
            raise McpBrokerUnavailable(f"listener_failed:{type(exc).__name__}") from exc
        thread = threading.Thread(target=server.serve_forever, kwargs={"poll_interval": 0.2},
                                  name=f"aria-mcp-broker-{request_id}", daemon=True)
        thread.start()
        yield McpBroker(socket_path=socket_path, request_id=str(request_id))
    finally:
        if server is not None:
            server.shutdown()
            server.server_close()
        if thread is not None:
            thread.join(timeout=5.0)
        remove_socket_dir(socket_dir)


def remove_socket_dir(socket_dir: Path, *, deadline_seconds: float = 2.0) -> bool:
    """Remove the broker's socket directory, waiting out a late writer.

    A handler thread that is still closing its connection, or a prober
    (`prune_stale_mcp_brokers`) that connected a moment before shutdown,
    can leave an entry under the directory between the walk and the rmdir;
    `shutil.rmtree(ignore_errors=True)` then left the directory standing,
    and the caller's own fixture root failed its cleanup with
    `Directory not empty` (the hosted kernel lane and two pre-push suites,
    2026-09-19/20). The removal is retried inside a small bound and reports
    whether the directory is gone.
    """
    end = time.monotonic() + deadline_seconds
    while True:
        shutil.rmtree(socket_dir, ignore_errors=True)
        if not socket_dir.exists():
            return True
        if time.monotonic() >= end:
            return False
        time.sleep(0.05)


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


def prune_stale_mcp_brokers(*, temp_root: str | Path | None = None) -> dict[str, Any]:
    """Remove the socket directories of brokers that no longer answer (an
    executor killed outright never reached ``serve_mcp_broker``'s exit)."""
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
    "MAX_LINE_BYTES",
    "MCP_BROKER_SOCKET_ENV",
    "SANDBOX_MCP_BROKER_SOCKET",
    "McpBroker",
    "McpBrokerUnavailable",
    "prune_stale_mcp_brokers",
    "serve_mcp_broker",
]
