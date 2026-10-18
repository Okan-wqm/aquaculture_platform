"""ARIA-HIGH-143 / ARIA-HIGH-528 — the one road out of every room that reaches
a provider: an allowlist CONNECT proxy the kernel serves itself.

The managed Claude room and the Codex runtime room used to share the host's
network namespace so the CLI could reach its provider, and this proxy sat
beside them as ``HTTPS_PROXY`` — advice, not a boundary. The policy refuses
``curl`` and ``wget`` by name, but ``pytest`` and ``nx test`` run whatever the
agent wrote into the tree, so one test file opened a socket to any address
the host could reach (a public host, the production stack's loopback
services, an abstract unix socket) and sent what the room could read, the
CLI's own credential included.

Now a room that needs its provider (``implementation_safety._sandbox_argv``
with ``allow_network=True``) has its OWN network namespace: loopback and
nothing else. The one thing in it that leads anywhere is this proxy's unix
socket, bound in at ``SANDBOX_EGRESS_PROXY_SOCKET``; the in-room relay
(``egress_relay.py``) turns it into the ``HTTPS_PROXY`` the CLIs honour. The
proxy speaks one verb, ``CONNECT``, to the ``PROVIDER_ENDPOINTS`` allowlist,
refuses everything else by name before any upstream connection, and writes
one JSON line per decision to the kernel's stderr.

It is served by the kernel process that builds the room
(:func:`kernel_egress_socket`), for that process's life — not by a host
service an operator must install and keep in step: a room cannot be built
without its proxy, and the allowlist is reviewed kernel code. It has no
authentication: whoever can reach the socket already runs on this host, and
every connection it admits ends at a provider that authenticates the caller
itself.

Standard library only (its socket directory is the stdlib-only
``socket_holders.EGRESS_PROXY``) — a decision here must be readable by an
operator in one screen.
"""
from __future__ import annotations

import asyncio
import atexit
import json
import os
import shutil
import sys
import threading
import time
from dataclasses import dataclass
from pathlib import Path

from .socket_holders import EGRESS_PROXY as _SOCKET_HOLDER

MAX_HEADER_BYTES = 8192
CONNECT_TIMEOUT_SECONDS = 20.0
IDLE_TIMEOUT_SECONDS = 600.0

# The provider endpoints a room may reach — the whole policy. A new endpoint
# is a reviewed change to this tuple, never an environment variable. Each was
# read from the CLI that needs it, not guessed:
PROVIDER_ENDPOINTS: tuple[str, ...] = (
    # Claude CLI — the Messages API (`BASE_API_URL`, CLI 2.1.278 on the
    # runner, 2.1.301 on the operator host).
    "api.anthropic.com:443",
    # Claude CLI — the managed login's OAuth refresh (`TOKEN_URL` in the same
    # binaries). Without it an expired access token cannot be refreshed inside
    # the room: ARIA-HIGH-157's "OAuth session expired and could not be
    # refreshed".
    "platform.claude.com:443",
    # Claude CLI — the GLM rungs' vendor redirect
    # (`ANTHROPIC_BASE_URL=https://api.z.ai/api/anthropic`,
    # `agent_runtime_profile`).
    "api.z.ai:443",
    # Codex CLI — the managed ChatGPT session's backend and its token refresh,
    # and the API route.
    "chatgpt.com:443",
    "auth.openai.com:443",
    "api.openai.com:443",
)
_UNIX_SOCKET_PATH_MAX = 107
_START_TIMEOUT_SECONDS = 10.0


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


class ProxyThread:
    """The proxy served on one unix socket from a daemon thread with its own
    event loop — how a synchronous kernel process (the executor, a test)
    keeps a proxy alive beside the rooms it builds."""

    def __init__(self, socket_path: Path, allowlist: Allowlist) -> None:
        if len(str(socket_path).encode()) > _UNIX_SOCKET_PATH_MAX:
            raise EgressProxyUnavailable(f"egress_proxy_socket_path_too_long:{socket_path}")
        self.socket_path = Path(socket_path)
        self.allowlist = allowlist
        self.pid = os.getpid()
        self._loop: asyncio.AbstractEventLoop | None = None
        self._thread: threading.Thread | None = None

    def start(self) -> "ProxyThread":
        ready = threading.Event()
        failure: list[BaseException] = []

        def run() -> None:
            loop = asyncio.new_event_loop()
            try:
                servers = loop.run_until_complete(
                    serve(listen=None, unix_socket=str(self.socket_path), allowlist=self.allowlist),
                )
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
        _decision(event="egress_proxy_started", unix=str(self.socket_path),
                  allow=sorted(f"{host}:{port}" for host, port in self.allowlist.targets))
        return self

    def serving(self) -> bool:
        return (self.pid == os.getpid() and self._thread is not None and self._thread.is_alive()
                and self.socket_path.is_socket())

    def stop(self) -> None:
        if self._loop is not None and self._thread is not None and self._thread.is_alive():
            self._loop.call_soon_threadsafe(self._loop.stop)
            self._thread.join(timeout=5)


_KERNEL_PROXY: list[ProxyThread] = []
_KERNEL_PROXY_LOCK = threading.Lock()


def kernel_egress_socket() -> Path:
    """The unix socket of THIS process's egress proxy, serving
    ``PROVIDER_ENDPOINTS`` — started on first use, alive for the process.

    One per process (a forked child starts its own): every room the process
    builds is handed the same socket, so the argv the containment probe
    proves is the argv a spawn gets. The socket lives in a private 0700
    directory removed at exit; the room reaches it through its bind alone.
    A process killed outright never reaches its exit; its directory is the
    orchestrator's startup sweep's
    (:func:`socket_holders.prune_stale_holder_sockets`, ARIA-LOW-565, over the
    ``socket_holders.EGRESS_PROXY`` declaration).
    """
    with _KERNEL_PROXY_LOCK:
        if _KERNEL_PROXY and _KERNEL_PROXY[0].serving():
            return _KERNEL_PROXY[0].socket_path
        directory = _SOCKET_HOLDER.make_directory()
        try:
            proxy = ProxyThread(directory / _SOCKET_HOLDER.socket_name, Allowlist.parse(PROVIDER_ENDPOINTS)).start()
        except EgressProxyUnavailable:
            shutil.rmtree(directory, ignore_errors=True)
            raise
        atexit.register(shutil.rmtree, directory, True)
        _KERNEL_PROXY[:] = [proxy]
        return proxy.socket_path
