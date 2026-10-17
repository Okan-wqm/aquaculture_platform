"""ARIA-MEDIUM-563 — the provider gateway: a room reaches its provider only as
the kernel, and only for the requests the kernel pins.

The kernel's CONNECT proxy used to admit the provider's host to every room as
opaque TLS, and the room held the managed login. Whatever credential a
process in the room brought — the operator's token it could read, or its own
key — reached the provider. This gateway replaces that road for a
``gateway`` route (``provider_routes``): it is served by the kernel on a unix
socket bound into the room, speaks plain HTTP/1.1 there, and for each
request:

1. reads the head under a size cap and refuses request-smuggling shapes by
   name — ``Transfer-Encoding`` on a request, a missing, duplicate or
   malformed ``Content-Length``, an absolute-form target, a folded header;
2. forwards only the route's pinned ``(method, path)`` pairs with a pinned
   query; everything else (``/v1/files``, batches, the OAuth endpoints, a
   ``CONNECT``) is refused ``request_not_pinned`` before any upstream;
3. refuses the body features that make the provider fetch something on the
   room's behalf: ``mcp_servers``, ``container``, a tool whose ``type`` is
   not a client tool's, a content ``source`` that is a URL or a file, a file
   reference anywhere;
4. drops every credential and hop-by-hop header the room sent, injects the
   kernel's credential (read per request from ``provider_credentials``) and
   the beta it needs, and forwards over TLS to the pinned upstream with
   certificate and host verification;
5. streams the response back unchanged except for ``Connection: close`` —
   one request per connection.

A missing or loose credential is answered 503 by name without contacting the
upstream. One JSON decision line per request goes to the kernel's stderr:
the verdict, the reason, the method and path, sizes, whether the room
presented a credential, the credential's source and the upstream status —
never a header or body value.

Standard library only — a decision here must be readable by an operator in
one screen per step.
"""
from __future__ import annotations

import asyncio
import json
import os
import re
import ssl
import sys
import time
from typing import Any, Awaitable, Callable, Mapping

from .provider_credentials import (
    KERNEL_CHECKOUT_ROOT,
    ProviderCredential,
    ProviderCredentialUnavailable,
    read_provider_credential,
)
from .provider_routes import GATEWAY, ProviderRoute

MAX_HEAD_BYTES = 32 * 1024
MAX_BODY_BYTES = 32 * 1024 * 1024
HEAD_TIMEOUT_SECONDS = 30.0
BODY_TIMEOUT_SECONDS = 120.0
CONNECT_TIMEOUT_SECONDS = 20.0
IDLE_TIMEOUT_SECONDS = 600.0
_CHUNK = 65536

# Headers the room never gets to send upstream: every credential it could
# present, and the hop-by-hop headers this hop owns.
ROOM_CREDENTIAL_HEADERS = frozenset({"authorization", "x-api-key", "proxy-authorization", "cookie"})
HOP_BY_HOP_HEADERS = frozenset({
    "host", "content-length", "connection", "keep-alive", "transfer-encoding", "te", "trailer", "upgrade",
    "expect", "proxy-connection",
})
# The tool types a request may declare: a client tool the CLI runs itself.
# A server tool (web_fetch_*, web_search_*, code_execution_*, …) makes the
# provider act for the room.
CLIENT_TOOL_TYPES = frozenset({"custom"})
# Content sources the provider reads from the request itself. `url` and
# `file` make it fetch an attacker URL or an uploaded file.
INLINE_SOURCE_TYPES = frozenset({"base64", "text", "content"})
REFUSED_BODY_FIELDS = ("mcp_servers", "container")
_TOKEN = re.compile(r"^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$")

Opener = Callable[[str, int], Awaitable[tuple[asyncio.StreamReader, asyncio.StreamWriter]]]
CredentialSource = Callable[[], ProviderCredential]
Decide = Callable[..., None]


class Refusal(Exception):
    """A request the gateway answers by name, never forwarded."""

    def __init__(self, status: str, reason: str) -> None:
        super().__init__(reason)
        self.status = status
        self.reason = reason


