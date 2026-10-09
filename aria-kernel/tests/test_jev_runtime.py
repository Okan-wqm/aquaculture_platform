"""System One transport (ARIA-LOW-252) — the pinned endpoint, the credential boundary, the bounded call, the breaker.

The vendor is a local ``http.server`` on 127.0.0.1. The module cannot be
pointed at it — its endpoint is pinned — so the tests inject an ``opener``
that first asserts the request names the pinned endpoint, then delivers it to
the local vendor; the wire is asserted from the server's side. The real
``urllib`` opener is exercised directly for what only it decides (no redirect
following, no environment proxy, the response cap). No external network
(test_no_external_network_in_aria_kernel_tests).

One property per test:

* Only ``system_one`` imports this module, and a non-pinned endpoint is
  refused before any byte leaves.
* The key comes ONLY from the file ``ARIA_JEV_API_KEY_FILE`` names, opened
  without following a symlink, owned by this euid, with no group/other bits,
  of a fixed charset; every refusal is named; the key never reaches a result.
* No redirect is followed (any 3xx is refused), environment proxies are
  ignored, and the response is capped.
* Every failure is a returned ``JevUnavailable`` naming at most an exception
  CLASS: transport errors, 4xx, 5xx, a malformed body, an unserialisable
  payload.
* One monotonic deadline bounds both attempts together.
* The breaker opens after consecutive failures and answers ``circuit_open``.
"""
from __future__ import annotations

import json
import os
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest import mock

from aria_kernel import jev_runtime
from aria_kernel.jev_runtime import CircuitBreaker, JevReply, JevUnavailable, post_systemone

_REPO_ROOT = Path(__file__).resolve().parents[2]
_SECRET = "apikey_" + "0123456789abcdef" * 2

_PAYLOAD = {
    "model": "jev-1.13.0",
    "state": "{\"message\": \"m\", \"diff\": \"d\"}",
    "questions": {"R5": {"type": "noul", "instructions": "The diff does what the message says"}},
}
_OK_BODY = {
    "model": "jev-1.13.0",
    "answers": {"R5": {"type": "noul", "noul": 0.91}},
    "usage": {"input_tokens": 57},
}


class _Vendor:
    """Scripted stand-in: each request pops the next (status, body, headers) and records it."""

    def __init__(self) -> None:
        self.script: list[tuple[int, object, dict[str, str]]] = []
        self.received: list[dict] = []
        self._server: ThreadingHTTPServer | None = None

    def url(self, path: str = "/v1/systemone") -> str:
        assert self._server is not None
        return f"http://127.0.0.1:{self._server.server_address[1]}{path}"

    def __enter__(self) -> "_Vendor":
        vendor = self

        class Handler(BaseHTTPRequestHandler):
            def _answer(self, body: bytes) -> None:
                vendor.received.append({
                    "path": self.path,
                    "authorization": self.headers.get("Authorization"),
                    "json": json.loads(body.decode("utf-8")) if body else None,
                })
                status, payload, headers = vendor.script.pop(0) if vendor.script else (500, {"error": "unscripted"}, {})
                raw = payload if isinstance(payload, bytes) else json.dumps(payload).encode("utf-8")
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", headers.pop("Content-Length", str(len(raw))))
                for name, value in headers.items():
                    self.send_header(name, value)
                self.end_headers()
                self.wfile.write(raw)

            def do_POST(self) -> None:  # noqa: N802 — http.server API
                self._answer(self.rfile.read(int(self.headers.get("Content-Length") or 0)))

            def do_GET(self) -> None:  # noqa: N802 — http.server API
                self._answer(b"")

            def log_message(self, *_args: object) -> None:
                return

        self._server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        threading.Thread(target=self._server.serve_forever, kwargs={"poll_interval": 0.05}, daemon=True).start()
        return self

    def __exit__(self, *_exc: object) -> None:
        assert self._server is not None
        self._server.shutdown()
        self._server.server_close()


def _relay(vendor: _Vendor, seen: list[str] | None = None) -> jev_runtime.Opener:
    """An opener that insists on the pinned endpoint, then delivers to the local vendor."""

    def opener(request: urllib.request.Request, timeout: float) -> tuple[int, bytes]:
        assert request.full_url == jev_runtime.JEV_ENDPOINT, request.full_url
        if seen is not None:
            seen.append(request.full_url)
        local = urllib.request.Request(vendor.url(), data=request.data, method="POST", headers=dict(request.header_items()))
        try:
            with urllib.request.build_opener(urllib.request.ProxyHandler({})).open(local, timeout=timeout) as response:
                return int(response.status), response.read()
        except urllib.error.HTTPError as exc:
            return int(exc.code), b""
        except OSError as exc:
            raise jev_runtime._Refused(f"transport_error:{type(exc).__name__}", retryable=True) from exc

    return opener


