"""Plan 033 Faz 033f — the policy proxy: the single egress path for active probes.

WHY: even a typed executor must not be able to reach anything the grant did not
name. The engine re-validates the grant on EVERY hop (request, redirect, retry):
scheme, exact host allowlist, DNS answer pinned to the first-seen IP set (rebinding
→ deny), metadata/loopback/link-local/production/out-of-lab addresses (via
scope_policy), body size, atomic budget, GraphQL effect catalog (unknown mutation
root field or persisted query → deny), no credential forwarding across origins,
redirect depth. `stop()` is the kill switch: afterwards every decision is DENY.
The forward proxy below is the enforcement runtime; its dialer is a seam so tests
can run it on loopback without ever touching a real network.
"""
from __future__ import annotations

import http.client
import json
import re
import socket
import threading
from dataclasses import dataclass
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Callable
from urllib.parse import urlsplit

from .grant import GrantClaims, verify_grant
from .scope_policy import MAX_BODY_BYTES, MAX_RESPONSE_BYTES, Budget, DenyInventory, classify_target

MAX_REDIRECT_HOPS = 3
_GQL_OP = re.compile(r"^\s*(query|mutation|subscription)?\s*[A-Za-z_0-9]*\s*(\([^)]*\))?\s*\{\s*([A-Za-z_][A-Za-z_0-9]*)", re.S)
_HOP_HEADERS = {"connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailers", "transfer-encoding", "upgrade", "host", "content-length"}
_CREDENTIAL_HEADERS = {"authorization", "cookie", "x-api-key"}
Resolver = Callable[[str], tuple[str, ...]]


@dataclass(frozen=True)
class Decision:
    allow: bool
    reason: str
    pinned_ip: str | None = None


def graphql_effect(body: bytes) -> tuple[str, str] | None:
    """(operation_type, root_field) for a GraphQL body, or None if not GraphQL JSON."""
    try:
        doc = json.loads(body.decode("utf-8"))
    except (ValueError, UnicodeDecodeError):
        return None
    if not isinstance(doc, dict):
        return None
    if "extensions" in doc and isinstance(doc["extensions"], dict) and "persistedQuery" in doc["extensions"]:
        return ("persisted", "*")
    query = doc.get("query")
    if not isinstance(query, str):
        return None
    m = _GQL_OP.match(query)
    if not m:
        return ("unparseable", "*")
    return ((m.group(1) or "query").lower(), m.group(3))


class PolicyEngine:
    def __init__(self, *, grant: GrantClaims, inventory: DenyInventory, resolver: Resolver,
                 allowed_graphql_effects: tuple[str, ...] = (), clock: Callable[[], datetime] | None = None) -> None:
        self.grant = grant
        self.inventory = inventory
        self.resolver = resolver
        self.allowed_graphql_effects = tuple(allowed_graphql_effects)
        self.budget = Budget(grant.risk_class)
        self._clock = clock or (lambda: datetime.now(timezone.utc))
        self._pins: dict[str, tuple[str, ...]] = {}
        self._stopped = False
        self._lock = threading.Lock()
        self.decisions: list[Decision] = []

    @classmethod
    def from_token(cls, token: str, public_key_raw: bytes, *, inventory: DenyInventory, resolver: Resolver,
                   allowed_graphql_effects: tuple[str, ...] = (), clock: Callable[[], datetime] | None = None,
                   expected: dict[str, Any] | None = None) -> "PolicyEngine":
        """The production path: an engine exists only for a grant that VERIFIED (signature,
        alg, window, structure, expected bindings). A forged or expired token builds nothing."""
        now = clock() if clock else None
        claims = verify_grant(token, public_key_raw, now=now, expected=expected)
        return cls(grant=claims, inventory=inventory, resolver=resolver,
                   allowed_graphql_effects=allowed_graphql_effects, clock=clock)

    def stop(self) -> None:
        with self._lock:
            self._stopped = True

    @property
    def stopped(self) -> bool:
        return self._stopped

    def decide(self, *, method: str, url: str, body: bytes = b"", headers: dict[str, str] | None = None,
               origin_host: str | None = None, hop: int = 0) -> Decision:
        d = self._decide(method=method, url=url, body=body, headers=headers or {}, origin_host=origin_host, hop=hop)
        with self._lock:
            self.decisions.append(d)
        return d

    def _decide(self, *, method: str, url: str, body: bytes, headers: dict[str, str], origin_host: str | None, hop: int) -> Decision:
        if self._stopped:
            return Decision(False, "kill switch engaged")
        now = int(self._clock().timestamp())
        if now >= self.grant.exp or now < self.grant.iat - 5:
            return Decision(False, "grant outside its validity window")
        if hop > MAX_REDIRECT_HOPS:
            return Decision(False, "redirect depth exceeded")
        parts = urlsplit(url)
        if parts.scheme not in ("http", "https") or not parts.hostname:
            return Decision(False, f"scheme/host rejected: {url!r}")
        host = parts.hostname.lower()
        if host not in self.grant.allowed_hosts:
            return Decision(False, f"host {host!r} not in grant allowed_hosts")
        if parts.username or parts.password:
            return Decision(False, "userinfo in URL rejected")
        ips = tuple(sorted(self.resolver(host)))
        pinned = self._pins.get(host)
        if pinned is not None and pinned != ips:
            return Decision(False, f"DNS answer for {host!r} changed since pin (rebinding)")
        risk, reason = classify_target(host=host, resolved_ips=ips, inventory=self.inventory, lab_network=self.grant.lab_network)
        if risk == "R4_FORBIDDEN":
            return Decision(False, reason)
        if len(body) > MAX_BODY_BYTES:
            return Decision(False, "body exceeds MAX_BODY_BYTES")
        if origin_host and origin_host != host and any(h.lower() in _CREDENTIAL_HEADERS for h in headers):
            return Decision(False, "credentials must not follow a cross-origin redirect")
        mutation = method.upper() in ("POST", "PUT", "PATCH", "DELETE")
        effect = graphql_effect(body) if parts.path.rstrip("/").endswith("graphql") else None
        if effect is not None:
            op, root = effect
            if op in ("persisted", "unparseable"):
                return Decision(False, f"graphql {op} operation rejected")
            if op == "mutation":
                if f"mutation:{root}" not in self.allowed_graphql_effects:
                    return Decision(False, f"graphql mutation {root!r} not in the grant effect catalog")
                mutation = True
            else:
                mutation = False
        ok, why = self.budget.try_consume(mutation=mutation, bytes_out=len(body))
        if not ok:
            return Decision(False, f"budget: {why}")
        self._pins.setdefault(host, ips)
        return Decision(True, "allowed within grant", pinned_ip=ips[0])


