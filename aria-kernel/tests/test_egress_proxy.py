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
from aria_kernel.socket_holders import EGRESS_PROXY, SOCKET_HOLDERS, prune_stale_socket_dirs


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

    def test_an_empty_allowlist_is_refused(self) -> None:
        with self.assertRaises(ValueError):
            egress_proxy.Allowlist.parse([])

    def test_the_kernels_allowlist_is_the_provider_endpoints_and_no_more(self) -> None:
        # ARIA-HIGH-143 — the policy is reviewed code, one tuple. The OAuth
        # refresh host is on it (the managed login refreshes inside the room,
        # ARIA-HIGH-157); nothing local or private is.
        allowlist = egress_proxy.Allowlist.parse(egress_proxy.PROVIDER_ENDPOINTS)
        self.assertTrue(allowlist.admits("api.anthropic.com", 443))
        self.assertTrue(allowlist.admits("platform.claude.com", 443))
        for host, port in allowlist.targets:
            self.assertEqual(port, 443, host)
            self.assertNotIn(host, ("localhost", "127.0.0.1", "::1"))


class TheKernelsProxy(unittest.TestCase):
    """``kernel_egress_socket`` — the proxy the process that builds a room
    serves for it, from a thread, for the process's life."""

    def test_one_proxy_per_process_serving_the_provider_allowlist(self) -> None:
        import socket

        first = egress_proxy.kernel_egress_socket()
        self.assertEqual(egress_proxy.kernel_egress_socket(), first)
        self.assertTrue(first.is_socket())
        client = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)  # allowlist-external-network: the kernel proxy's unix socket; the target is refused before any connection
        client.settimeout(10)
        try:
            client.connect(str(first))
            client.sendall(b"CONNECT 127.0.0.1:5432 HTTP/1.1\r\n\r\n")
            answer = b""
            while chunk := client.recv(4096):
                answer += chunk
        finally:
            client.close()
        self.assertIn(b"403 Forbidden", answer)
        self.assertIn(b"egress_refused:target_not_allowlisted:127.0.0.1:5432", answer)

    def test_a_stopped_proxy_thread_releases_its_tunnels(self) -> None:
        directory = tempfile.mkdtemp(prefix="aria-egress-")
        self.addCleanup(lambda: __import__("shutil").rmtree(directory, ignore_errors=True))
        proxy = egress_proxy.ProxyThread(
            egress_proxy.Path(directory) / "proxy.sock", egress_proxy.Allowlist.parse(["api.example.invalid:443"]),
        ).start()
        self.assertTrue(proxy.serving())
        proxy.stop()
        self.assertFalse(proxy.serving())

    def test_the_socket_directory_follows_the_swept_holders_pattern(self) -> None:
        socket_path = egress_proxy.kernel_egress_socket()
        self.assertRegex(socket_path.parent.name, r"^aria-ep-[A-Za-z0-9_]{8}$")
        self.assertEqual(socket_path.name, "sock")

    def test_a_killed_processs_directory_is_swept_and_a_live_ones_kept(self) -> None:
        import socket

        temp_root = egress_proxy.Path(tempfile.mkdtemp(prefix="aria-ep-sweep-"))
        self.addCleanup(lambda: __import__("shutil").rmtree(temp_root, ignore_errors=True))
        live_dir, dead_dir, foreign_dir = (temp_root / name for name in ("aria-ep-live1234", "aria-ep-dead1234", "aria-ep-othr1234"))
        for directory in (live_dir, dead_dir, foreign_dir):
            directory.mkdir()
        live = egress_proxy.ProxyThread(live_dir / "sock", egress_proxy.Allowlist.parse(["a.b:443"])).start()
        self.addCleanup(live.stop)
        for directory in (dead_dir, foreign_dir):
            # A socket file nobody listens on: what a killed process leaves.
            dead = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)  # allowlist-external-network: binds a unix socket file and closes it; nothing is sent
            dead.bind(str(directory / "sock"))
            dead.close()
        (foreign_dir / "note").write_text("not the proxy's")
        swept = prune_stale_socket_dirs(EGRESS_PROXY, temp_root=temp_root)
        self.assertEqual(swept["swept"], ["aria-ep-dead1234"])
        self.assertEqual(swept["live"], ["aria-ep-live1234"])
        self.assertFalse(dead_dir.exists())
        self.assertTrue(foreign_dir.exists())
        self.assertEqual(prune_stale_socket_dirs(EGRESS_PROXY, temp_root=temp_root)["swept"], [])

    def test_the_orchestrators_startup_sweep_covers_the_proxy(self) -> None:
        from aria_kernel import autonomy_orchestrator

        source = egress_proxy.Path(autonomy_orchestrator.__file__).read_text(encoding="utf-8")
        self.assertIn(EGRESS_PROXY, SOCKET_HOLDERS)
        self.assertIn("**prune_stale_holder_sockets(),", source)

    def test_a_socket_path_the_kernel_cannot_bind_is_refused_by_name(self) -> None:
        with self.assertRaises(egress_proxy.EgressProxyUnavailable) as refused:
            egress_proxy.ProxyThread(egress_proxy.Path("/" + "x" * 120), egress_proxy.Allowlist.parse(["a.b:443"]))
        self.assertIn("egress_proxy_socket_path_too_long", str(refused.exception))


if __name__ == "__main__":
    unittest.main()