def write_decision(**fields: object) -> None:
    sys.stderr.write(json.dumps({"ts": time.time(), "event": "provider_gateway_decision", **fields},
                                sort_keys=True) + "\n")
    sys.stderr.flush()


async def open_tls_upstream(host: str, port: int) -> tuple[asyncio.StreamReader, asyncio.StreamWriter]:
    """TLS to the pinned host with the system's trust store; the name is verified."""
    context = ssl.create_default_context()
    return await asyncio.open_connection(host, port, ssl=context, server_hostname=host, limit=_CHUNK * 2)


def kernel_credential(route: ProviderRoute, environ: Mapping[str, str] | None = None) -> CredentialSource:
    """The route's credential, re-read from the kernel's boundary on every request."""
    return lambda: read_provider_credential(route.key, os.environ if environ is None else environ,
                                            room_trees=(KERNEL_CHECKOUT_ROOT,))


def refuse_body_reason(document: Any) -> str | None:
    """Why this Messages body would make the provider act beyond the model, or None."""
    if not isinstance(document, dict):
        return "body_not_object"
    for name in REFUSED_BODY_FIELDS:
        if name in document:
            return f"body_field:{name}"
    tools = document.get("tools", [])
    if not isinstance(tools, list):
        return "body_tools_not_list"
    for tool in tools:
        if not isinstance(tool, dict):
            return "body_tool_not_object"
        kind = tool.get("type", "custom")
        if kind not in CLIENT_TOOL_TYPES:
            return f"server_tool:{str(kind)[:60]}"
    return _content_reason(document.get("messages")) or _content_reason(document.get("system"))


def _content_reason(node: Any) -> str | None:
    if isinstance(node, list):
        for item in node:
            reason = _content_reason(item)
            if reason:
                return reason
        return None
    if not isinstance(node, dict):
        return None
    if "file_id" in node:
        return "file_reference"
    if node.get("type") == "container_upload":
        return "content_block:container_upload"
    source = node.get("source")
    if isinstance(source, dict) and source.get("type") not in INLINE_SOURCE_TYPES:
        return f"content_source:{str(source.get('type'))[:60]}"
    for value in node.values():
        reason = _content_reason(value)
        if reason:
            return reason
    return None


def _parse_head(head: bytes) -> tuple[str, str, list[tuple[str, str]]]:
    """(method, target, headers) of a request head, or a refusal by name."""
    try:
        text = head.decode("ascii")
    except UnicodeDecodeError:
        raise Refusal("400 Bad Request", "head_not_ascii") from None
    lines = text[:-4].split("\r\n")
    parts = lines[0].split(" ")
    if len(parts) != 3 or parts[2] not in ("HTTP/1.1", "HTTP/1.0") or not _TOKEN.match(parts[0]):
        raise Refusal("400 Bad Request", "request_line_malformed")
    headers: list[tuple[str, str]] = []
    for line in lines[1:]:
        name, sep, value = line.partition(":")
        if not sep or not _TOKEN.match(name):
            # A folded continuation (leading whitespace) or a name with
            # whitespace before the colon: two parsers could read it two ways.
            raise Refusal("400 Bad Request", "header_malformed")
        headers.append((name.lower(), value.strip(" \t")))
    return parts[0], parts[1], headers


def _body_length(headers: list[tuple[str, str]]) -> int:
    if any(name == "transfer-encoding" for name, _ in headers):
        raise Refusal("400 Bad Request", "transfer_encoding_on_request")
    lengths = [value for name, value in headers if name == "content-length"]
    if not lengths:
        raise Refusal("411 Length Required", "content_length_missing")
    if len(lengths) > 1:
        raise Refusal("400 Bad Request", "content_length_duplicate")
    if not lengths[0].isdigit():
        raise Refusal("400 Bad Request", "content_length_invalid")
    length = int(lengths[0])
    if length > MAX_BODY_BYTES:
        raise Refusal("413 Content Too Large", "body_too_large")
    return length


