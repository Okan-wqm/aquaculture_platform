"""ARIA-HIGH-143 — the implementer sandbox's one road out: an allowlist
CONNECT proxy the kernel runs on the host.

The managed spawn shares the host's network namespace so the Claude CLI can
reach its provider — and until this, that was the whole boundary: the
policy refuses ``curl`` and ``wget`` by name, but ``pytest`` and ``nx test``
run whatever the agent wrote into the tree, ``.env`` is bound read-only and
visible, and ``/etc/resolv.conf`` was bound in. A prompt-injected agent
needed one test file and one allowed runner to send a secret anywhere. The
only brake was the model's judgement, which is exactly what an injection
targets.

This proxy is the boundary. It speaks one verb, ``CONNECT``, to targets on
an allowlist of ``host:port`` pairs (the provider endpoints, nothing else),
refuses everything else by name and writes one JSON line per decision. It
listens on loopback and on a unix socket; the sandbox reaches it through
``HTTPS_PROXY`` (the CLI honours it) and, once the spawn is netns-isolated,
only through the socket bound into it. It has no authentication: whoever
can reach the listener already runs on this host, and every connection it
admits ends at a provider that authenticates the caller itself.

Standard library only; run by path under ``python3 -I`` from the unit
(``infrastructure/aria/aria-egress-proxy.service``) — a decision here must
be readable by an operator in one screen.
"""
from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys
import time
from dataclasses import dataclass

MAX_HEADER_BYTES = 8192
CONNECT_TIMEOUT_SECONDS = 20.0
IDLE_TIMEOUT_SECONDS = 600.0


@dataclass(frozen=True)
class Allowlist:
    targets: frozenset[tuple[str, int]]

    @classmethod
    def parse(cls, entries: list[str]) -> "Allowlist":
        targets: set[tuple[str, int]] = set()
        for entry in entries:
            host, sep, port = entry.rpartition(":")
            if not sep or not host or not port.isdigit():
                raise ValueError(f"allowlist entry must be host:port, got {entry!r}")
            targets.add((host.lower(), int(port)))
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
        raise ValueError("nothing to listen on: give --listen and/or --unix")
    return servers


def _parse_listen(text: str) -> tuple[str, int]:
    host, sep, port = text.rpartition(":")
    if not sep or not port.isdigit():
        raise argparse.ArgumentTypeError(f"--listen must be host:port, got {text!r}")
    return (host or "127.0.0.1", int(port))


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n", 1)[0])
    parser.add_argument("--listen", type=_parse_listen, default=None, help="loopback host:port to serve on")
    parser.add_argument("--unix", default=None, help="unix socket path to serve on (bound into the sandbox)")
    parser.add_argument("--allow", action="append", default=[], help="host:port admitted for CONNECT (repeatable)")
    args = parser.parse_args(argv)
    if not args.allow:
        parser.error("at least one --allow host:port is required; an empty allowlist admits nothing and serves no one")
    allowlist = Allowlist.parse(args.allow)

    async def run() -> None:
        servers = await serve(listen=args.listen, unix_socket=args.unix, allowlist=allowlist)
        _decision(event="egress_proxy_started", listen=args.listen, unix=args.unix, allow=sorted(f"{h}:{p}" for h, p in allowlist.targets))
        await asyncio.gather(*(server.serve_forever() for server in servers))

    try:
        asyncio.run(run())
    except KeyboardInterrupt:
        return 0
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
