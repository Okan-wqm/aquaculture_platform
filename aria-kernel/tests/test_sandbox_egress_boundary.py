"""ARIA-HIGH-143 / ARIA-HIGH-528 / ARIA-MEDIUM-563 — a room that reaches its
provider has no other road out, and reaches it only as the kernel.

The managed Claude room (``wrap_managed_claude_in_sandbox``, every
implementer and every read-contained role) and the Codex runtime-state room
(``_wrap_runtime_state_in_sandbox``) used to share the host's network
namespace so the CLI could reach its provider. ``HTTPS_PROXY`` pointed at an
allowlist proxy, but a proxy variable is advice: a test file the agent wrote
and an allowed runner opened a socket to any address the host could reach —
a public host, the host's own loopback services (the production stack's
Postgres, Redis, NATS listen there), an abstract unix socket — and sent what
the room can read, the CLI's own credential included. ARIA-MEDIUM-563: even
through the allowlist proxy, an opaque tunnel to a provider host carried any
credential the room held or brought, and the Claude room held the
operator's login.

Every test here runs the REAL argv under the REAL bwrap and asks the room
itself, with a probe program standing where the CLI stands:

* nothing on the host answers a direct connect — not loopback, not a host
  interface address, not an abstract socket — and no route leaves the
  namespace at all;
* the Claude room holds no credential and no proxy: its one road is the
  kernel's provider gateway, which forwards pinned requests under the
  kernel's credential and refuses the rest by name;
* the Codex room's provider IS reached, and only through the kernel's
  CONNECT proxy for the OpenAI hosts: a client that honours ``HTTPS_PROXY``
  tunnels to an allowlisted endpoint and is refused by name for anything
  else, another provider's host and the host's loopback services included.
"""
from __future__ import annotations

import errno
import json
import os
import secrets
import socket
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest import mock

from aria_kernel import egress_proxy
from aria_kernel import implementation_safety as impl
from aria_kernel import provider_gateway
from aria_kernel.provider_credentials import ProviderCredential
from aria_kernel.provider_routes import ROOM_CREDENTIAL_PLACEHOLDER, route
from tests._helpers.real_process_seams import require_host_capability
from tests._helpers.sandbox_pins import require_sandbox_backend

# ARIA-HIGH-138 — the seam(s) this file proves by a real process, per
# the closed registry in tests/invariants/seam_registry.py.
REAL_PROCESS_SEAMS = (
    "aria-kernel/aria_kernel/egress_relay.py",
)

PYTHON = os.path.realpath(sys.executable)
TEST_NET = ("203.0.113.1", 443)  # RFC 5737: never routable, never allowlisted

