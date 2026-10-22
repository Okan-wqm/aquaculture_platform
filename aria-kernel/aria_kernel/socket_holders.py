"""The kernel's per-holder socket directories, declared once and swept once.

ARIA-LOW-565 — four processes the executor holds for an implementer's window
listen on a unix socket inside a private temp directory of their own: the
ssh-agent that signs for the sandbox (``signing_agent``), the hook broker
(``hook_broker``), the MCP broker (``mcp_broker``) and the kernel egress
proxy (``egress_proxy``). Each dies with its holder, but a holder killed
outright never removes its directory, so the orchestrator's startup pass
sweeps the directories whose socket nobody answers on.

That sweep was copied verbatim into each of the four modules, differing only
in the directory prefix and the socket's name, and the orchestrator called
each copy by name: a fifth holder was swept only if its author also wrote a
fifth copy and remembered the call. Here a holder is a declaration
(``SocketHolder``); it makes its directory through it
(``SocketHolder.make_directory``), and ``prune_stale_holder_sockets`` sweeps
every declaration in ``SOCKET_HOLDERS``, which is every ``SocketHolder``
this module declares.

A holder listens on a fixed set of sockets in its directory: one for three
of them, one per room route for the egress proxy (ARIA-MEDIUM-563: the
provider gateway and the CONNECT tunnel each serve their route on a socket
named by the route's key, ``provider_routes.ROOM_ROUTE_KEYS``). The set is
the declaration's, so the sweep removes only a directory that holds nothing
but those sockets and none of them answers.
"""
from __future__ import annotations

import re
import shutil
import socket
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .provider_routes import ROOM_ROUTE_KEYS

# `tempfile.mkdtemp` appends eight characters from this alphabet.
_MKDTEMP_SUFFIX = r"[A-Za-z0-9_]{8}"


@dataclass(frozen=True)
class SocketHolder:
    """A holder's socket directory, ``<temp root>/<prefix><8 chars>/``, holding
    the sockets named in ``socket_names`` and nothing else.

    ``name`` keys the holder's summary in the orchestrator's
    ``sockets_pruned`` governance row.
    """

    name: str
    prefix: str
    socket_names: tuple[str, ...]

    def __post_init__(self) -> None:
        if not self.socket_names or len(set(self.socket_names)) != len(self.socket_names):
            raise ValueError(f"socket_holder_names_invalid:{self.name}")

    @property
    def socket_name(self) -> str:
        """The socket of a holder that listens on one; a multi-socket holder
        names each of its sockets itself (``socket_names``)."""
        if len(self.socket_names) != 1:
            raise ValueError(f"socket_holder_has_several_sockets:{self.name}")
        return self.socket_names[0]

    def make_directory(self) -> Path:
        """A new private directory for one holder's socket (mode 0700)."""
        return Path(tempfile.mkdtemp(prefix=self.prefix))

    def owns(self, entry: Path) -> bool:
        return re.fullmatch(re.escape(self.prefix) + _MKDTEMP_SUFFIX, entry.name) is not None


SIGNING_AGENT = SocketHolder(name="signing_agents", prefix="aria-sa-", socket_names=("agent",))
HOOK_BROKER = SocketHolder(name="hook_brokers", prefix="aria-hb-", socket_names=("sock",))
MCP_BROKER = SocketHolder(name="mcp_brokers", prefix="aria-mb-", socket_names=("sock",))
# One socket per room route, named by the route's key (ARIA-MEDIUM-563).
EGRESS_PROXY = SocketHolder(name="egress_proxies", prefix="aria-ep-", socket_names=ROOM_ROUTE_KEYS)
# ARIA-MEDIUM-583 — the GitHub App token broker a LANE starts (a sibling of
# the cycle/executor process, not their child), so it is swept like every
# other holder even though its holder process is the workflow step's, not
# the orchestrator's: a broker the runner fails to reap leaves a socket
# directory whose socket no longer answers.
TOKEN_BROKER = SocketHolder(name="token_brokers", prefix="aria-tb-", socket_names=("sock",))

SOCKET_HOLDERS: tuple[SocketHolder, ...] = tuple(
    value for value in tuple(globals().values()) if isinstance(value, SocketHolder)
)


def socket_answers(socket_path: Path) -> bool:
    """Whether something listens on the unix socket ``socket_path`` (1 s bound)."""
    client = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    try:
        client.settimeout(1.0)
        client.connect(str(socket_path))
        return True
    except OSError:
        return False
    finally:
        client.close()


def prune_stale_socket_dirs(holder: SocketHolder, *, temp_root: str | Path | None = None) -> dict[str, Any]:
    """Remove ``holder``'s directories none of whose sockets answers.

    A directory one of whose sockets still answers belongs to a live holder
    and is left alone; one holding anything but the holder's sockets is not
    the holder's to remove.
    """
    root = Path(temp_root) if temp_root is not None else Path(tempfile.gettempdir())
    swept: list[str] = []
    live: list[str] = []
    errors: list[str] = []
    for entry in sorted(root.glob(f"{holder.prefix}*")):
        if not entry.is_dir() or not holder.owns(entry):
            continue
        sockets = [entry / name for name in holder.socket_names]
        if any(path.is_socket() and socket_answers(path) for path in sockets):
            live.append(entry.name)
            continue
        try:
            if any(child.name not in holder.socket_names for child in entry.iterdir()):
                continue
            shutil.rmtree(entry)
        except OSError as exc:
            errors.append(f"{entry.name}:{type(exc).__name__}")
        else:
            swept.append(entry.name)
    return {"scanned": len(swept) + len(live) + len(errors), "swept": swept, "live": live, "errors": errors}


def prune_stale_holder_sockets(*, temp_root: str | Path | None = None) -> dict[str, dict[str, Any]]:
    """Every declared holder's sweep, keyed by ``SocketHolder.name``."""
    return {holder.name: prune_stale_socket_dirs(holder, temp_root=temp_root) for holder in SOCKET_HOLDERS}


__all__ = [
    "EGRESS_PROXY",
    "HOOK_BROKER",
    "MCP_BROKER",
    "SIGNING_AGENT",
    "SOCKET_HOLDERS",
    "TOKEN_BROKER",
    "SocketHolder",
    "prune_stale_holder_sockets",
    "prune_stale_socket_dirs",
    "socket_answers",
]
