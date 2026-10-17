"""ARIA-HIGH-143 / ARIA-HIGH-528 / ARIA-MEDIUM-563 — the kernel's listeners,
the one road out of every room that reaches a provider.

The managed Claude room and the Codex runtime room used to share the host's
network namespace so the CLI could reach its provider, and this proxy sat
beside them as ``HTTPS_PROXY`` — advice, not a boundary. The policy refuses
``curl`` and ``wget`` by name, but ``pytest`` and ``nx test`` run whatever the
agent wrote into the tree, so one test file opened a socket to any address
the host could reach (a public host, the production stack's loopback
services, an abstract unix socket) and sent what the room could read, the
CLI's own credential included.

Now every room has its OWN network namespace: loopback and nothing else. A
room handed a provider route (``implementation_safety._sandbox_argv`` with
``provider=<key>``) gets one more thing, a unix socket of this process, bound
in at the route's path. What listens there is the route's
(``provider_routes``):

* a ``gateway`` route — the provider gateway (``provider_gateway``): pinned
  requests only, the room's credential replaced by the kernel's. A room on
  this route has no CONNECT road at all (ARIA-MEDIUM-563: a tunnel to the
  provider's host carried any credential the room brought);
* a ``tunnel`` route — the CONNECT proxy below, with that route's targets
  alone as its allowlist; the in-room relay (``egress_relay.py``) turns its
  socket into the ``HTTPS_PROXY`` the CLI honours. It speaks one verb,
  ``CONNECT``, refuses everything else by name before any upstream
  connection, and writes one JSON line per decision to the kernel's stderr.

Both are served by the kernel process that builds the room
(:func:`kernel_egress_sockets`), for that process's life — not by a host
service an operator must install and keep in step: a room cannot be built
without its listener, and every allowlist is reviewed kernel code.

Standard library only — a decision here must be readable by an operator in
one screen.
"""
from __future__ import annotations

import asyncio
import atexit
import json
import os
import re
import shutil
import socket
import sys
import tempfile
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Awaitable, Callable, Mapping

from .provider_gateway import MAX_HEAD_BYTES as GATEWAY_MAX_HEAD_BYTES, ProviderGateway
from .provider_routes import GATEWAY, ROOM_ROUTE_KEYS, TUNNEL, route as provider_route, tunnel_allowlist

MAX_HEADER_BYTES = 8192
CONNECT_TIMEOUT_SECONDS = 20.0
IDLE_TIMEOUT_SECONDS = 600.0

_UNIX_SOCKET_PATH_MAX = 107
_START_TIMEOUT_SECONDS = 10.0
# The kernel's socket directory, named like the other holders' (hook broker
# `aria-hb-`, MCP broker `aria-mb-`, signing agent `aria-sa-`) so the
# orchestrator's startup sweep can tell a killed process's directory by name.
# One socket per room route, named by the route's key.
_SOCKET_DIR_PREFIX = "aria-ep-"
_SOCKET_NAMES: frozenset[str] = frozenset(ROOM_ROUTE_KEYS)
_SOCKET_DIR_RE = re.compile(r"^aria-ep-[A-Za-z0-9_]{8}$")


class EgressProxyUnavailable(RuntimeError):
    """The kernel's egress proxy could not be served, so no room that needs
    its provider can be built."""


@dataclass(frozen=True)
class Allowlist:
    targets: frozenset[tuple[str, int]]

    @classmethod
    def parse(cls, entries: list[str] | tuple[str, ...]) -> "Allowlist":
        targets: set[tuple[str, int]] = set()
        for entry in entries:
            host, sep, port = entry.rpartition(":")
            if not sep or not host or not port.isdigit():
                raise ValueError(f"allowlist entry must be host:port, got {entry!r}")
            targets.add((host.lower(), int(port)))
        if not targets:
            raise ValueError("an empty allowlist admits nothing and serves no one")
        return cls(frozenset(targets))

    def admits(self, host: str, port: int) -> bool:
        return (host.lower(), port) in self.targets