# Runs inside the room, where the CLI would run. One mode per invocation;
# one JSON object on stdout.
PROBE = r"""
import json, os, socket, sys

def connect(family, address):
    sock = socket.socket(family, socket.SOCK_STREAM)  # allowlist-external-network: inside the room, the probe of its boundary
    sock.settimeout(3)
    try:
        sock.connect(address)
        try:
            data = sock.recv(64)
        except OSError:
            data = b""
        return {"connected": True, "data": data.decode("latin-1")}
    except OSError as exc:
        return {"connected": False, "errno": exc.errno, "error": repr(exc)}
    finally:
        sock.close()

def tunnel(host, port, payload):
    # A client that honours HTTPS_PROXY the way the CLIs do: CONNECT through
    # the proxy the environment names, then speak to the endpoint.
    import http.client
    from urllib.parse import urlsplit
    proxy = urlsplit(os.environ["HTTPS_PROXY"])
    conn = http.client.HTTPConnection(proxy.hostname, proxy.port, timeout=10)  # allowlist-external-network: the in-room relay on loopback
    conn.set_tunnel(host, int(port))
    try:
        conn.request("POST", "/v1/messages", body=payload.encode(), headers={"Content-Type": "text/plain"})
        reply = conn.getresponse()
        return {"tunnelled": True, "status": reply.status, "body": reply.read().decode("latin-1")}
    except OSError as exc:
        return {"tunnelled": False, "error": repr(exc)}
    finally:
        conn.close()

mode, *args = sys.argv[1:]
if mode == "tcp":
    out = connect(socket.AF_INET, (args[0], int(args[1])))
elif mode == "abstract":
    out = connect(socket.AF_UNIX, "\0" + args[0])
elif mode == "tunnel":
    out = tunnel(args[0], args[1], args[2])
elif mode == "connect-raw":
    from urllib.parse import urlsplit
    proxy = urlsplit(os.environ["HTTPS_PROXY"])
    with socket.create_connection((proxy.hostname, proxy.port), timeout=10) as sock:
        sock.sendall(("CONNECT %s:%s HTTP/1.1\r\n\r\n" % (args[0], args[1])).encode())
        answer = b""
        while True:
            chunk = sock.recv(4096)
            if not chunk:
                break
            answer += chunk
    out = {"answer": answer.decode("latin-1")}
elif mode == "env":
    out = {name: os.environ.get(name) for name in ("HTTPS_PROXY", "HTTP_PROXY", "https_proxy", "http_proxy", "NO_PROXY")}
elif mode == "credentials":
    # What a process in the room could take: a login file under its home, its
    # config dir or /tmp, and every credential-shaped variable it holds.
    found = []
    for root in sorted({os.environ.get("HOME", ""), os.environ.get("CLAUDE_CONFIG_DIR", ""), "/tmp"} - {""}):
        for directory, _dirs, files in os.walk(root):
            found += [os.path.join(directory, name) for name in files if name in (".credentials.json", "auth.json")]
    out = {"files": found, "environ": dict(os.environ)}
elif mode == "gateway":
    # A raw request to the socket the room's environment names.
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as sock:  # allowlist-external-network: the probe speaking to the room's own gateway socket
        sock.settimeout(10)
        sock.connect(os.environ["ANTHROPIC_UNIX_SOCKET"])
        sock.sendall(args[0].encode("latin-1"))
        answer = b""
        while True:
            chunk = sock.recv(4096)
            if not chunk:
                break
            answer += chunk
    out = {"answer": answer.decode("latin-1")}
elif mode == "exit":
    sys.exit(int(args[0]))
print(json.dumps(out))
"""


class _Service:
    """A host-side listener that hands every connection a secret — the
    loopback production service an agent must not reach."""

    def __init__(self, family: int, address: object, secret: bytes) -> None:
        self.secret = secret
        self.server = socket.socket(family, socket.SOCK_STREAM)  # allowlist-external-network: a host-local listener the room must not reach
        self.server.bind(address)
        self.server.listen(8)
        self.address = self.server.getsockname()
        threading.Thread(target=self._serve, daemon=True).start()

    def _serve(self) -> None:
        while True:
            try:
                conn, _ = self.server.accept()
            except OSError:
                return
            with conn:
                try:
                    conn.sendall(self.secret)
                except OSError:
                    pass

    def close(self) -> None:
        self.server.close()


def _host_interface_address() -> str | None:
    """The host's own non-loopback IPv4 (the default route's source), or
    None on a host without one. A UDP connect sends no packet."""
    probe = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)  # allowlist-external-network: UDP connect sends no packet; reads the route's source
    try:
        probe.connect(TEST_NET)
        address = probe.getsockname()[0]
    except OSError:
        return None
    finally:
        probe.close()
    return None if address.startswith("127.") else address


