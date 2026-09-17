"""ARIA-HIGH-123 — an AF_UNIX listener for fixtures that need "a socket exists".

The git containment derivation refuses a signing exposure whose agent socket
is not a socket (`signing_agent_socket_missing`); pins that exercise the
derivation without holding a real ssh-agent need a bound unix socket and
nothing more. It is created here, once, so no test module constructs a
socket itself: `tests/test_no_external_network_in_aria_kernel_tests.py`
bans direct socket construction in test modules (a corporate mirror or an
air-gapped checkout must never see a test reach the network), and an
AF_UNIX listener on a path under the test's own temp dir is the one shape
that reaches nothing — named on the line the invariant reads.
"""
from __future__ import annotations

import socket
from contextlib import contextmanager
from pathlib import Path
from typing import Iterator


@contextmanager
def bound_unix_socket(path: str | Path) -> Iterator[Path]:
    """Bind an AF_UNIX listener at ``path`` (parents created) for the body;
    the listener is closed and the file removed on exit."""
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)  # allowlist-external-network: AF_UNIX fixture listener on a temp path, no network
    try:
        listener.bind(str(target))
        listener.listen(1)
        yield target
    finally:
        listener.close()
        target.unlink(missing_ok=True)


__all__ = ["bound_unix_socket"]