Dialer = Callable[[str, int], socket.socket]


def default_dialer(ip: str, port: int) -> socket.socket:
    return socket.create_connection((ip, port), timeout=10)


class ProxyServer:
    """Loopback forward proxy: absolute-URI requests are policy-checked, then forwarded
    to the PINNED ip via the dialer. Redirects are re-validated hop by hop."""

    def __init__(self, engine: PolicyEngine, *, dialer: Dialer = default_dialer) -> None:
        self.engine = engine
        self.dialer = dialer
        outer = self

        class Handler(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def log_message(self, *_: Any) -> None:  # silence
                return

            def _handle(self) -> None:
                length = int(self.headers.get("Content-Length") or 0)
                body = self.rfile.read(length) if length else b""
                headers = {k: v for k, v in self.headers.items() if k.lower() not in _HOP_HEADERS}
                outer._forward(self, self.command, self.path, body, headers)

            do_GET = do_POST = do_PUT = do_PATCH = do_DELETE = _handle

        self._server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self._thread = threading.Thread(target=self._server.serve_forever, daemon=True)

    @property
    def address(self) -> tuple[str, int]:
        return self._server.server_address[0], self._server.server_address[1]

    def start(self) -> None:
        self._thread.start()

    def stop(self) -> None:
        self.engine.stop()
        self._server.shutdown()
        self._server.server_close()

    def _forward(self, handler: BaseHTTPRequestHandler, method: str, url: str, body: bytes, headers: dict[str, str],
                 origin_host: str | None = None, hop: int = 0) -> None:
        decision = self.engine.decide(method=method, url=url, body=body, headers=headers, origin_host=origin_host, hop=hop)
        if not decision.allow:
            payload = json.dumps({"denied": decision.reason}).encode("utf-8")
            handler.send_response(403)
            handler.send_header("Content-Type", "application/json")
            handler.send_header("Content-Length", str(len(payload)))
            handler.end_headers()
            handler.wfile.write(payload)
            return
        parts = urlsplit(url)
        port = parts.port or (443 if parts.scheme == "https" else 80)
        try:
            sock = self.dialer(decision.pinned_ip or parts.hostname, port)
            conn = http.client.HTTPConnection(parts.hostname, port, timeout=10)
            conn.sock = sock
            path = parts.path or "/"
            if parts.query:
                path += "?" + parts.query
            conn.request(method, path, body=body, headers={**headers, "Host": parts.hostname})
            resp = conn.getresponse()
            data = resp.read(MAX_RESPONSE_BYTES + 1)
        except OSError as exc:
            payload = json.dumps({"target_unavailable": str(exc)[:120]}).encode("utf-8")
            handler.send_response(502)
            handler.send_header("Content-Length", str(len(payload)))
            handler.end_headers()
            handler.wfile.write(payload)
            return
        if resp.status in (301, 302, 303, 307, 308) and resp.getheader("Location"):
            location = resp.getheader("Location") or ""
            next_method = "GET" if resp.status == 303 else method
            self._forward(handler, next_method, location, b"" if next_method == "GET" else body, headers,
                          origin_host=parts.hostname, hop=hop + 1)
            return
        truncated = len(data) > MAX_RESPONSE_BYTES
        data = data[:MAX_RESPONSE_BYTES]
        handler.send_response(resp.status)
        for k, v in resp.getheaders():
            if k.lower() not in _HOP_HEADERS:
                handler.send_header(k, v)
        handler.send_header("Content-Length", str(len(data)))
        handler.send_header("X-ARIA-Truncated", "1" if truncated else "0")
        handler.end_headers()
        handler.wfile.write(data)


__all__ = ["MAX_REDIRECT_HOPS", "Decision", "PolicyEngine", "ProxyServer", "default_dialer", "graphql_effect"]