class _RoomCase(unittest.TestCase):
    """Builds a room and runs the probe in it."""

    def setUp(self) -> None:
        require_sandbox_backend()
        self.tmp = Path(tempfile.mkdtemp(prefix="aria-egress-room-"))
        self.workspace = self.tmp / "workspace"
        self.workspace.mkdir()

    def tearDown(self) -> None:
        import shutil

        shutil.rmtree(self.tmp, ignore_errors=True)

    def build(self, argv: list[str]) -> list[str]:
        raise NotImplementedError

    def run_room(self, *args: str, timeout: float = 60) -> dict:
        completed = self.complete_room(*args, timeout=timeout)
        self.assertEqual(completed.returncode, 0, completed.stderr)
        return json.loads(completed.stdout.strip().splitlines()[-1])

    # What the caller hands the room's spawn. A room must not depend on it
    # for its road, and must not let a credential in it through.
    handed: dict[str, str] = {}

    def complete_room(self, *args: str, timeout: float = 60) -> subprocess.CompletedProcess:
        argv = self.build([PYTHON, "-I", "-c", PROBE, *args])
        return subprocess.run(
            argv, capture_output=True, text=True, timeout=timeout,
            env={"PATH": "/usr/bin:/bin", "LANG": "C.UTF-8", **self.handed},
        )

    def service(self, family: int, address: object) -> _Service:
        service = _Service(family, address, b"secret-" + secrets.token_hex(8).encode())
        self.addCleanup(service.close)
        return service


class _NoRouteOut:
    """The property every room must hold. Mixed into one TestCase per room."""

    def test_the_hosts_loopback_services_do_not_answer(self) -> None:
        service = self.service(socket.AF_INET, ("127.0.0.1", 0))
        seen = self.run_room("tcp", "127.0.0.1", str(service.address[1]))
        self.assertFalse(seen["connected"], f"a direct connect reached the host's loopback service: {seen}")

    def test_a_host_interface_address_does_not_answer(self) -> None:
        address = _host_interface_address()
        # ARIA-HIGH-138 — this file is the egress relay seam's real-process
        # proof, so a missing host capability skips only off the kernel lane.
        require_host_capability(
            self, "a non-loopback IPv4 route", address is not None
        )
        service = self.service(socket.AF_INET, ("0.0.0.0", 0))
        seen = self.run_room("tcp", address, str(service.address[1]))
        self.assertFalse(seen["connected"], f"a direct connect reached {address}: {seen}")

    def test_no_route_leaves_the_namespace(self) -> None:
        # Not "the packet was dropped somewhere" (a timeout on the host's
        # route): the room has no route at all, so the kernel refuses at once.
        seen = self.run_room("tcp", *map(str, TEST_NET))
        self.assertFalse(seen["connected"], seen)
        self.assertEqual(seen["errno"], errno.ENETUNREACH, f"the room has a route out: {seen}")

    def test_a_host_abstract_socket_does_not_answer(self) -> None:
        # Abstract unix sockets belong to the network namespace, so a room
        # that shares the host's reaches every one the host listens on.
        name = "aria-egress-test-" + secrets.token_hex(6)
        self.service(socket.AF_UNIX, "\0" + name)
        seen = self.run_room("abstract", name)
        self.assertFalse(seen["connected"], f"the host's abstract socket answered: {seen}")


class _FakeProvider:
    """An HTTP endpoint on the host's loopback standing in for the provider:
    it answers ``provider-ok:<body>`` to whatever reaches it."""

    def __init__(self) -> None:
        from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self) -> None:  # noqa: N802 - the stdlib's hook name
                body = self.rfile.read(int(self.headers.get("Content-Length", "0")))
                reply = b"provider-ok:" + body
                self.send_response(200)
                self.send_header("Content-Length", str(len(reply)))
                self.end_headers()
                self.wfile.write(reply)

            def log_message(self, *args: object) -> None:
                pass

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.port = self.server.server_address[1]
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def close(self) -> None:
        self.server.shutdown()
        self.server.server_close()


def _replace_kernel_listener(case: unittest.TestCase, key: str, listener: Path) -> None:
    """The room is built with the production binds and environment; only
    the kernel's listener for ``key`` is replaced by the test's."""
    production = egress_proxy.kernel_egress_sockets()
    patcher = mock.patch.object(egress_proxy, "kernel_egress_sockets", return_value={**production, key: listener})
    patcher.start()
    case.addCleanup(patcher.stop)


