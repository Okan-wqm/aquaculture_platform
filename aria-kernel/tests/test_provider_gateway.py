"""ARIA-MEDIUM-563 — the provider gateway forwards pinned requests under the
kernel's credential and refuses everything else by name, before any upstream.

The gateway is driven over a real unix socket, as a room reaches it. The
upstream is injected (London school): an opener that records each call and
connects to a recording server on the host's loopback. Every refusal also
asserts the opener was never called — "refused" means nothing left the
kernel. Credential-shaped fixtures are built from parts, so no line of this
file is a detection shape.
"""
from __future__ import annotations

import asyncio
import io
import json
import os
import ssl
import tempfile
import unittest
from contextlib import redirect_stderr
from pathlib import Path
from unittest import mock

from aria_kernel import provider_gateway as gw
from aria_kernel import secret_scrub
from aria_kernel.provider_credentials import ProviderCredential, ProviderCredentialUnavailable
from aria_kernel.provider_routes import route

# ARIA-HIGH-138 — the seam(s) this file proves by a real process, per
# the closed registry in tests/invariants/seam_registry.py.
REAL_PROCESS_SEAMS = (
    "aria-kernel/aria_kernel/provider_gateway.py",
)

KERNEL_TOKEN = "sk-ant" + "-oat01-" + "K" * 48
ROOM_TOKEN = "sk-ant" + "-api03-" + "R" * 48
MESSAGES_BODY = json.dumps({"model": "claude-opus", "max_tokens": 5,
                            "messages": [{"role": "user", "content": "hi"}]}).encode()


def _request(method: str, target: str, body: bytes = MESSAGES_BODY, *, headers: tuple[str, ...] = (),
             length: bool = True) -> bytes:
    lines = [f"{method} {target} HTTP/1.1", "host: localhost", *headers]
    if length:
        lines.append(f"content-length: {len(body)}")
    return ("\r\n".join(lines) + "\r\n\r\n").encode() + body


