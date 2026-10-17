"""ARIA-HIGH-143 / ARIA-HIGH-528 — the provider's road out of a room, at the room's door.

A room that reaches its provider has its own network namespace: loopback and
nothing else. Bound into it at a fixed path is the unix socket of the
kernel's allowlist proxy (``egress_proxy``), served OUTSIDE by the process
that built the room. The CLIs speak HTTP ``CONNECT`` over TCP through
``HTTPS_PROXY`` — not over a unix socket — so this program, run as the
room's first process, stands between the two:

1. it binds a TCP listener on the namespace's own loopback (an ephemeral
   port — nothing else in the room can hold it first);
2. it names that listener in ``HTTPS_PROXY`` and ``HTTP_PROXY`` (both
   spellings) and keeps loopback itself off the proxy (``NO_PROXY``),
   whatever environment the room was handed — so no wrapper's
   ``--clearenv`` and no host value can leave the command a proxy the room
   cannot reach;
3. it forks the relay — each accepted connection piped byte for byte to the
   proxy's socket — and EXECS the command in its own place, so the command
   keeps the room's pid, stdio, signals and exit status.

The relay is not the boundary: the namespace is, and the proxy outside
decides every target. A command that kills the relay only cuts itself off.
The relay dies with the command (``PR_SET_PDEATHSIG``, and with the pid
namespace's init where the room has one) and holds none of its stdio, so a
reader waiting for the command's output never waits on it.

Standard library only, run BY PATH under ``-I``: ``implementation_safety``
binds this one file read-only into the room, so nothing is imported from the
agent's tree.

Usage: ``egress_relay.py <proxy-socket> -- <command> [args...]``
"""
from __future__ import annotations

import ctypes
import os
import signal
import socket
import sys
import threading
from typing import Any

LOOPBACK = "127.0.0.1"
PROXY_ENV_NAMES: tuple[str, ...] = ("HTTPS_PROXY", "HTTP_PROXY", "https_proxy", "http_proxy")
NO_PROXY_ENV_NAMES: tuple[str, ...] = ("NO_PROXY", "no_proxy")
NO_PROXY = "localhost,127.0.0.1,::1"
PROXY_UNREACHABLE = (
    b"HTTP/1.1 502 Bad Gateway\r\nContent-Type: text/plain\r\nConnection: close\r\n\r\n"
    b"egress_refused:proxy_unreachable\n"
)
_PR_SET_PDEATHSIG = 1
_CHUNK = 65536
_HEAD_LIMIT = 8192  # the proxy's own MAX_HEADER_BYTES
_HEAD_TIMEOUT_SECONDS = 10.0


def _pump(source: socket.socket, sink: socket.socket) -> None:
    try:
        while True:
            chunk = source.recv(_CHUNK)
            if not chunk:
                break
            sink.sendall(chunk)
    except OSError:
        pass
    finally:
        try:
            sink.shutdown(socket.SHUT_WR)
        except OSError:
            pass


def _read_request_head(client: socket.socket) -> None:
    client.settimeout(_HEAD_TIMEOUT_SECONDS)
    head = b""
    while b"\r\n\r\n" not in head and len(head) < _HEAD_LIMIT:
        chunk = client.recv(_CHUNK)
        if not chunk:
            break
        head += chunk


def _relay(client: socket.socket, proxy_socket: str) -> None:
    upstream = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    try:
        try:
            upstream.connect(proxy_socket)
        except OSError:
            # The client asked for a tunnel; it is owed an answer by name,
            # not a reset it would read as the provider's. Its request is
            # read first: a socket closed with unread bytes is RESET by the
            # kernel, and the answer is lost with it.
            _read_request_head(client)
            client.sendall(PROXY_UNREACHABLE)
            return
        back = threading.Thread(target=_pump, args=(upstream, client), daemon=True)
        back.start()
        _pump(client, upstream)
        back.join()
    except OSError:
        pass
    finally:
        upstream.close()
        client.close()


def _serve(listener: socket.socket, proxy_socket: str) -> None:
    while True:
        try:
            client, _ = listener.accept()
        except ConnectionAbortedError:
            continue
        except OSError:
            return  # the door closes; the room is cut off, never opened
        threading.Thread(target=_relay, args=(client, proxy_socket), daemon=True).start()


def _become_relay(listener: socket.socket, proxy_socket: str, command_pid: int, prctl: Any) -> None:
    """The forked child: die with the command, hold none of its fds, serve.

    Never returns: whatever happens here ends in ``os._exit``, so the child
    can never fall through to the parent's ``exec`` and run the command a
    second time. ``prctl`` is resolved in the parent (``signing_agent``'s
    rule: no ``dlopen`` after a fork)."""
    try:
        if prctl(_PR_SET_PDEATHSIG, signal.SIGKILL, 0, 0, 0) != 0:
            return
        if os.getppid() != command_pid:  # the command is already gone
            return
        devnull = os.open(os.devnull, os.O_RDWR)
        for fd in (0, 1, 2):
            os.dup2(devnull, fd)
        keep = listener.fileno()
        os.closerange(3, keep)
        os.closerange(keep + 1, os.sysconf("SC_OPEN_MAX"))
        _serve(listener, proxy_socket)
    finally:
        os._exit(0)


def main(argv: list[str]) -> int:
    if len(argv) < 3 or argv[1] != "--":
        sys.stderr.write("usage: egress_relay.py <proxy-socket> -- <command> [args...]\n")
        return 2
    proxy_socket, command = argv[0], argv[2:]
    listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    listener.bind((LOOPBACK, 0))
    listener.listen(64)
    proxy_url = f"http://{LOOPBACK}:{listener.getsockname()[1]}"
    for name in PROXY_ENV_NAMES:
        os.environ[name] = proxy_url
    for name in NO_PROXY_ENV_NAMES:
        os.environ[name] = NO_PROXY
    command_pid = os.getpid()
    prctl = ctypes.CDLL(None, use_errno=True).prctl
    if os.fork() == 0:
        _become_relay(listener, proxy_socket, command_pid, prctl)
    listener.close()
    try:
        os.execvp(command[0], command)
    except OSError as exc:
        sys.stderr.write(f"egress_relay: cannot exec {command[0]!r}: {exc}\n")
    return 127


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