def _upstream_head(route: ProviderRoute, upstream: tuple[str, int], method: str, target: str,
                   headers: list[tuple[str, str]], credential: ProviderCredential, body_length: int) -> bytes:
    host, port = upstream
    betas = [member.strip() for name, value in headers if name == "anthropic-beta"
             for member in value.split(",") if member.strip()]
    if route.required_beta and route.required_beta not in betas:
        betas.append(route.required_beta)
    lines = [f"{method} {target} HTTP/1.1", f"host: {host}" if port == 443 else f"host: {host}:{port}"]
    lines += [f"{name}: {value}" for name, value in headers
              if name not in ROOM_CREDENTIAL_HEADERS and name not in HOP_BY_HOP_HEADERS and name != "anthropic-beta"]
    if betas:
        lines.append("anthropic-beta: " + ",".join(dict.fromkeys(betas)))
    lines += [f"{route.auth_header}: {credential.header_value(route.auth_scheme)}",
              f"content-length: {body_length}", "connection: close"]
    return ("\r\n".join(lines) + "\r\n\r\n").encode("latin-1")


def _response_head(head: bytes) -> tuple[bytes, str]:
    """The upstream's response head with ``Connection: close``, and its status code."""
    lines = head[:-4].split(b"\r\n")
    status = lines[0].split(b" ")[1].decode("ascii", "replace") if len(lines[0].split(b" ")) > 1 else ""
    kept = [line for line in lines[1:]
            if line.split(b":", 1)[0].strip().lower() not in (b"connection", b"keep-alive")]
    return b"\r\n".join([lines[0], *kept, b"connection: close"]) + b"\r\n\r\n", status