def _decision(**fields: object) -> None:
    sys.stderr.write(json.dumps({"ts": time.time(), "event": "egress_decision", **fields}, sort_keys=True) + "\n")
    sys.stderr.flush()


async def _pump(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
    try:
        while True:
            chunk = await asyncio.wait_for(reader.read(65536), timeout=IDLE_TIMEOUT_SECONDS)
            if not chunk:
                break
            writer.write(chunk)
            await writer.drain()
    except (asyncio.TimeoutError, ConnectionError, asyncio.IncompleteReadError):
        pass
    finally:
        try:
            writer.close()
        except Exception:  # pragma: no cover - best effort on a dying pipe
            pass


async def _refuse(writer: asyncio.StreamWriter, status: str, reason: str) -> None:
    body = reason.encode() + b"\n"
    writer.write(
        f"HTTP/1.1 {status}\r\nContent-Type: text/plain\r\nContent-Length: {len(body)}\r\nConnection: close\r\n\r\n".encode()
        + body
    )
    await writer.drain()
    writer.close()


async def handle(reader: asyncio.StreamReader, writer: asyncio.StreamWriter, allowlist: Allowlist) -> None:
    try:
        head = await asyncio.wait_for(reader.readuntil(b"\r\n\r\n"), timeout=CONNECT_TIMEOUT_SECONDS)
    except (asyncio.LimitOverrunError, asyncio.IncompleteReadError, asyncio.TimeoutError, ValueError):
        _decision(verdict="refused", reason="malformed_request")
        writer.close()
        return
    if len(head) > MAX_HEADER_BYTES:
        _decision(verdict="refused", reason="header_too_large")
        await _refuse(writer, "431 Request Header Fields Too Large", "egress_refused:header_too_large")
        return
    request_line = head.split(b"\r\n", 1)[0].decode("latin-1", "replace")
    parts = request_line.split(" ")
    if len(parts) != 3 or parts[0] != "CONNECT":
        _decision(verdict="refused", reason="method_not_connect", request_line=request_line[:120])
        await _refuse(writer, "405 Method Not Allowed", "egress_refused:only_connect_is_served")
        return
    host, sep, port_text = parts[1].rpartition(":")
    if not sep or not host or not port_text.isdigit():
        _decision(verdict="refused", reason="target_malformed", target=parts[1][:120])
        await _refuse(writer, "400 Bad Request", "egress_refused:target_must_be_host_port")
        return
    port = int(port_text)
    if not allowlist.admits(host, port):
        _decision(verdict="refused", reason="target_not_allowlisted", target=f"{host}:{port}")
        await _refuse(writer, "403 Forbidden", f"egress_refused:target_not_allowlisted:{host}:{port}")
        return
    try:
        upstream_reader, upstream_writer = await asyncio.wait_for(
            asyncio.open_connection(host, port), timeout=CONNECT_TIMEOUT_SECONDS,
        )
    except (OSError, asyncio.TimeoutError) as exc:
        _decision(verdict="refused", reason="upstream_unreachable", target=f"{host}:{port}", error=str(exc)[:200])
        await _refuse(writer, "502 Bad Gateway", f"egress_refused:upstream_unreachable:{host}:{port}")
        return
    _decision(verdict="admitted", target=f"{host}:{port}")
    writer.write(b"HTTP/1.1 200 Connection Established\r\n\r\n")
    await writer.drain()
    await asyncio.gather(_pump(reader, upstream_writer), _pump(upstream_reader, writer))


async def serve(*, listen: tuple[str, int] | None, unix_socket: str | None, allowlist: Allowlist) -> list[asyncio.AbstractServer]:
    """Start the listeners and return them (the caller keeps them alive)."""
    async def on_connection(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        await handle(reader, writer, allowlist)

    servers: list[asyncio.AbstractServer] = []
    if listen is not None:
        servers.append(await asyncio.start_server(on_connection, host=listen[0], port=listen[1], limit=MAX_HEADER_BYTES * 2))
    if unix_socket is not None:
        if os.path.exists(unix_socket):
            os.unlink(unix_socket)
        servers.append(await asyncio.start_unix_server(on_connection, path=unix_socket, limit=MAX_HEADER_BYTES * 2))
        os.chmod(unix_socket, 0o666)
    if not servers:
        raise ValueError("nothing to listen on: give a loopback address and/or a unix socket")
    return servers


async def _shutdown(servers: list[asyncio.AbstractServer]) -> None:
    """Stop listening and end every open tunnel: a stopped proxy carries no
    traffic, so nothing waits on an idle pump's timeout."""
    for server in servers:
        server.close()
    tunnels = [task for task in asyncio.all_tasks() if task is not asyncio.current_task()]
    for task in tunnels:
        task.cancel()
    await asyncio.gather(*tunnels, return_exceptions=True)


Handler = Callable[[asyncio.StreamReader, asyncio.StreamWriter], Awaitable[None]]


def connect_handler(allowlist: Allowlist) -> Handler:
    """The CONNECT proxy for one allowlist, as a listener's handler."""
    async def on_connection(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        await handle(reader, writer, allowlist)

    return on_connection


class ProxyThread:
    """The kernel's listeners, one unix socket each, served from a daemon
    thread with its own event loop — how a synchronous kernel process (the
    executor, a test) keeps them alive beside the rooms it builds."""

    def __init__(self, listeners: Mapping[Path, Handler]) -> None:
        if not listeners:
            raise ValueError("nothing to listen on")
        for socket_path in listeners:
            if len(str(socket_path).encode()) > _UNIX_SOCKET_PATH_MAX:
                raise EgressProxyUnavailable(f"egress_proxy_socket_path_too_long:{socket_path}")
        self.listeners = {Path(path): handler for path, handler in listeners.items()}
        self.pid = os.getpid()
        self._loop: asyncio.AbstractEventLoop | None = None
        self._thread: threading.Thread | None = None

    @classmethod
    def connect(cls, socket_path: Path, allowlist: Allowlist) -> "ProxyThread":
        """One CONNECT listener for ``allowlist`` (a test's, or one route's)."""
        return cls({Path(socket_path): connect_handler(allowlist)})

    @property
    def socket_path(self) -> Path:
        """The socket of a single-listener thread."""
        (only,) = self.listeners
        return only

    async def _serve(self) -> list[asyncio.AbstractServer]:
        servers: list[asyncio.AbstractServer] = []
        for path, handler in self.listeners.items():
            if path.exists():
                path.unlink()
            # The stream limit bounds a head that never ends: the gateway's
            # cap, above the CONNECT proxy's own (which refuses past it by name).
            servers.append(await asyncio.start_unix_server(handler, path=str(path), limit=GATEWAY_MAX_HEAD_BYTES))
            os.chmod(path, 0o666)
        return servers

    def start(self) -> "ProxyThread":
        ready = threading.Event()
        failure: list[BaseException] = []

        def run() -> None:
            loop = asyncio.new_event_loop()
            try:
                servers = loop.run_until_complete(self._serve())
            except (OSError, ValueError) as exc:
                failure.append(exc)
                loop.close()
                ready.set()
                return
            self._loop = loop
            ready.set()
            try:
                loop.run_forever()
            finally:
                loop.run_until_complete(_shutdown(servers))
                loop.close()

        self._thread = threading.Thread(target=run, name="aria-egress-proxy", daemon=True)
        self._thread.start()
        if not ready.wait(timeout=_START_TIMEOUT_SECONDS):
            raise EgressProxyUnavailable("egress_proxy_did_not_start")
        if failure:
            raise EgressProxyUnavailable(f"egress_proxy_unavailable:{type(failure[0]).__name__}:{failure[0]}")
        _decision(event="egress_proxy_started", unix=sorted(str(path) for path in self.listeners))
        return self

    def serving(self) -> bool:
        return (self.pid == os.getpid() and self._thread is not None and self._thread.is_alive()
                and all(path.is_socket() for path in self.listeners))

    def stop(self) -> None:
        if self._loop is not None and self._thread is not None and self._thread.is_alive():
            self._loop.call_soon_threadsafe(self._loop.stop)
            self._thread.join(timeout=5)


def _route_handler(key: str) -> Handler:
    """What listens on a room route's socket: the gateway, or the CONNECT
    proxy with that route's targets alone."""
    found = provider_route(key)
    if found.kind == GATEWAY:
        return ProviderGateway(found).handle
    if found.kind == TUNNEL:
        return connect_handler(Allowlist.parse(tunnel_allowlist(key)))
    raise EgressProxyUnavailable(f"provider_route_not_for_rooms:{key}")


_KERNEL_PROXY: list[ProxyThread] = []
_KERNEL_PROXY_LOCK = threading.Lock()


def kernel_egress_sockets() -> dict[str, Path]:
    """THIS process's listener socket per room route (``provider_routes``),
    started on first use, alive for the process.

    One set per process (a forked child starts its own): every room the
    process builds is handed the same sockets, so the argv the containment
    probe proves is the argv a spawn gets. They live in a private 0700
    directory removed at exit; a room reaches its route's socket through its
    bind alone. A process killed outright never reaches its exit; its
    directory is the orchestrator's startup sweep's
    (:func:`prune_stale_egress_proxies`).
    """
    with _KERNEL_PROXY_LOCK:
        if _KERNEL_PROXY and _KERNEL_PROXY[0].serving():
            return {path.name: path for path in _KERNEL_PROXY[0].listeners}
        directory = Path(tempfile.mkdtemp(prefix=_SOCKET_DIR_PREFIX))
        try:
            proxy = ProxyThread({directory / key: _route_handler(key) for key in ROOM_ROUTE_KEYS}).start()
        except EgressProxyUnavailable:
            shutil.rmtree(directory, ignore_errors=True)
            raise
        atexit.register(shutil.rmtree, directory, True)
        _KERNEL_PROXY[:] = [proxy]
        return {path.name: path for path in proxy.listeners}


def _proxy_answers(socket_path: Path) -> bool:
    client = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    try:
        client.settimeout(1.0)
        client.connect(str(socket_path))
        return True
    except OSError:
        return False
    finally:
        client.close()


def prune_stale_egress_proxies(*, temp_root: str | Path | None = None) -> dict[str, Any]:
    """Remove the socket directories of kernel listeners that no longer answer
    (a process killed outright never reached its ``atexit``). A directory one
    of whose sockets still answers belongs to a live process and is left
    alone; one holding anything but the route sockets is not ours to remove."""
    root = Path(temp_root) if temp_root is not None else Path(tempfile.gettempdir())
    swept: list[str] = []
    live: list[str] = []
    errors: list[str] = []
    for entry in sorted(root.glob(f"{_SOCKET_DIR_PREFIX}*")):
        if not entry.is_dir() or not _SOCKET_DIR_RE.match(entry.name):
            continue
        sockets = [entry / name for name in sorted(_SOCKET_NAMES)]
        if any(path.is_socket() and _proxy_answers(path) for path in sockets):
            live.append(entry.name)
            continue
        try:
            if any(child.name not in _SOCKET_NAMES for child in entry.iterdir()):
                continue
            shutil.rmtree(entry)
        except OSError as exc:
            errors.append(f"{entry.name}:{type(exc).__name__}")
        else:
            swept.append(entry.name)
    return {"scanned": len(swept) + len(live) + len(errors), "swept": swept, "live": live, "errors": errors}
