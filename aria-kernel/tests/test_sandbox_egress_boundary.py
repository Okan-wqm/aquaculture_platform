"""ARIA-HIGH-143 / ARIA-HIGH-528 — a room that reaches its provider has no other road out.

The managed Claude room (``wrap_managed_claude_in_sandbox``, every
implementer and every read-contained role) and the Codex runtime-state room
(``_wrap_runtime_state_in_sandbox``) used to share the host's network
namespace so the CLI could reach its provider. ``HTTPS_PROXY`` pointed at an
allowlist proxy, but a proxy variable is advice: a test file the agent wrote
and an allowed runner opened a socket to any address the host could reach —
a public host, the host's own loopback services (the production stack's
Postgres, Redis, NATS listen there), an abstract unix socket — and sent what
the room can read, the CLI's own credential included.

Every test here runs the REAL argv under the REAL bwrap and asks the room
itself, with a probe program standing where the CLI stands:

* nothing on the host answers a direct connect — not loopback, not a host
  interface address, not an abstract socket — and no route leaves the
  namespace at all;
* the provider IS reached, and only through the kernel's allowlist proxy:
  a client that honours ``HTTPS_PROXY`` (as the Claude and Codex CLIs do)
  tunnels to an allowlisted endpoint and is refused by name for anything
  else, the host's loopback services included.
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
from tests._helpers.sandbox_pins import require_sandbox_backend

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

    def complete_room(self, *args: str, timeout: float = 60) -> subprocess.CompletedProcess:
        argv = self.build([PYTHON, "-I", "-c", PROBE, *args])
        return subprocess.run(
            argv, capture_output=True, text=True, timeout=timeout,
            env={"PATH": "/usr/bin:/bin", "LANG": "C.UTF-8"},
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
        if address is None:
            self.skipTest("this host has no non-loopback IPv4 route")
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
        proxy = egress_proxy.ProxyThread(
            directory / "proxy.sock", egress_proxy.Allowlist.parse([f"127.0.0.1:{provider.port}"]),
        ).start()
        self.addCleanup(proxy.stop)
        patcher = mock.patch.object(egress_proxy, "kernel_egress_socket", return_value=proxy.socket_path)
        patcher.start()
        self.addCleanup(patcher.stop)
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
        # No replacement: the production proxy and PROVIDER_ENDPOINTS. A
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


class TheManagedClaudeRoom(_RoomCase, _NoRouteOut, _ThroughTheProxyOnly):
    """ARIA-HIGH-143 — the commit-capable implementer's room (and every
    read-contained role's: the same wrapper with an empty write scope)."""

    def build(self, argv: list[str]) -> list[str]:
        return impl.wrap_managed_claude_in_sandbox(
            argv, workspace_root=self.workspace, write_scope=(), executable=Path(PYTHON),
            spawn_files=(), managed_login_dir=None,
        )

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


class TheBareEgressRoom(_RoomCase, _NoRouteOut):
    """``wrap_bash_in_sandbox(allow_network=True)`` alone — the write shape
    without a managed executable (``claude_runtime``): no pid namespace, so
    the relay's own lifetime rule is all that ends it."""

    def build(self, argv: list[str]) -> list[str]:
        return impl.wrap_bash_in_sandbox(argv, workspace_root=self.workspace, allow_network=True, write_scope=())

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

    def test_a_proxy_that_admits_the_probe_target_is_no_boundary(self) -> None:
        directory = Path(tempfile.mkdtemp(prefix="aria-egress-sock-"))
        self.addCleanup(lambda: __import__("shutil").rmtree(directory, ignore_errors=True))
        permissive = egress_proxy.ProxyThread(
            directory / "proxy.sock", egress_proxy.Allowlist.parse([impl.EGRESS_PROBE_TARGET]),
        ).start()
        self.addCleanup(permissive.stop)
        with mock.patch.object(egress_proxy, "kernel_egress_socket", return_value=permissive.socket_path):
            reason = impl.egress_boundary_probe()
        self.assertIsNotNone(reason)
        self.assertIn("egress boundary does not hold", reason)


if __name__ == "__main__":
    unittest.main()