class ProviderGateway:
    """The gateway for one ``gateway`` route; :meth:`handle` serves one connection."""

    def __init__(self, route: ProviderRoute, *, credential: CredentialSource | None = None,
                 open_upstream: Opener = open_tls_upstream, decide: Decide = write_decision) -> None:
        if route.kind != GATEWAY or route.upstream is None:
            raise ValueError(f"provider_route_not_a_gateway:{route.key}")
        self.route = route
        self.upstream: tuple[str, int] = route.upstream
        self.credential = credential or kernel_credential(route)
        self.open_upstream = open_upstream
        self.decide = decide

    async def _refuse(self, writer: asyncio.StreamWriter, refusal: Refusal, **fields: object) -> None:
        self.decide(verdict="refused", route=self.route.key, reason=refusal.reason, **fields)
        body = f"gateway_refused:{refusal.reason}\n".encode()
        writer.write(f"HTTP/1.1 {refusal.status}\r\ncontent-type: text/plain\r\ncontent-length: {len(body)}\r\n"
                     f"connection: close\r\n\r\n".encode() + body)
        try:
            await writer.drain()
        except ConnectionError:
            pass
        writer.close()

    async def handle(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        fields: dict[str, object] = {}
        try:
            try:
                head = await asyncio.wait_for(reader.readuntil(b"\r\n\r\n"), timeout=HEAD_TIMEOUT_SECONDS)
            except asyncio.LimitOverrunError:
                raise Refusal("431 Request Header Fields Too Large", "head_too_large") from None
            except asyncio.IncompleteReadError as exc:
                # A connection closed before a whole head arrived: nothing to
                # answer. An empty one (a client's spare pooled connection) is
                # no refusal at all.
                if exc.partial:
                    self.decide(verdict="refused", route=self.route.key, reason="head_incomplete")
                writer.close()
                return
            except asyncio.TimeoutError:
                self.decide(verdict="refused", route=self.route.key, reason="head_timeout")
                writer.close()
                return
            if len(head) > MAX_HEAD_BYTES:
                raise Refusal("431 Request Header Fields Too Large", "head_too_large")
            method, target, headers = _parse_head(head)
            fields["room_presented_auth"] = any(name in ROOM_CREDENTIAL_HEADERS for name, _ in headers)
            if not target.startswith("/") or "#" in target:
                fields["request"] = f"{method} {target[:120]}"
                raise Refusal("403 Forbidden", f"request_not_pinned:{method} {target[:120]}")
            path, _, query = target.partition("?")
            fields["request"] = f"{method} {path[:120]}"
            if (method, path) not in self.route.pinned_requests or query not in self.route.pinned_queries:
                raise Refusal("403 Forbidden", f"request_not_pinned:{method} {path[:120]}")
            length = _body_length(headers)
            body = await asyncio.wait_for(reader.readexactly(length), timeout=BODY_TIMEOUT_SECONDS)
            fields["body_bytes"] = length
            try:
                document = json.loads(body)
            except ValueError:
                raise Refusal("400 Bad Request", "body_not_json") from None
            reason = refuse_body_reason(document)
            if reason:
                raise Refusal("403 Forbidden", reason)
            try:
                credential = self.credential()
            except ProviderCredentialUnavailable as exc:
                raise Refusal("503 Service Unavailable", f"provider_credential_unavailable:{exc.reason}") from None
            fields["credential_source"] = f"kernel_{credential.source}"
        except Refusal as refusal:
            await self._refuse(writer, refusal, **fields)
            return
        except (asyncio.IncompleteReadError, asyncio.TimeoutError):
            self.decide(verdict="refused", route=self.route.key, reason="body_incomplete", **fields)
            writer.close()
            return
        await self._forward(reader, writer, method, target, headers, body, credential, fields)

    async def _forward(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter, method: str, target: str,
                       headers: list[tuple[str, str]], body: bytes, credential: ProviderCredential,
                       fields: dict[str, object]) -> None:
        host, port = self.upstream
        try:
            upstream_reader, upstream_writer = await asyncio.wait_for(
                self.open_upstream(host, port), timeout=CONNECT_TIMEOUT_SECONDS)
        except (OSError, asyncio.TimeoutError, ssl.SSLError) as exc:
            await self._refuse(writer, Refusal("502 Bad Gateway", f"upstream_unreachable:{type(exc).__name__}"),
                               **fields)
            return
        try:
            request = _upstream_head(self.route, self.upstream, method, target, headers, credential, len(body))
            upstream_writer.write(request + body)
            await upstream_writer.drain()
            head = await asyncio.wait_for(upstream_reader.readuntil(b"\r\n\r\n"), timeout=IDLE_TIMEOUT_SECONDS)
            response_head, status = _response_head(head)
            self.decide(verdict="admitted", route=self.route.key, upstream_status=status, **fields)
            writer.write(response_head)
            await writer.drain()
            await _stream(upstream_reader, writer, reader)
        except (OSError, asyncio.TimeoutError, asyncio.IncompleteReadError, asyncio.LimitOverrunError) as exc:
            self.decide(verdict="upstream_failed", route=self.route.key, error=type(exc).__name__, **fields)
        finally:
            for stream in (upstream_writer, writer):
                try:
                    stream.close()
                except Exception:  # pragma: no cover - best effort on a dying pipe
                    pass


async def _stream(upstream: asyncio.StreamReader, writer: asyncio.StreamWriter, client: asyncio.StreamReader) -> None:
    """Upstream bytes to the room until either side ends: the upstream's end of
    the response, or the room closing its connection."""
    async def pump() -> None:
        while True:
            chunk = await asyncio.wait_for(upstream.read(_CHUNK), timeout=IDLE_TIMEOUT_SECONDS)
            if not chunk:
                return
            writer.write(chunk)
            await writer.drain()

    async def client_gone() -> None:
        while await client.read(_CHUNK):
            pass

    tasks = [asyncio.ensure_future(pump()), asyncio.ensure_future(client_gone())]
    done, pending = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
    for task in pending:
        task.cancel()
    await asyncio.gather(*pending, return_exceptions=True)
    for task in done:
        task.result()


__all__ = [
    "CLIENT_TOOL_TYPES", "HOP_BY_HOP_HEADERS", "INLINE_SOURCE_TYPES", "MAX_BODY_BYTES", "MAX_HEAD_BYTES",
    "ProviderGateway", "REFUSED_BODY_FIELDS", "ROOM_CREDENTIAL_HEADERS", "Refusal", "kernel_credential",
    "open_tls_upstream", "refuse_body_reason", "write_decision",
]