class _Upstream:
    """A recording HTTP server on loopback; ``chunks`` is what it answers."""

    def __init__(self, chunks: list[bytes]) -> None:
        self.chunks = chunks
        self.requests: list[bytes] = []

    async def start(self) -> None:
        self.server = await asyncio.start_server(self._serve, host="127.0.0.1", port=0)
        self.port = self.server.sockets[0].getsockname()[1]

    async def _serve(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        head = await reader.readuntil(b"\r\n\r\n")
        length = next(int(line.split(b":", 1)[1]) for line in head.split(b"\r\n")
                      if line.lower().startswith(b"content-length:"))
        self.requests.append(head + await reader.readexactly(length))
        for chunk in self.chunks:
            writer.write(chunk)
            await writer.drain()
            await asyncio.sleep(0)
        writer.close()


class _Harness:
    """The gateway on a unix socket, its opener recording every call."""

    def __init__(self, *, chunks: list[bytes] | None = None, credential=None) -> None:
        self.upstream = _Upstream(chunks or [b"HTTP/1.1 200 OK\r\ncontent-length: 2\r\nconnection: keep-alive\r\n\r\nok"])
        self.opened: list[tuple[str, int]] = []
        self.decisions: list[dict] = []
        self.credential = credential or (lambda: ProviderCredential(
            provider="anthropic", source="file", location="/fixture", _secret=KERNEL_TOKEN))

    async def opener(self, host: str, port: int):
        self.opened.append((host, port))
        return await asyncio.open_connection("127.0.0.1", self.upstream.port)

    async def __aenter__(self) -> "_Harness":
        await self.upstream.start()
        self.gateway = gw.ProviderGateway(route("anthropic"), credential=self.credential, open_upstream=self.opener,
                                          decide=lambda **fields: self.decisions.append(fields))
        self.tmp = tempfile.mkdtemp(prefix="aria-gw-")
        self.path = os.path.join(self.tmp, "gw.sock")
        self.server = await asyncio.start_unix_server(self.gateway.handle, path=self.path, limit=gw.MAX_HEAD_BYTES)
        return self

    async def __aexit__(self, *exc: object) -> None:
        for server in (self.server, self.upstream.server):
            server.close()
            await server.wait_closed()
        __import__("shutil").rmtree(self.tmp, ignore_errors=True)

    async def send(self, raw: bytes) -> bytes:
        reader, writer = await asyncio.open_unix_connection(self.path)
        writer.write(raw)
        await writer.drain()
        answer = await reader.read()
        writer.close()
        return answer


def _exchange(raw: bytes, **harness) -> tuple[bytes, _Harness]:
    async def scenario() -> tuple[bytes, _Harness]:
        async with _Harness(**harness) as h:
            return await h.send(raw), h
    return asyncio.run(scenario())


class TheGatewayPinsItsRequests(unittest.TestCase):
    def assert_refused(self, raw: bytes, status: bytes, reason: str, **harness) -> _Harness:
        answer, h = _exchange(raw, **harness)
        self.assertTrue(answer.startswith(b"HTTP/1.1 " + status), answer[:200])
        self.assertIn(f"gateway_refused:{reason}".encode(), answer)
        self.assertEqual(h.opened, [], "a refused request reached the upstream opener")
        self.assertEqual(h.upstream.requests, [])
        self.assertEqual(h.decisions[-1]["verdict"], "refused")
        return h

    def test_only_the_pinned_requests_pass(self) -> None:
        for method, target in (("GET", "/v1/models"), ("POST", "/v1/files"), ("POST", "/v1/messages/batches"),
                               ("POST", "/v1/oauth/token"), ("GET", "/api/oauth/profile"),
                               ("POST", "/v1/messages/../files"), ("POST", "/v1/%6Dessages"),
                               ("GET", "/v1/messages")):
            with self.subTest(target=target):
                self.assert_refused(_request(method, target), b"403", f"request_not_pinned:{method} {target}")
        with self.subTest(query="other"):
            self.assert_refused(_request("POST", "/v1/messages?beta=false"), b"403",
                                "request_not_pinned:POST /v1/messages")
        with self.subTest(target="CONNECT"):
            self.assert_refused(_request("CONNECT", "api.anthropic.com:443"), b"403",
                                "request_not_pinned:CONNECT api.anthropic.com:443")

    def test_the_pinned_requests_are_forwarded(self) -> None:
        for target in ("/v1/messages", "/v1/messages?beta=true", "/v1/messages/count_tokens"):
            with self.subTest(target=target):
                answer, h = _exchange(_request("POST", target))
                self.assertTrue(answer.startswith(b"HTTP/1.1 200 OK"), answer)
                self.assertEqual(h.opened, [("api.anthropic.com", 443)])
                self.assertTrue(h.upstream.requests[0].startswith(f"POST {target} HTTP/1.1\r\n".encode()))
                self.assertEqual(h.decisions[-1]["verdict"], "admitted")
                self.assertEqual(h.decisions[-1]["upstream_status"], "200")

    def test_provider_side_fetches_are_refused(self) -> None:
        url_image = {"type": "image", "source": {"type": "url", "url": "https://attacker.example/?d=1"}}
        file_doc = {"type": "document", "source": {"type": "file", "file_id": "file_0"}}
        cases = (
            ("body_field:mcp_servers", {"mcp_servers": [{"type": "url", "url": "https://attacker.example/"}]}),
            ("body_field:container", {"container": "container_0"}),
            ("server_tool:web_fetch_20250910", {"tools": [{"type": "web_fetch_20250910", "name": "web_fetch"}]}),
            ("server_tool:web_search_20250305", {"tools": [{"type": "web_search_20250305", "name": "web_search"}]}),
            ("server_tool:code_execution_20250825", {"tools": [{"type": "code_execution_20250825", "name": "x"}]}),
            ("content_source:url", {"messages": [{"role": "user", "content": [url_image]}]}),
            ("content_source:url", {"system": [url_image]}),
            ("content_source:file", {"messages": [{"role": "user", "content": [file_doc]}]}),
            ("file_reference", {"messages": [{"role": "user", "content": [{"type": "image", "file_id": "file_0"}]}]}),
            ("content_block:container_upload", {"messages": [{"role": "user", "content": [
                {"type": "container_upload", "source": {"type": "base64"}}]}]}),
        )
        for reason, extra in cases:
            body = json.dumps({"model": "m", "max_tokens": 5, "messages": [], **extra}).encode()
            with self.subTest(reason=reason, fields=sorted(extra)):
                self.assert_refused(_request("POST", "/v1/messages", body), b"403", reason)

    def test_client_tools_and_inline_sources_pass(self) -> None:
        body = json.dumps({"model": "m", "max_tokens": 5, "system": [{"type": "text", "text": "s"}],
                           "tools": [{"name": "Bash", "input_schema": {"type": "object"}},
                                     {"type": "custom", "name": "Edit", "input_schema": {"type": "object"}}],
                           "messages": [{"role": "user", "content": [
                               {"type": "image", "source": {"type": "base64", "media_type": "image/png", "data": "AA"}},
                               {"type": "document", "source": {"type": "text", "media_type": "text/plain",
                                                               "data": "x"}}]}]}).encode()
        answer, h = _exchange(_request("POST", "/v1/messages", body))
        self.assertTrue(answer.startswith(b"HTTP/1.1 200"), answer)
        self.assertEqual(json.loads(h.upstream.requests[0].split(b"\r\n\r\n", 1)[1]), json.loads(body))

    def test_request_framing_is_refused(self) -> None:
        self.assert_refused(_request("POST", "/v1/messages", headers=("transfer-encoding: chunked",)), b"400",
                            "transfer_encoding_on_request")
        self.assert_refused(_request("POST", "/v1/messages", headers=(f"content-length: {len(MESSAGES_BODY)}",)),
                            b"400", "content_length_duplicate")
        self.assert_refused(_request("POST", "/v1/messages", length=False), b"411", "content_length_missing")
        self.assert_refused(_request("POST", "/v1/messages", headers=("content-length: +5",), length=False),
                            b"400", "content_length_invalid")
        self.assert_refused(_request("POST", "/v1/messages", b"not json"), b"400", "body_not_json")
        self.assert_refused(_request("POST", "/v1/messages", b"[1]"), b"403", "body_not_object")
        self.assert_refused(_request("POST", "http://api.anthropic.com/v1/messages"), b"403",
                            "request_not_pinned:POST http://api.anthropic.com/v1/messages")
        self.assert_refused(_request("POST", "/v1/messages", headers=("x-a: 1", " folded: 2")), b"400",
                            "header_malformed")
        self.assert_refused(_request("POST", "/v1/messages", headers=("x-big: " + "a" * (gw.MAX_HEAD_BYTES + 1),)),
                            b"431", "head_too_large")
        with mock.patch.object(gw, "MAX_BODY_BYTES", 16):
            self.assert_refused(_request("POST", "/v1/messages"), b"413", "body_too_large")

    def test_a_control_character_in_the_head_is_refused(self) -> None:
        # A bare LF or CR is a line end to some HTTP parsers (RFC 9112 2.2):
        # forwarded, it would let the room write header lines, or a second
        # request, next to the kernel's credential. The gateway emits no byte
        # it did not validate, so each is refused before any upstream.
        cases = {
            "lf_in_value": ("x-a: b\nauthorization: Bearer " + ROOM_TOKEN,),
            "cr_in_value": ("x-a: b\rauthorization: Bearer " + ROOM_TOKEN,),
            "nul_in_value": ("x-a: b\x00c",),
            "del_in_value": ("x-a: b\x7fc",),
            "lf_after_name": ("authorization\n: Bearer " + ROOM_TOKEN,),
            "cr_in_name": ("x-a\rb: c",),
            "smuggled_request": ("x-a: b\n\nPOST /v1/files HTTP/1.1\nhost: api.anthropic.com",),
        }
        for case, headers in cases.items():
            with self.subTest(case=case):
                self.assert_refused(_request("POST", "/v1/messages", headers=headers), b"400",
                                    "head_control_character")
        for case, target in (("lf_in_target", "/v1/messages\n"), ("nul_in_method", "/v1/messages")):
            raw = _request("POST", target)
            if case == "nul_in_method":
                raw = raw.replace(b"POST", b"PO\x00ST", 1)
            with self.subTest(case=case):
                self.assert_refused(raw, b"400", "head_control_character")
        # A tab is the one control character a header value may carry.
        answer, h = _exchange(_request("POST", "/v1/messages", headers=("x-a: b\tc",)))
        self.assertTrue(answer.startswith(b"HTTP/1.1 200"), answer)
        self.assertIn(b"\r\nx-a: b\tc\r\n", h.upstream.requests[0])

    def test_the_body_forwarded_is_the_body_checked(self) -> None:
        # Parsers disagree on a duplicate key (last wins here; another may
        # keep the first) and on a non-UTF-8 encoding: the check would judge
        # one document and the provider read another.
        server_tool_then_none = (b'{"model":"m","max_tokens":5,"messages":[],'
                                 b'"tools":[{"type":"web_fetch_20250910","name":"f"}],"tools":[]}')
        tool_type_twice = (b'{"model":"m","max_tokens":5,"messages":[],'
                           b'"tools":[{"type":"web_search_20250305","type":"custom","name":"s"}]}')
        for case, body in (("dup_tools", server_tool_then_none), ("dup_tool_type", tool_type_twice)):
            with self.subTest(case=case):
                self.assert_refused(_request("POST", "/v1/messages", body), b"400", "body_duplicate_key")
        self.assert_refused(_request("POST", "/v1/messages", MESSAGES_BODY.decode().encode("utf-16")), b"400",
                            "body_not_utf8")
        self.assert_refused(_request("POST", "/v1/messages", b'{"model":"m","max_tokens":NaN,"messages":[]}'),
                            b"400", "body_not_json")
        # What is admitted goes upstream as the checked document, serialized
        # by the gateway: no byte of the room's encoding survives.
        spaced = b'{ "model" : "m",\n "max_tokens" : 5, "messages" : [ {"role":"user","content":"\\u00e7a"} ] }'
        answer, h = _exchange(_request("POST", "/v1/messages", spaced))
        self.assertTrue(answer.startswith(b"HTTP/1.1 200"), answer)
        head, forwarded = h.upstream.requests[0].split(b"\r\n\r\n", 1)
        self.assertEqual(forwarded, json.dumps(json.loads(spaced), ensure_ascii=False,
                                               separators=(",", ":")).encode("utf-8"))
        self.assertIn(f"content-length: {len(forwarded)}".encode(), head.split(b"\r\n"))

    def test_a_room_key_is_replaced_by_the_kernels(self) -> None:
        raw = _request("POST", "/v1/messages?beta=true", headers=(
            f"authorization: Bearer {ROOM_TOKEN}", f"x-api-key: {ROOM_TOKEN}", f"cookie: s={ROOM_TOKEN}",
            f"proxy-authorization: Basic {ROOM_TOKEN}", "anthropic-beta: claude-code-20250219",
            "anthropic-version: 2023-06-01", "connection: keep-alive", "host: evil.example"))
        answer, h = _exchange(raw)
        self.assertTrue(answer.startswith(b"HTTP/1.1 200"), answer)
        forwarded = h.upstream.requests[0].decode("latin-1")
        head = forwarded.split("\r\n\r\n", 1)[0].lower().split("\r\n")
        self.assertNotIn(ROOM_TOKEN, forwarded)
        self.assertIn(f"authorization: Bearer {KERNEL_TOKEN}".lower(), head)
        self.assertEqual([line for line in head if line.startswith("authorization:")],
                         [f"authorization: bearer {KERNEL_TOKEN}".lower()])
        for name in ("x-api-key:", "cookie:", "proxy-authorization:"):
            self.assertFalse(any(line.startswith(name) for line in head), name)
        self.assertIn("host: api.anthropic.com", head)
        self.assertIn("anthropic-beta: claude-code-20250219,oauth-2025-04-20", head)
        self.assertIn("anthropic-version: 2023-06-01", head)
        self.assertIn("connection: close", head)
        self.assertTrue(h.decisions[-1]["room_presented_auth"])
        self.assertEqual(h.decisions[-1]["credential_source"], "kernel_file")

    def test_the_response_streams_back_unchanged(self) -> None:
        events = b"".join(f"event: e{i}\r\ndata: {{\"i\": {i}}}\r\n\r\n".encode() for i in range(40))
        body = b"".join(b"%x\r\n%s\r\n" % (len(events[i:i + 7]), events[i:i + 7]) for i in range(0, len(events), 7))
        body += b"0\r\n\r\n"
        head = b"HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\ntransfer-encoding: chunked\r\n" \
               b"connection: keep-alive\r\nkeep-alive: timeout=5\r\n\r\n"
        stream = head + body
        chunks = [stream[i:i + 13] for i in range(0, len(stream), 13)]
        answer, _h = _exchange(_request("POST", "/v1/messages"), chunks=chunks)
        got_head, got_body = answer.split(b"\r\n\r\n", 1)
        self.assertEqual(got_body, body)
        self.assertIn(b"transfer-encoding: chunked", got_head)
        self.assertIn(b"connection: close", got_head)
        self.assertNotIn(b"keep-alive", got_head)

    def test_a_missing_credential_is_refused_without_the_upstream(self) -> None:
        def absent() -> ProviderCredential:
            raise ProviderCredentialUnavailable("credential_file_permissions", "mode 0644", provider="anthropic")

        h = self.assert_refused(_request("POST", "/v1/messages"), b"401",
                                "provider_credential_unavailable:credential_file_permissions", credential=absent)
        # In the provider's own error shape: the CLI fails at once on an
        # authentication_error (a 503 it retries for minutes, then reads as
        # unreachable), and the kernel's classifier names it a credential fact.
        answer, _h = _exchange(_request("POST", "/v1/messages"), credential=absent)
        error = json.loads(answer.split(b"\r\n\r\n", 1)[1])
        self.assertEqual(error["type"], "error")
        self.assertEqual(error["error"]["type"], "authentication_error")
        self.assertIn(b"content-type: application/json", answer.split(b"\r\n\r\n", 1)[0])
        self.assertEqual(h.decisions[-1]["reason"], "provider_credential_unavailable:credential_file_permissions")

    def test_an_unreachable_upstream_is_a_refusal_by_name(self) -> None:
        async def scenario() -> bytes:
            async with _Harness() as h:
                async def refuse(host: str, port: int):
                    raise ConnectionRefusedError("down")
                h.gateway.open_upstream = refuse
                return await h.send(_request("POST", "/v1/messages"))
        answer = asyncio.run(scenario())
        self.assertTrue(answer.startswith(b"HTTP/1.1 502"), answer)
        self.assertIn(b"gateway_refused:upstream_unreachable:ConnectionRefusedError", answer)

    def test_the_decision_log_names_no_value(self) -> None:
        captured = io.StringIO()

        async def scenario() -> None:
            async with _Harness() as h:
                h.gateway.decide = gw.write_decision
                headers = (f"authorization: Bearer {ROOM_TOKEN}", f"x-api-key: {ROOM_TOKEN}")
                await h.send(_request("POST", "/v1/messages", headers=headers))
                await h.send(_request("POST", "/v1/files", headers=headers))
                body = json.dumps({"model": "m", "max_tokens": 1, "messages": [], "mcp_servers": [ROOM_TOKEN]})
                await h.send(_request("POST", "/v1/messages", body.encode(), headers=headers))

        with redirect_stderr(captured):
            asyncio.run(scenario())
        log = captured.getvalue()
        self.assertEqual(len(log.strip().splitlines()), 3, log)
        self.assertNotIn(KERNEL_TOKEN, log)
        self.assertNotIn(ROOM_TOKEN, log)
        self.assertEqual(secret_scrub.credential_shapes_in(log), ())
        # The oracle sees the fixtures: an empty answer is not a blind one.
        self.assertTrue(secret_scrub.credential_shapes_in(KERNEL_TOKEN))
        self.assertTrue(secret_scrub.credential_shapes_in(ROOM_TOKEN))


class TheGatewaysDefaults(unittest.TestCase):
    def test_the_upstream_is_tls_with_the_pinned_name_verified(self) -> None:
        seen: dict = {}

        async def fake_open_connection(host, port, **kwargs):
            seen.update(host=host, port=port, **kwargs)
            raise ConnectionRefusedError("no network in the test")

        with mock.patch.object(gw.asyncio, "open_connection", fake_open_connection):
            with self.assertRaises(ConnectionRefusedError):
                asyncio.run(gw.open_tls_upstream("api.anthropic.com", 443))
        self.assertEqual((seen["host"], seen["port"], seen["server_hostname"]), ("api.anthropic.com", 443,
                                                                               "api.anthropic.com"))
        self.assertIsInstance(seen["ssl"], ssl.SSLContext)
        self.assertTrue(seen["ssl"].check_hostname)
        self.assertEqual(seen["ssl"].verify_mode, ssl.CERT_REQUIRED)
        self.assertIs(gw.ProviderGateway(route("anthropic")).open_upstream, gw.open_tls_upstream)

    def test_the_kernel_credential_is_re_read_per_request(self) -> None:
        tmp = Path(tempfile.mkdtemp(prefix="aria-gw-cred-"))
        self.addCleanup(lambda: __import__("shutil").rmtree(tmp, ignore_errors=True))
        token = tmp / "token"
        token.write_text("first-" + "a" * 20 + "\n")
        token.chmod(0o600)
        source = gw.kernel_credential(route("anthropic"), {"ARIA_CLAUDE_OAUTH_TOKEN_FILE": str(token)})
        self.assertEqual(source().header_value(), "Bearer first-" + "a" * 20)
        token.write_text("second-" + "b" * 20 + "\n")
        self.assertEqual(source().header_value(), "Bearer second-" + "b" * 20)
        token.chmod(0o644)
        with self.assertRaises(ProviderCredentialUnavailable) as refused:
            source()
        self.assertEqual(refused.exception.reason, "credential_file_permissions")

    def test_only_a_gateway_route_is_served(self) -> None:
        with self.assertRaises(ValueError):
            gw.ProviderGateway(route("openai"))


if __name__ == "__main__":
    unittest.main()