class _KeyFile(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.key_path = Path(self._tmp.name) / "jev_api_key"
        self.key_path.write_text(_SECRET + "\n", encoding="utf-8")
        os.chmod(self.key_path, 0o600)
        self.environ = {"ARIA_JEV_API_KEY_FILE": str(self.key_path)}
        self.sleeps: list[float] = []

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def call(self, vendor: _Vendor, **kwargs: object) -> JevReply | JevUnavailable:
        return post_systemone(
            kwargs.pop("payload", _PAYLOAD), environ=self.environ, opener=_relay(vendor),
            breaker=kwargs.pop("breaker", CircuitBreaker()), sleep=self.sleeps.append, **kwargs,
        )


class PrivateAndPinned(_KeyFile):
    def test_nothing_but_system_one_names_the_transport(self) -> None:
        """Not an import, not a name, not an attribute, not a string handed to an import call."""
        import ast

        def import_call(node: ast.Call) -> bool:
            func = node.func
            name = func.id if isinstance(func, ast.Name) else func.attr if isinstance(func, ast.Attribute) else ""
            return "import" in name

        offenders = []
        for root in (_REPO_ROOT / "aria-kernel" / "aria_kernel", _REPO_ROOT / "tools"):
            for path in root.rglob("*.py"):
                if path.name in ("jev_runtime.py", "system_one.py"):
                    continue
                try:
                    tree = ast.parse(path.read_text(encoding="utf-8"))
                except (SyntaxError, UnicodeDecodeError):
                    continue
                for node in ast.walk(tree):
                    named: list[str] = []
                    if isinstance(node, ast.Import):
                        named = [alias.name for alias in node.names] + [alias.asname or "" for alias in node.names]
                    elif isinstance(node, ast.ImportFrom):
                        named = [node.module or ""] + [alias.name for alias in node.names]
                    elif isinstance(node, ast.Name):
                        named = [node.id]
                    elif isinstance(node, ast.Attribute):
                        named = [node.attr]
                    elif isinstance(node, ast.Call) and import_call(node):
                        named = [arg.value for arg in node.args if isinstance(arg, ast.Constant) and isinstance(arg.value, str)]
                    if any("jev_runtime" in name or "post_systemone" in name for name in named):
                        offenders.append(f"{path.relative_to(_REPO_ROOT).as_posix()}:{getattr(node, 'lineno', 0)}")
        self.assertEqual(offenders, [])

    def test_system_one_does_not_re_export_the_transport(self) -> None:
        from aria_kernel import system_one

        self.assertFalse(hasattr(system_one, "post_systemone"))
        self.assertFalse(hasattr(system_one, "jev_runtime"))

    def test_an_endpoint_that_is_not_the_pinned_host_never_sends(self) -> None:
        sent: list[object] = []
        for endpoint in ("http://api.typesafe.ai/v1/systemone", "https://evil.example/v1/systemone"):
            with self.subTest(endpoint=endpoint), mock.patch.object(jev_runtime, "JEV_ENDPOINT", endpoint):
                result = post_systemone(_PAYLOAD, environ=self.environ, opener=lambda r, t: sent.append(r) or (200, b""),
                                        breaker=CircuitBreaker())
                self.assertEqual(result, JevUnavailable("endpoint_not_pinned"))
        self.assertEqual(sent, [])


class CredentialBoundary(_KeyFile):
    def test_answer_carries_exact_model_and_tokens_and_the_wire_is_bearer_plus_payload(self) -> None:
        with _Vendor() as vendor:
            vendor.script = [(200, _OK_BODY, {})]
            reply = self.call(vendor)
        self.assertIsInstance(reply, JevReply)
        assert isinstance(reply, JevReply)
        self.assertEqual((reply.model, reply.input_tokens), ("jev-1.13.0", 57))
        self.assertEqual(reply.answers["R5"]["noul"], 0.91)
        self.assertEqual(vendor.received[0]["authorization"], "Bearer " + _SECRET)
        self.assertEqual(vendor.received[0]["json"], _PAYLOAD)
        self.assertNotIn(_SECRET, repr(reply))

    def test_env_value_is_never_a_credential(self) -> None:
        with _Vendor() as vendor:
            result = post_systemone(_PAYLOAD, environ={"ARIA_JEV_API_KEY": _SECRET}, opener=_relay(vendor),
                                    breaker=CircuitBreaker())
        self.assertEqual(result, JevUnavailable("credential_not_configured"))
        self.assertEqual(vendor.received, [])

    def test_readable_beyond_owner_is_refused_by_name(self) -> None:
        os.chmod(self.key_path, 0o640)
        with _Vendor() as vendor:
            self.assertEqual(self.call(vendor), JevUnavailable("credential_file_permissions"))
        self.assertEqual(vendor.received, [])

    def test_a_symlinked_key_file_is_not_followed(self) -> None:
        link = Path(self._tmp.name) / "link"
        link.symlink_to(self.key_path)
        self.environ = {"ARIA_JEV_API_KEY_FILE": str(link)}
        with _Vendor() as vendor:
            self.assertEqual(self.call(vendor), JevUnavailable("credential_file_unreadable"))
        self.assertEqual(vendor.received, [])

    @unittest.skipUnless(os.geteuid() == 0, "changing a file's owner needs root")
    def test_a_key_file_owned_by_another_account_is_refused(self) -> None:
        os.chown(self.key_path, 65534, -1)
        with _Vendor() as vendor:
            self.assertEqual(self.call(vendor), JevUnavailable("credential_file_owner"))

    def test_empty_multiline_or_header_shaped_keys_are_refused_by_name(self) -> None:
        cases = {"": "credential_file_empty", "a" * 20 + "\nb" * 20: "credential_file_malformed",
                 "a" * 20 + "\r\nX-Injected: 1": "credential_file_malformed", "short": "credential_file_malformed",
                 "a" * 20 + " b": "credential_file_malformed"}
        for content, reason in cases.items():
            with self.subTest(content=content):
                self.key_path.write_text(content, encoding="utf-8")
                with _Vendor() as vendor:
                    self.assertEqual(self.call(vendor), JevUnavailable(reason))
                self.assertEqual(vendor.received, [])

    def test_the_key_file_variable_never_reaches_an_agent_child(self) -> None:
        from aria_kernel.agent_env import SECRET_SHAPED_ENV_NAME

        self.assertRegex(jev_runtime.JEV_CREDENTIAL_FILE_ENV, SECRET_SHAPED_ENV_NAME)

    def test_missing_file_is_unreadable_not_a_raise(self) -> None:
        self.environ = {"ARIA_JEV_API_KEY_FILE": str(self.key_path) + ".absent"}
        with _Vendor() as vendor:
            self.assertEqual(self.call(vendor), JevUnavailable("credential_file_unreadable"))


class TheRealOpener(unittest.TestCase):
    def test_a_redirect_is_never_followed(self) -> None:
        with _Vendor() as sink, _Vendor() as vendor:
            vendor.script = [(302, b"", {"Location": sink.url("/steal")})]
            status, body = jev_runtime._http_opener(urllib.request.Request(vendor.url(), method="GET"), 2.0)
            self.assertEqual((status, body), (302, b""))
            self.assertEqual(sink.received, [])

    def test_environment_proxies_are_ignored(self) -> None:
        # A proxy named by the environment is a dead port: honouring it would fail the call.
        dead = {"http_proxy": "http://127.0.0.1:9", "HTTP_PROXY": "http://127.0.0.1:9",
                "https_proxy": "http://127.0.0.1:9", "HTTPS_PROXY": "http://127.0.0.1:9", "no_proxy": "", "NO_PROXY": ""}
        with _Vendor() as vendor, mock.patch.dict(os.environ, dead):
            vendor.script = [(200, _OK_BODY, {})]
            status, _body = jev_runtime._http_opener(urllib.request.Request(vendor.url(), method="GET"), 2.0)
            self.assertEqual(status, 200)
            self.assertEqual(len(vendor.received), 1)

    def test_a_trickled_body_is_refused_at_the_deadline(self) -> None:
        # Each chunk arrives inside the socket timeout, so only the
        # between-chunk deadline check can stop it (measured before: 14.1 s).
        import time as _time

        class Trickle(BaseHTTPRequestHandler):
            def do_GET(self) -> None:  # noqa: N802 — http.server API
                self.send_response(200)
                self.send_header("Content-Length", str(40 * 100))
                self.end_headers()
                for _ in range(40):
                    self.wfile.write(b"x" * 100)
                    self.wfile.flush()
                    _time.sleep(0.25)

            def log_message(self, *_args: object) -> None:
                return

        server = ThreadingHTTPServer(("127.0.0.1", 0), Trickle)
        threading.Thread(target=server.serve_forever, kwargs={"poll_interval": 0.05}, daemon=True).start()
        try:
            started = _time.monotonic()
            with self.assertRaises(jev_runtime._Refused) as caught:
                jev_runtime._http_opener(
                    urllib.request.Request(f"http://127.0.0.1:{server.server_address[1]}/", method="GET"), 1.0,
                )
            elapsed = _time.monotonic() - started
        finally:
            server.shutdown()
            server.server_close()
        self.assertEqual(caught.exception.reason, "deadline_exceeded")
        self.assertLess(elapsed, 2.0)

    def test_trickled_headers_are_cut_at_the_deadline(self) -> None:
        # Headers arrive one by one inside the socket timeout; only the
        # watchdog closing the socket ends the exchange (measured before: 16.1 s).
        import socketserver
        import time as _time

        class HeaderTrickle(socketserver.StreamRequestHandler):
            def handle(self) -> None:
                self.rfile.readline()
                self.wfile.write(b"HTTP/1.1 200 OK\r\n")
                for index in range(40):
                    try:
                        self.wfile.write(f"X-Slow-{index}: 1\r\n".encode("ascii"))
                        self.wfile.flush()
                    except OSError:
                        return
                    _time.sleep(0.25)

        server = socketserver.ThreadingTCPServer(("127.0.0.1", 0), HeaderTrickle)
        server.daemon_threads = True
        threading.Thread(target=server.serve_forever, kwargs={"poll_interval": 0.05}, daemon=True).start()
        try:
            started = _time.monotonic()
            with self.assertRaises(jev_runtime._Refused) as caught:
                jev_runtime._http_opener(
                    urllib.request.Request(f"http://127.0.0.1:{server.server_address[1]}/", method="GET"), 1.0,
                )
            elapsed = _time.monotonic() - started
        finally:
            server.shutdown()
            server.server_close()
        self.assertEqual(caught.exception.reason, "deadline_exceeded")
        self.assertLess(elapsed, 2.0)

    def test_an_oversized_response_is_refused(self) -> None:
        with _Vendor() as vendor:
            vendor.script = [(200, b"x" * (jev_runtime.MAX_RESPONSE_BYTES + 1), {})]
            with self.assertRaises(jev_runtime._Refused) as caught:
                jev_runtime._http_opener(urllib.request.Request(vendor.url(), method="GET"), 2.0)
        self.assertEqual(caught.exception.reason, "response_too_large")


class BoundedCall(_KeyFile):
    def test_a_redirect_status_is_refused_not_retried(self) -> None:
        result = post_systemone(_PAYLOAD, environ=self.environ, opener=lambda r, t: (307, b""), breaker=CircuitBreaker())
        self.assertEqual(result, JevUnavailable("redirect_refused_http_307"))

    def test_vendor_5xx_is_retried_once_then_answers(self) -> None:
        with _Vendor() as vendor:
            vendor.script = [(503, {"error": "busy"}, {}), (200, _OK_BODY, {})]
            reply = self.call(vendor)
        self.assertIsInstance(reply, JevReply)
        self.assertEqual(len(vendor.received), 2)
        self.assertEqual(self.sleeps, [jev_runtime.RETRY_BACKOFF_SECONDS])

    def test_persistent_5xx_is_unavailable_after_the_bounded_attempts(self) -> None:
        with _Vendor() as vendor:
            vendor.script = [(500, {}, {}), (500, {}, {}), (500, {}, {})]
            result = self.call(vendor)
        self.assertEqual(result, JevUnavailable("vendor_error_http_500"))
        self.assertEqual(len(vendor.received), jev_runtime.MAX_ATTEMPTS)

    def test_auth_rejection_is_not_retried(self) -> None:
        with _Vendor() as vendor:
            vendor.script = [(401, {"error": "bad key"}, {}), (200, _OK_BODY, {})]
            result = self.call(vendor)
        self.assertEqual(result, JevUnavailable("auth_rejected_http_401"))
        self.assertEqual(len(vendor.received), 1)

    def test_malformed_body_is_named(self) -> None:
        bodies = (b"not json", {"answers": {}}, {"model": "jev-1.13.0", "answers": []},
                  {"model": "jev 1.13\r\nX: y", "answers": {}}, b"[" * 30_000)
        for body in bodies:
            with _Vendor() as vendor:
                vendor.script = [(200, body, {})]
                self.assertEqual(self.call(vendor), JevUnavailable("response_malformed"))

    def test_an_unserialisable_payload_names_the_class_only(self) -> None:
        deep: list = []
        for _ in range(100_000):
            deep = [deep]
        for payload, cls in (({"state": object()}, "TypeError"), ({"state": deep}, "RecursionError")):
            with _Vendor() as vendor:
                result = self.call(vendor, payload=payload)
            self.assertEqual(result, JevUnavailable(f"transport_raised:{cls}"))
            self.assertNotIn(_SECRET, repr(result))

    def test_one_deadline_bounds_both_attempts(self) -> None:
        now = [0.0]
        timeouts: list[float] = []

        def opener(request: object, timeout: float) -> tuple[int, bytes]:
            timeouts.append(timeout)
            now[0] += 2.0
            return 503, b""

        post_systemone(_PAYLOAD, environ=self.environ, opener=opener, breaker=CircuitBreaker(),
                       timeout_seconds=600, sleep=lambda _s: None, clock=lambda: now[0])
        self.assertEqual(timeouts[0], jev_runtime.TIMEOUT_CEILING_SECONDS)
        # The second attempt gets only what the first left of the ONE deadline.
        self.assertAlmostEqual(timeouts[1], jev_runtime.TIMEOUT_CEILING_SECONDS - 2.0)

    def test_no_retry_once_the_deadline_is_spent(self) -> None:
        now = [0.0]
        calls: list[float] = []

        def opener(request: object, timeout: float) -> tuple[int, bytes]:
            calls.append(timeout)
            now[0] += 4.95
            return 503, b""

        result = post_systemone(_PAYLOAD, environ=self.environ, opener=opener, breaker=CircuitBreaker(),
                                sleep=lambda _s: None, clock=lambda: now[0])
        self.assertEqual(result, JevUnavailable("vendor_error_http_503"))
        self.assertEqual(len(calls), 1)

    def test_a_reply_completing_after_the_deadline_is_refused(self) -> None:
        now = [0.0]

        def opener(request: object, timeout: float) -> tuple[int, bytes]:
            now[0] += timeout + 1.0
            return 200, json.dumps(_OK_BODY).encode("utf-8")

        result = post_systemone(_PAYLOAD, environ=self.environ, opener=opener, breaker=CircuitBreaker(),
                                sleep=lambda _s: None, clock=lambda: now[0])
        self.assertEqual(result, JevUnavailable("deadline_exceeded"))

    def test_unreachable_vendor_is_a_transport_reason_not_a_raise(self) -> None:
        with _Vendor() as vendor:
            opener = _relay(vendor)
        result = post_systemone(_PAYLOAD, environ=self.environ, opener=opener, breaker=CircuitBreaker(),
                                sleep=self.sleeps.append)
        self.assertIsInstance(result, JevUnavailable)
        assert isinstance(result, JevUnavailable)
        self.assertTrue(result.reason.startswith("transport_"), result.reason)


class Breaker(_KeyFile):
    def test_opens_after_consecutive_failures_and_closes_after_cooldown(self) -> None:
        now = [100.0]
        breaker = CircuitBreaker(threshold=2, cooldown_seconds=30.0, clock=lambda: now[0])
        with _Vendor() as vendor:
            vendor.script = [(401, {}, {}), (401, {}, {}), (200, _OK_BODY, {})]
            self.assertEqual(self.call(vendor, breaker=breaker), JevUnavailable("auth_rejected_http_401"))
            self.assertEqual(self.call(vendor, breaker=breaker), JevUnavailable("auth_rejected_http_401"))
            self.assertEqual(self.call(vendor, breaker=breaker), JevUnavailable("circuit_open"))
            self.assertEqual(len(vendor.received), 2)
            now[0] += 31.0
            self.assertIsInstance(self.call(vendor, breaker=breaker), JevReply)
            self.assertEqual(len(vendor.received), 3)

    def test_a_success_resets_the_failure_count(self) -> None:
        breaker = CircuitBreaker(threshold=2, cooldown_seconds=30.0)
        with _Vendor() as vendor:
            vendor.script = [(401, {}, {}), (200, _OK_BODY, {}), (401, {}, {}), (200, _OK_BODY, {})]
            results = [self.call(vendor, breaker=breaker) for _ in range(4)]
        self.assertNotIn(JevUnavailable("circuit_open"), results)
        self.assertEqual(len(vendor.received), 4)


if __name__ == "__main__":
    unittest.main()
