"""ARIA-MEDIUM-563 — how each provider is reached, in one table: the only place
a provider host is named.

A room that holds agent-run code must not be able to talk to a provider
under a credential the room brings, and must not hold the kernel's. Before
this table the kernel's CONNECT proxy admitted every provider host to every
room as opaque TLS (an injected agent reached ``api.anthropic.com`` with a
bogus key and got 401: any key it carried would have worked), and the managed
Claude login was bound into the room writable, so the room could read the
operator's OAuth token. Each row now says how its provider is reached, and
the room builder (``implementation_safety``), the kernel's listeners
(``egress_proxy.kernel_egress_sockets``), the gateway (``provider_gateway``)
and the Z.ai transport (``tools/aria-poc/zai_runtime.py``) read it here:

* ``gateway`` — the kernel serves a reverse proxy on a unix socket bound into
  the room. It pins the requests the CLI makes, refuses everything else by
  name, strips every credential the room presents and injects the kernel's.
  The room holds a placeholder credential and no road to the provider host.
  The Claude CLI uses it natively: with ``ANTHROPIC_UNIX_SOCKET`` set, its
  API fetches go over that socket, and ``ANTHROPIC_BASE_URL=http://localhost``
  makes it speak plain HTTP there (without it the CLI starts TLS on the
  socket). A non-empty ``CLAUDE_CODE_OAUTH_TOKEN`` puts it in OAuth mode, and
  nothing in the room refreshes a token any more.
* ``tunnel`` — the kernel's CONNECT proxy, with the row's own targets only,
  for a client the kernel cannot redirect (the Codex CLI; its route is not
  verified on a host with the binary, so it keeps the opaque tunnel).
* ``kernel_transport`` — the kernel talks to the provider itself, outside
  every room (Z.ai: ``zai_runtime``). No room reaches its host.

A new provider, host or path is a reviewed change to this table, never an
environment variable. The credential each provider is authenticated with is
the fleet row's (``model_fleet``), read by ``provider_credentials``.
"""
from __future__ import annotations

from dataclasses import dataclass
from types import MappingProxyType
from typing import Mapping

GATEWAY = "gateway"
TUNNEL = "tunnel"
KERNEL_TRANSPORT = "kernel_transport"

# The credential every gateway room holds in place of a real one: non-empty
# (the CLI's OAuth mode needs a value), and worth nothing — the gateway
# replaces whatever the room presents with the kernel's own.
ROOM_CREDENTIAL_PLACEHOLDER = "aria-provider-gateway-holds-the-credential"


@dataclass(frozen=True)
class ProviderRoute:
    """How one provider is reached from a room, or that it never is."""

    key: str
    kind: str
    upstream: tuple[str, int] | None = None
    """``gateway``: the one host and port the gateway forwards to (TLS, verified)."""
    pinned_requests: frozenset[tuple[str, str]] = frozenset()
    """``gateway``: the (method, path) pairs forwarded; everything else is refused."""
    pinned_queries: frozenset[str] = frozenset({""})
    """``gateway``: the exact query strings a pinned request may carry."""
    room_socket: str | None = None
    """``gateway``: where the gateway's socket is bound inside the room."""
    socket_env: str | None = None
    """``gateway``: the variable naming that socket to the client."""
    room_env: tuple[tuple[str, str], ...] = ()
    """``gateway``: the variables the room is given (besides ``socket_env``)."""
    room_unset: tuple[str, ...] = ()
    """``gateway``: credential variables removed from the room, whatever the caller handed it."""
    auth_header: str = "authorization"
    auth_scheme: str = "Bearer "
    required_beta: str | None = None
    """``gateway``: an ``anthropic-beta`` member the injected credential needs."""
    tunnel_targets: tuple[str, ...] = ()
    """``tunnel``: the ``host:port`` targets the CONNECT proxy admits for this route."""
    base_urls: Mapping[str, str] = MappingProxyType({})
    """``kernel_transport``: the base URLs the kernel's own transport may call."""