class _ThroughTheProxyOnly:
    """The provider is reached, and only through the allowlist proxy. The
    kernel's proxy is replaced for the room by one whose allowlist names the
    fake provider (the production list names real provider hosts only); the
    room, the relay and the socket bind are the production ones."""

    def proxied(self) -> _FakeProvider:
        provider = _FakeProvider()
        self.addCleanup(provider.close)
        directory = Path(tempfile.mkdtemp(prefix="aria-egress-sock-"))
        self.addCleanup(lambda: __import__("shutil").rmtree(directory, ignore_errors=True))
        proxy = egress_proxy.ProxyThread.connect(
            directory / "proxy.sock", egress_proxy.Allowlist.parse([f"127.0.0.1:{provider.port}"]),
        ).start()
        self.addCleanup(proxy.stop)
        _replace_kernel_listener(self, "openai", proxy.socket_path)
        return provider

    def test_an_allowlisted_endpoint_answers_through_the_proxy(self) -> None:
        provider = self.proxied()
        seen = self.run_room("tunnel", "127.0.0.1", str(provider.port), "hello-provider")
        self.assertEqual(seen, {"tunnelled": True, "status": 200, "body": "provider-ok:hello-provider"})

    def test_a_target_off_the_allowlist_is_refused_by_name(self) -> None:
        self.proxied()
        service = self.service(socket.AF_INET, ("127.0.0.1", 0))
        port = service.address[1]
        seen = self.run_room("connect-raw", "127.0.0.1", str(port))
        self.assertTrue(seen["answer"].startswith("HTTP/1.1 403 Forbidden"), seen)
        self.assertIn(f"egress_refused:target_not_allowlisted:127.0.0.1:{port}", seen["answer"])
        self.assertNotIn(service.secret.decode(), seen["answer"])

    def test_the_kernels_own_allowlist_refuses_the_hosts_loopback(self) -> None:
        # No replacement: the production proxy and the route's targets. A
        # loopback production service is not a provider, through the proxy
        # or around it.
        service = self.service(socket.AF_INET, ("127.0.0.1", 0))
        seen = self.run_room("connect-raw", "127.0.0.1", str(service.address[1]))
        self.assertIn("egress_refused:target_not_allowlisted:127.0.0.1:", seen["answer"])
        self.assertNotIn(service.secret.decode(), seen["answer"])

    def test_the_room_names_its_own_relay_as_the_proxy(self) -> None:
        seen = self.run_room("env")
        relay = seen["HTTPS_PROXY"]
        self.assertTrue(relay.startswith("http://127.0.0.1:"), seen)
        self.assertNotEqual(relay, "http://127.0.0.1:9", "a host proxy value reached the room")
        self.assertEqual({seen[name] for name in ("HTTPS_PROXY", "HTTP_PROXY", "https_proxy", "http_proxy")}, {relay})
        self.assertEqual(seen["NO_PROXY"], "localhost,127.0.0.1,::1")

    def test_the_command_keeps_its_exit_status(self) -> None:
        # The relay EXECS the command: what the caller sees is the command's
        # own status, as before the room had a door.
        self.assertEqual(self.complete_room("exit", "7").returncode, 7)


