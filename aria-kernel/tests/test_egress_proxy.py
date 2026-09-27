"""ARIA-HIGH-143 — the egress proxy admits the allowlist and nothing else.

Each test drives the real server over a real socket: a loopback echo
service stands in for a provider endpoint, so "admitted" means bytes went
through and came back, and "refused" means a named status before any
upstream connection was attempted.
"""
from __future__ import annotations

import asyncio
import os
import tempfile
import unittest

from aria_kernel import egress_proxy


async def _echo(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
    data = await reader.read(1024)
    writer.write(b"echo:" + data)
    await writer.drain()
    writer.close()


class _Harness:
    def __init__(self, allow: list[str] | None = None) -> None:
        self.allow = allow

    async def __aenter__(self) -> "_Harness":
        self.echo = await asyncio.start_server(_echo, host="127.0.0.1", port=0)
        self.echo_port = self.echo.sockets[0].getsockname()[1]
        allow = self.allow if self.allow is not None else [f"127.0.0.1:{self.echo_port}"]
        self.allowlist = egress_proxy.Allowlist.parse(allow)
        self.tmp = tempfile.mkdtemp(prefix="aria-egress-")
        self.unix = os.path.join(self.tmp, "proxy.sock")
        self.servers = await egress_proxy.serve(listen=("127.0.0.1", 0), unix_socket=self.unix, allowlist=self.allowlist)
        self.port = self.servers[0].sockets[0].getsockname()[1]
        return self

    async def __aexit__(self, *exc: object) -> None:
        for server in (*self.servers, self.echo):
            server.close()
            await server.wait_closed()

    async def request(self, raw: bytes, *, via_unix: bool = False) -> bytes:
        if via_unix:
            reader, writer = await asyncio.open_unix_connection(self.unix)
        else:
            reader, writer = await asyncio.open_connection("127.0.0.1", self.port)
        writer.write(raw)
        await writer.drain()
        head = await reader.readuntil(b"\r\n\r\n")
        if head.startswith(b"HTTP/1.1 200"):
            writer.write(b"payload")
            await writer.drain()
            body = await reader.read(1024)
            writer.close()
            return head + body
        rest = await reader.read(4096)
        writer.close()
        return head + rest


def _run(coro):
    return asyncio.run(coro)


class AdmittedTraffic(unittest.TestCase):
    def test_an_allowlisted_target_is_tunnelled_end_to_end(self) -> None:
        async def scenario() -> bytes:
            async with _Harness() as h:
                return await h.request(f"CONNECT 127.0.0.1:{h.echo_port} HTTP/1.1\r\nHost: x\r\n\r\n".encode())
        response = _run(scenario())
        self.assertTrue(response.startswith(b"HTTP/1.1 200 Connection Established"), response)
        self.assertTrue(response.endswith(b"echo:payload"), response)

    def test_the_unix_socket_serves_the_same_decisions(self) -> None:
        async def scenario() -> tuple[bytes, bytes]:
            async with _Harness() as h:
                admitted = await h.request(f"CONNECT 127.0.0.1:{h.echo_port} HTTP/1.1\r\n\r\n".encode(), via_unix=True)
                refused = await h.request(b"CONNECT example.com:443 HTTP/1.1\r\n\r\n", via_unix=True)
                return admitted, refused
        admitted, refused = _run(scenario())
        self.assertTrue(admitted.endswith(b"echo:payload"), admitted)
        self.assertIn(b"403 Forbidden", refused)


class RefusedTraffic(unittest.TestCase):
    def test_a_target_off_the_allowlist_is_refused_by_name_before_any_connection(self) -> None:
        async def scenario() -> bytes:
            async with _Harness() as h:
                # The echo service is reachable — only the allowlist stands between.
                async with _Harness(allow=["api.example.invalid:443"]) as strict:
                    return await strict.request(f"CONNECT 127.0.0.1:{h.echo_port} HTTP/1.1\r\n\r\n".encode())
        response = _run(scenario())
        self.assertIn(b"403 Forbidden", response)
        self.assertIn(b"egress_refused:target_not_allowlisted:127.0.0.1:", response)

    def test_only_connect_is_served(self) -> None:
        async def scenario() -> bytes:
            async with _Harness() as h:
                return await h.request(b"GET http://127.0.0.1/ HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n")
        response = _run(scenario())
        self.assertIn(b"405 Method Not Allowed", response)
        self.assertIn(b"only_connect_is_served", response)

    def test_a_malformed_target_is_refused(self) -> None:
        async def scenario() -> bytes:
            async with _Harness() as h:
                return await h.request(b"CONNECT nowhere HTTP/1.1\r\n\r\n")
        response = _run(scenario())
        self.assertIn(b"400 Bad Request", response)

    def test_an_allowlisted_but_unreachable_upstream_is_a_gateway_refusal(self) -> None:
        async def scenario() -> bytes:
            async with _Harness(allow=["127.0.0.1:9"]) as h:  # discard port: nothing listens
                return await h.request(b"CONNECT 127.0.0.1:9 HTTP/1.1\r\n\r\n")
        response = _run(scenario())
        self.assertIn(b"502 Bad Gateway", response)


class TheAllowlist(unittest.TestCase):
    def test_entries_are_host_port_and_case_insensitive(self) -> None:
        allowlist = egress_proxy.Allowlist.parse(["API.Anthropic.com:443", "api.z.ai:443"])
        self.assertTrue(allowlist.admits("api.anthropic.com", 443))
        self.assertFalse(allowlist.admits("api.anthropic.com", 80))
        self.assertFalse(allowlist.admits("evil.example", 443))
        with self.assertRaises(ValueError):
            egress_proxy.Allowlist.parse(["api.anthropic.com"])

    def test_an_empty_allowlist_refuses_to_start(self) -> None:
        with self.assertRaises(SystemExit):
            egress_proxy.main(["--listen", "127.0.0.1:0"])


if __name__ == "__main__":
    unittest.main()
