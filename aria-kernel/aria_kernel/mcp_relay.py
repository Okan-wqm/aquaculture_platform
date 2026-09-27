"""ARIA-HIGH-124 — the `aria` MCP server's stdio end INSIDE the sandbox: a relay, not a server.

WHY this module exists
----------------------
The `implementer`, `planner` and `validator` profiles load the kernel's
`aria` MCP server, and the registry used to spawn it INSIDE the agent's
sandbox as ``python3 -m aria_kernel mcp serve`` with ``ARIA_TOOLS_DIR``
passed through. The durable state store is not mounted in the sandbox
(ARIA-HIGH-123, on purpose), so the server bootstrapped a phantom store on
bwrap's root tmpfs and served an empty view; it also journaled its calls
into that phantom, and ``python3 -m aria_kernel`` resolved the package from
the agent's own cwd first, so a package the agent wrote into its worktree
would have been the server.

WHAT this module does
---------------------
It is the thinnest possible stdio end: it pumps the CLI's newline-delimited
JSON-RPC from stdin to the kernel-side MCP broker (``mcp_broker``) over the
unix socket named by ``ARIA_MCP_BROKER_SOCKET`` — bound into the sandbox by
the wrapper at a fixed path — and pumps the broker's answers back to stdout.
The server that answers (``mcp_server.AriaMcpServer``) runs OUTSIDE, in the
executor process, against the real store, read-only tools only. This file
imports nothing but the standard library and is run BY PATH
(``<python> <kernel_root>/aria_kernel/mcp_relay.py``), so no kernel package
is imported inside the sandbox for the MCP view.

Fail-closed: when the broker cannot be reached (no socket in the
environment, a connect failure) every request that carries an ``id`` is
answered with a JSON-RPC error naming the cause (``mcp_broker_unreachable:
<why>``), so the CLI sees an explicit refusal rather than a hung server.
"""
from __future__ import annotations

import json
import os
import socket
import sys
import threading
from typing import IO

MCP_BROKER_SOCKET_ENV = "ARIA_MCP_BROKER_SOCKET"
# A JSON-RPC 2.0 server-defined error code (the -32000..-32099 range).
BROKER_UNREACHABLE_ERROR_CODE = -32000
_READ_CHUNK = 65536


def _error_reply(message_line: str, reason: str) -> str | None:
    """The JSON-RPC error for one request line, or None for a notification
    (a message without an id gets no reply by the protocol)."""
    try:
        message = json.loads(message_line)
    except ValueError:
        return json.dumps({"jsonrpc": "2.0", "id": None, "error": {"code": -32700, "message": "parse error"}})
    if not isinstance(message, dict) or "id" not in message:
        return None
    return json.dumps({
        "jsonrpc": "2.0", "id": message.get("id"),
        "error": {"code": BROKER_UNREACHABLE_ERROR_CODE, "message": f"mcp_broker_unreachable:{reason}"},
    })


def _answer_unreachable(stdin: IO[str], stdout: IO[str], reason: str) -> int:
    for line in stdin:
        line = line.strip()
        if not line:
            continue
        reply = _error_reply(line, reason)
        if reply is not None:
            stdout.write(reply + "\n")
            stdout.flush()
    return 0


def _pump_to_socket(stdin: IO[str], client: socket.socket) -> None:
    try:
        for line in stdin:
            if not line.strip():
                continue
            client.sendall(line.rstrip("\n").encode("utf-8") + b"\n")
    except (OSError, ValueError):
        pass
    finally:
        try:
            client.shutdown(socket.SHUT_WR)
        except OSError:
            pass


def relay(stdin: IO[str], stdout: IO[str], socket_path: str) -> int:
    """Pump stdin to the broker and the broker's replies to stdout until
    both sides are done. Returns the process exit code."""
    client = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    try:
        client.connect(socket_path)
    except OSError as exc:
        client.close()
        return _answer_unreachable(stdin, stdout, type(exc).__name__)
    writer = threading.Thread(target=_pump_to_socket, args=(stdin, client), name="aria-mcp-relay-in", daemon=True)
    writer.start()
    try:
        while True:
            chunk = client.recv(_READ_CHUNK)
            if not chunk:
                break
            stdout.write(chunk.decode("utf-8", errors="replace"))
            stdout.flush()
    except OSError:
        pass
    finally:
        client.close()
    return 0


def main(argv: list[str], *, stdin: IO[str] | None = None, stdout: IO[str] | None = None,
         environ: dict[str, str] | None = None) -> int:
    inp = sys.stdin if stdin is None else stdin
    out = sys.stdout if stdout is None else stdout
    env = os.environ if environ is None else environ
    socket_path = env.get(MCP_BROKER_SOCKET_ENV) or ""
    if not socket_path:
        return _answer_unreachable(inp, out, "no_socket_in_environment")
    return relay(inp, out, socket_path)


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