class _RecordingUpstream:
    """What the provider would see: a loopback HTTP server recording each
    request's head and body, answering 200."""

    def __init__(self) -> None:
        from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

        seen = self.seen = []

        class Handler(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def do_POST(self) -> None:  # noqa: N802 - the stdlib's hook name
                body = self.rfile.read(int(self.headers.get("Content-Length", "0")))
                seen.append({"path": self.path, "headers": [(k.lower(), v) for k, v in self.headers.items()],
                             "body": body.decode("latin-1")})
                reply = b'{"type":"message","content":[{"type":"text","text":"ok"}]}'
                self.send_response(200)
                self.send_header("Content-Length", str(len(reply)))
                self.end_headers()
                self.wfile.write(reply)

            def log_message(self, *args: object) -> None:
                pass

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.port = self.server.server_address[1]
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def close(self) -> None:
        self.server.shutdown()
        self.server.server_close()


KERNEL_FIXTURE_TOKEN = "kernel-fixture-" + secrets.token_hex(12)
ROOM_FIXTURE_TOKEN = "room-fixture-" + secrets.token_hex(12)


class TheManagedClaudeRoom(_RoomCase, _NoRouteOut):
    """ARIA-HIGH-143 / ARIA-MEDIUM-563 — the commit-capable implementer's room
    (and every read-contained role's: the same wrapper with an empty write
    scope). Its spawn is handed every credential a careless caller could
    pass and a proxy the room cannot reach; none of them may arrive."""

    handed = {
        "CLAUDE_CODE_OAUTH_TOKEN": ROOM_FIXTURE_TOKEN, "ANTHROPIC_API_KEY": ROOM_FIXTURE_TOKEN,
        "ANTHROPIC_AUTH_TOKEN": ROOM_FIXTURE_TOKEN, "CLAUDE_API_KEY": ROOM_FIXTURE_TOKEN,
        "ANTHROPIC_BASE_URL": "https://attacker.example", "HTTPS_PROXY": "http://127.0.0.1:9",
        "https_proxy": "http://127.0.0.1:9",
    }

    def build(self, argv: list[str]) -> list[str]:
        return impl.wrap_managed_claude_in_sandbox(
            argv, workspace_root=self.workspace, write_scope=(), executable=Path(PYTHON), spawn_files=(),
        )

    def kernel_gateway(self) -> tuple[_RecordingUpstream, list[tuple[str, int]]]:
        """The production gateway mechanism with the kernel's credential a
        fixture and its upstream the recording server on loopback."""
        upstream = _RecordingUpstream()
        self.addCleanup(upstream.close)
        opened: list[tuple[str, int]] = []

        async def opener(host: str, port: int):
            import asyncio

            opened.append((host, port))
            return await asyncio.open_connection("127.0.0.1", upstream.port)

        gateway = provider_gateway.ProviderGateway(
            route("anthropic"), open_upstream=opener, decide=lambda **fields: None,
            credential=lambda: ProviderCredential(provider="anthropic", source="file", location="/fixture",
                                                  _secret=KERNEL_FIXTURE_TOKEN),
        )
        directory = Path(tempfile.mkdtemp(prefix="aria-gw-sock-"))
        self.addCleanup(lambda: __import__("shutil").rmtree(directory, ignore_errors=True))
        thread = egress_proxy.ProxyThread({directory / "anthropic": gateway.handle}).start()
        self.addCleanup(thread.stop)
        _replace_kernel_listener(self, "anthropic", thread.socket_path)
        return upstream, opened

    def test_the_room_holds_no_provider_credential(self) -> None:
        seen = self.run_room("credentials")
        self.assertEqual(seen["files"], [], "a login file is reachable in the room")
        environ = seen["environ"]
        self.assertNotIn(ROOM_FIXTURE_TOKEN, json.dumps(environ), "a handed credential reached the room")
        self.assertEqual(environ["CLAUDE_CODE_OAUTH_TOKEN"], ROOM_CREDENTIAL_PLACEHOLDER)
        for name in route("anthropic").room_unset:
            self.assertNotIn(name, environ)
        self.assertEqual(environ["ANTHROPIC_BASE_URL"], "http://localhost")
        self.assertEqual(environ["ANTHROPIC_UNIX_SOCKET"], route("anthropic").room_socket)

    def test_no_wrapper_parameter_binds_a_login(self) -> None:
        import inspect

        self.assertNotIn("managed_login_dir", inspect.signature(impl.wrap_managed_claude_in_sandbox).parameters)
        argv = self.build([PYTHON, "-c", "pass"])
        separator = argv.index("--")
        self.assertFalse([arg for arg in argv[:separator] if ".credentials.json" in arg or "auth.json" in arg])

    def test_no_tunnel_to_any_provider_host(self) -> None:
        seen = self.run_room("env")
        self.assertEqual({seen[name] for name in ("HTTPS_PROXY", "HTTP_PROXY", "https_proxy", "http_proxy")}, {None})
        argv = self.build([PYTHON, "-c", "pass"])
        separator = argv.index("--")
        self.assertNotIn(impl.SANDBOX_EGRESS_PROXY_SOCKET, argv[:separator])
        self.assertNotIn(impl.SANDBOX_EGRESS_RELAY, argv)
        # The one socket in the room speaks no CONNECT to anyone.
        for host in ("api.anthropic.com", "platform.claude.com", "api.z.ai", "api.openai.com"):
            with self.subTest(host=host):
                answer = self.run_room("gateway", f"CONNECT {host}:443 HTTP/1.1\r\nhost: {host}:443\r\n\r\n")
                self.assertTrue(answer["answer"].startswith("HTTP/1.1 403"), answer)
                self.assertIn(f"gateway_refused:request_not_pinned:CONNECT {host}:443", answer["answer"])

    def test_a_room_key_is_replaced_by_the_kernels(self) -> None:
        upstream, opened = self.kernel_gateway()
        body = json.dumps({"model": "claude-opus", "max_tokens": 1, "messages": [{"role": "user", "content": "hi"}]})
        request = (f"POST /v1/messages?beta=true HTTP/1.1\r\nhost: localhost\r\n"
                   f"authorization: Bearer {ROOM_FIXTURE_TOKEN}\r\nx-api-key: {ROOM_FIXTURE_TOKEN}\r\n"
                   f"content-length: {len(body)}\r\n\r\n{body}")
        answer = self.run_room("gateway", request)["answer"]
        self.assertTrue(answer.startswith("HTTP/1.1 200"), answer)
        self.assertEqual(opened, [("api.anthropic.com", 443)])
        (forwarded,) = upstream.seen
        headers = dict(forwarded["headers"])
        self.assertEqual(headers["authorization"], f"Bearer {KERNEL_FIXTURE_TOKEN}")
        self.assertNotIn("x-api-key", headers)
        self.assertIn("oauth-2025-04-20", headers["anthropic-beta"])
        self.assertNotIn(ROOM_FIXTURE_TOKEN, json.dumps(forwarded))

    def test_unpinned_requests_and_provider_fetches_are_refused_in_the_room(self) -> None:
        _upstream, opened = self.kernel_gateway()
        mcp = json.dumps({"model": "m", "max_tokens": 1, "messages": [],
                          "mcp_servers": [{"type": "url", "url": "https://attacker.example/", "name": "x"}]})
        for request, reason in (
            (f"POST /v1/files HTTP/1.1\r\nauthorization: Bearer {ROOM_FIXTURE_TOKEN}\r\n"
             "content-length: 0\r\n\r\n", "request_not_pinned:POST /v1/files"),
            (f"POST /v1/messages HTTP/1.1\r\ncontent-length: {len(mcp)}\r\n\r\n{mcp}", "body_field:mcp_servers"),
        ):
            with self.subTest(reason=reason):
                answer = self.run_room("gateway", request)["answer"]
                self.assertTrue(answer.startswith("HTTP/1.1 403"), answer)
                self.assertIn(f"gateway_refused:{reason}", answer)
        self.assertEqual(opened, [], "a refused request reached the upstream")

    def test_the_hosts_resolver_is_not_bound(self) -> None:
        argv = self.build([PYTHON, "-c", "pass"])
        separator = argv.index("--")
        sources = [argv[i + 1] for i in range(separator) if argv[i] == "--ro-bind"]
        self.assertNotIn("/etc/resolv.conf", sources)
        self.assertIn("--unshare-net", argv[:separator])


class TheCodexRuntimeRoom(_RoomCase, _NoRouteOut, _ThroughTheProxyOnly):
    """ARIA-HIGH-528 — the Codex runtime-state room."""

    def build(self, argv: list[str]) -> list[str]:
        runtime = self.tmp / "runtime"
        home = runtime / "home"
        auth = self.tmp / "auth"
        home.mkdir(parents=True, exist_ok=True)
        auth.mkdir(exist_ok=True)
        (auth / "auth.json").write_text("{}")
        environment = {
            "CODEX_HOME": str(home), "HOME": str(home), "PATH": "/usr/bin:/bin",
            # What the host's baseline environment hands the spawn: a proxy
            # the room cannot reach. The room must not depend on it.
            "HTTPS_PROXY": "http://127.0.0.1:9", "https_proxy": "http://127.0.0.1:9",
        }
        return impl._wrap_runtime_state_in_sandbox(
            argv, workspace_root=self.workspace, runtime_directory=runtime,
            managed_auth_directory=auth, executable=Path(PYTHON), environment=environment,
        )

    def test_its_tunnel_admits_only_the_openai_hosts(self) -> None:
        # The production proxy, no replacement: another provider's host is
        # refused by name before any connection (ARIA-MEDIUM-563).
        for host in ("api.anthropic.com", "platform.claude.com", "api.z.ai"):
            with self.subTest(host=host):
                seen = self.run_room("connect-raw", host, "443")
                self.assertTrue(seen["answer"].startswith("HTTP/1.1 403 Forbidden"), seen)
                self.assertIn(f"egress_refused:target_not_allowlisted:{host}:443", seen["answer"])


class TheBareGatewayRoom(_RoomCase, _NoRouteOut):
    """``wrap_bash_in_sandbox(provider="anthropic")`` alone — the write shape
    without a managed executable (``claude_runtime``)."""

    def build(self, argv: list[str]) -> list[str]:
        return impl.wrap_bash_in_sandbox(argv, workspace_root=self.workspace, provider="anthropic", write_scope=())


class TheBareTunnelRoom(_RoomCase, _NoRouteOut):
    """``wrap_bash_in_sandbox(provider="openai")`` alone: no pid namespace,
    so the relay's own lifetime rule is all that ends it."""

    def build(self, argv: list[str]) -> list[str]:
        return impl.wrap_bash_in_sandbox(argv, workspace_root=self.workspace, provider="openai", write_scope=())

    def test_the_relay_does_not_outlive_the_command(self) -> None:
        marker = "relay-lifetime-" + secrets.token_hex(6)
        started = time.monotonic()
        completed = self.complete_room("exit", "0", marker)
        # Returned at once: the relay holds none of the command's stdio.
        self.assertEqual(completed.returncode, 0, completed.stderr)
        self.assertLess(time.monotonic() - started, 30)
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            alive = [pid for pid in os.listdir("/proc") if pid.isdigit() and _cmdline_holds(pid, marker)]
            if not alive:
                break
            time.sleep(0.1)
        self.assertEqual(alive, [], "the relay outlived the command it served")


def _cmdline_holds(pid: str, marker: str) -> bool:
    try:
        return marker.encode() in Path(f"/proc/{pid}/cmdline").read_bytes()
    except OSError:
        return False


class TheRelaysOwnEdges(unittest.TestCase):
    """``egress_relay.py`` run by path, as the room runs it, outside a room:
    the edges a room cannot reach on purpose."""

    RELAY = str(impl.EGRESS_RELAY_SOURCE)

    def _relay(self, *args: str) -> subprocess.CompletedProcess:
        return subprocess.run([PYTHON, "-I", self.RELAY, *args], capture_output=True, text=True, timeout=30,
                              env={"PATH": "/usr/bin:/bin"})

    def test_a_malformed_invocation_is_a_usage_error(self) -> None:
        completed = self._relay("/tmp/no-proxy.sock", "true")
        self.assertEqual(completed.returncode, 2)
        self.assertIn("usage: egress_relay.py", completed.stderr)

    def test_a_command_that_cannot_be_executed_is_127_by_name(self) -> None:
        completed = self._relay("/tmp/no-proxy.sock", "--", "/nonexistent/aria-egress-command")
        self.assertEqual(completed.returncode, 127)
        self.assertIn("egress_relay: cannot exec '/nonexistent/aria-egress-command'", completed.stderr)

    def test_an_unreachable_proxy_is_answered_by_name_not_reset(self) -> None:
        missing = Path(tempfile.mkdtemp(prefix="aria-egress-none-")) / "proxy.sock"
        self.addCleanup(lambda: __import__("shutil").rmtree(missing.parent, ignore_errors=True))
        completed = self._relay(str(missing), "--", PYTHON, "-I", "-c", PROBE, "connect-raw", "api.anthropic.com", "443")
        self.assertEqual(completed.returncode, 0, completed.stderr)
        answer = json.loads(completed.stdout.strip().splitlines()[-1])["answer"]
        self.assertTrue(answer.startswith("HTTP/1.1 502 Bad Gateway"), answer)
        self.assertIn("egress_refused:proxy_unreachable", answer)


class TheGateProvesTheBoundaryInARoom(unittest.TestCase):
    """``egress_boundary_probe`` — the pre-claim gate's question, asked of
    the managed room's real argv from inside it."""

    def setUp(self) -> None:
        require_sandbox_backend()

    def test_this_hosts_managed_room_holds_the_boundary(self) -> None:
        self.assertIsNone(impl.egress_boundary_probe())

    def _served(self, answer: bytes) -> Path:
        """A listener in place of the kernel's gateway that answers ``answer``
        to anything — a gateway that forwards what it should refuse."""
        import asyncio

        async def permissive(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
            await reader.read(65536)
            writer.write(answer)
            await writer.drain()
            writer.close()

        directory = Path(tempfile.mkdtemp(prefix="aria-gw-sock-"))
        self.addCleanup(lambda: __import__("shutil").rmtree(directory, ignore_errors=True))
        thread = egress_proxy.ProxyThread({directory / "anthropic": permissive}).start()
        self.addCleanup(thread.stop)
        return thread.socket_path

    def test_a_gateway_that_forwards_an_unpinned_path_is_no_boundary(self) -> None:
        listener = self._served(b"HTTP/1.1 200 OK\r\ncontent-length: 2\r\nconnection: close\r\n\r\nok")
        production = egress_proxy.kernel_egress_sockets()
        with mock.patch.object(egress_proxy, "kernel_egress_sockets",
                               return_value={**production, "anthropic": listener}):
            reason = impl.egress_boundary_probe()
        self.assertIsNotNone(reason)
        self.assertIn("gateway_did_not_refuse_an_unpinned_request_by_name", reason)

    def test_a_room_that_keeps_a_credential_variable_is_no_boundary(self) -> None:
        real = impl._provider_room

        def keeps_the_key(provider: str) -> tuple[list[str], list[str]]:
            binds, door = real(provider)
            kept = [i for i in range(len(binds) - 1) if binds[i] == "--unsetenv" and binds[i + 1] == "ANTHROPIC_API_KEY"]
            for index in reversed(kept):
                del binds[index:index + 2]
            return binds, door

        with mock.patch.object(impl, "_provider_room", keeps_the_key):
            reason = impl.egress_boundary_probe()
        self.assertIsNotNone(reason)
        self.assertIn("room_holds_a_credential_variable:ANTHROPIC_API_KEY", reason)


if __name__ == "__main__":
    unittest.main()