_ROUTES: tuple[ProviderRoute, ...] = (
    ProviderRoute(
        key="anthropic",
        kind=GATEWAY,
        # The Messages API (`BASE_API_URL` in the Claude CLI, 2.1.278 and 2.1.301).
        upstream=("api.anthropic.com", 443),
        pinned_requests=frozenset({("POST", "/v1/messages"), ("POST", "/v1/messages/count_tokens")}),
        # The CLI sends `?beta=true` on its Messages calls.
        pinned_queries=frozenset({"", "beta=true"}),
        room_socket="/tmp/aria-provider-anthropic.sock",
        socket_env="ANTHROPIC_UNIX_SOCKET",
        room_env=(
            ("ANTHROPIC_BASE_URL", "http://localhost"),
            ("CLAUDE_CODE_OAUTH_TOKEN", ROOM_CREDENTIAL_PLACEHOLDER),
            # Telemetry and update checks have no road out of the room.
            ("CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC", "1"),
        ),
        room_unset=(
            "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_API_KEY",
            "CLAUDE_CODE_OAUTH_REFRESH_TOKEN", "CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR",
            "CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR",
        ),
        required_beta="oauth-2025-04-20",
    ),
    ProviderRoute(
        key="openai",
        kind=TUNNEL,
        # The Codex CLI's managed ChatGPT session backend, its token refresh,
        # and the API route.
        tunnel_targets=("chatgpt.com:443", "auth.openai.com:443", "api.openai.com:443"),
    ),
    ProviderRoute(
        key="zai",
        kind=KERNEL_TRANSPORT,
        # docs.z.ai/devpack/tool/others (2026-09-11): the Coding-Plan route
        # draws the subscription quota, the general route the prepaid wallet.
        base_urls=MappingProxyType({
            "coding": "https://api.z.ai/api/coding/paas/v4",
            "general": "https://api.z.ai/api/paas/v4",
        }),
    ),
)
ROUTES: Mapping[str, ProviderRoute] = MappingProxyType({route.key: route for route in _ROUTES})
# The routes a room can be handed (a kernel transport is reached by no room).
ROOM_ROUTE_KEYS: tuple[str, ...] = tuple(route.key for route in _ROUTES if route.kind in (GATEWAY, TUNNEL))


def route(key: str) -> ProviderRoute:
    """The route for ``key``; a provider the table does not list has none."""
    try:
        return ROUTES[key]
    except KeyError:
        raise KeyError(f"provider_route_unknown:{key}") from None


def room_route(key: str) -> ProviderRoute:
    """The route for a room, refused by name when no room may take it."""
    found = route(key)
    if found.key not in ROOM_ROUTE_KEYS:
        raise KeyError(f"provider_route_not_for_rooms:{key}")
    return found


def tunnel_allowlist(key: str) -> tuple[str, ...]:
    """The CONNECT targets of a tunnel route — the proxy's whole allowlist for it."""
    found = route(key)
    if found.kind != TUNNEL:
        raise KeyError(f"provider_route_not_a_tunnel:{key}")
    return found.tunnel_targets


def gateway_environment(key: str, socket_path: str) -> dict[str, str]:
    """What a client of a gateway route is given: the socket it reaches the
    gateway on, and the route's variables (the placeholder credential among
    them). The room names its bound path; a spawn outside a room names the
    kernel's own socket."""
    found = route(key)
    if found.kind != GATEWAY or found.socket_env is None:
        raise KeyError(f"provider_route_not_a_gateway:{key}")
    return {found.socket_env: socket_path, **dict(found.room_env)}


__all__ = [
    "GATEWAY", "KERNEL_TRANSPORT", "ROOM_CREDENTIAL_PLACEHOLDER", "ROOM_ROUTE_KEYS", "ROUTES", "TUNNEL",
    "ProviderRoute", "gateway_environment", "room_route", "route", "tunnel_allowlist",
]
