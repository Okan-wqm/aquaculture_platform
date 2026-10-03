"""System One transport (ARIA-LOW-252) — the credential boundary, the bounded call, the breaker.

The vendor is a local ``http.server`` on 127.0.0.1 reached through the
module's REAL ``urllib`` path (the endpoint is a keyword the tests point at
it; production has one constant host), so the wire is asserted from the
server's side. No external network (test_no_external_network_in_aria_kernel_tests).

One property per test:

* The key comes ONLY from the file ``ARIA_JEV_API_KEY_FILE`` names. An env
  value is never read; a group/world-readable file and an empty or
  multi-line file are refused by name; the key never appears in a result.
* Every failure is a returned ``JevUnavailable`` with a named reason, never an
  exception: transport errors, 4xx, 5xx, a malformed body.
* Retries are bounded (one retry, only for 429/5xx/transport) and the timeout
  never exceeds the 5 s ceiling.
* The breaker opens after consecutive failures and answers ``circuit_open``
  without touching the network until its cooldown passes.
"""
from __future__ import annotations

import json
import os
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from aria_kernel import jev_runtime
from aria_kernel.jev_runtime import CircuitBreaker, JevReply, JevUnavailable, call_systemone

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
    """Scripted stand-in: each POST pops the next (status, body) and records the request."""

    def __init__(self) -> None:
        self.script: list[tuple[int, object]] = []
        self.received: list[dict] = []
        self._server: ThreadingHTTPServer | None = None

    @property
    def endpoint(self) -> str:
        assert self._server is not None
        return f"http://127.0.0.1:{self._server.server_address[1]}/v1/systemone"

    def __enter__(self) -> "_Vendor":
        vendor = self

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self) -> None:  # noqa: N802 — http.server API
                body = self.rfile.read(int(self.headers.get("Content-Length") or 0))
                vendor.received.append({
                    "path": self.path,
                    "authorization": self.headers.get("Authorization"),
                    "json": json.loads(body.decode("utf-8")),
                })
                status, payload = vendor.script.pop(0) if vendor.script else (500, {"error": "unscripted"})
                raw = payload if isinstance(payload, bytes) else json.dumps(payload).encode("utf-8")
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(raw)))
                self.end_headers()
                self.wfile.write(raw)

            def log_message(self, *_args: object) -> None:
                return

        self._server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        threading.Thread(target=self._server.serve_forever, kwargs={"poll_interval": 0.05}, daemon=True).start()
        return self

    def __exit__(self, *_exc: object) -> None:
        assert self._server is not None
        self._server.shutdown()
        self._server.server_close()


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
        return call_systemone(
            _PAYLOAD, environ=self.environ, endpoint=vendor.endpoint,
            breaker=kwargs.pop("breaker", CircuitBreaker()), sleep=self.sleeps.append, **kwargs,
        )


class CredentialBoundary(_KeyFile):
    def test_answer_carries_exact_model_and_tokens_and_the_wire_is_bearer_plus_payload(self) -> None:
        with _Vendor() as vendor:
            vendor.script = [(200, _OK_BODY)]
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
            result = call_systemone(
                _PAYLOAD, environ={"ARIA_JEV_API_KEY": _SECRET}, endpoint=vendor.endpoint,
                breaker=CircuitBreaker(), sleep=self.sleeps.append,
            )
        self.assertEqual(result, JevUnavailable("credential_not_configured"))
        self.assertEqual(vendor.received, [])

    def test_readable_beyond_owner_is_refused_by_name(self) -> None:
        os.chmod(self.key_path, 0o644)
        with _Vendor() as vendor:
            result = self.call(vendor)
        self.assertEqual(result, JevUnavailable("credential_file_permissions"))
        self.assertEqual(vendor.received, [])

    def test_empty_or_multiline_file_is_refused_by_name(self) -> None:
        for content in ("", "a\nb\n"):
            self.key_path.write_text(content, encoding="utf-8")
            with _Vendor() as vendor:
                result = self.call(vendor)
            self.assertEqual(result, JevUnavailable("credential_file_empty"))

    def test_the_key_file_variable_never_reaches_an_agent_child(self) -> None:
        from aria_kernel.agent_env import SECRET_SHAPED_ENV_NAME

        self.assertRegex(jev_runtime.JEV_CREDENTIAL_FILE_ENV, SECRET_SHAPED_ENV_NAME)

    def test_missing_file_is_unreadable_not_a_raise(self) -> None:
        self.environ = {"ARIA_JEV_API_KEY_FILE": str(self.key_path) + ".absent"}
        with _Vendor() as vendor:
            result = self.call(vendor)
        self.assertEqual(result, JevUnavailable("credential_file_unreadable"))


class BoundedCall(_KeyFile):
    def test_vendor_5xx_is_retried_once_then_answers(self) -> None:
        with _Vendor() as vendor:
            vendor.script = [(503, {"error": "busy"}), (200, _OK_BODY)]
            reply = self.call(vendor)
        self.assertIsInstance(reply, JevReply)
        self.assertEqual(len(vendor.received), 2)
        self.assertEqual(self.sleeps, [jev_runtime.RETRY_BACKOFF_SECONDS])

    def test_persistent_5xx_is_unavailable_after_the_bounded_attempts(self) -> None:
        with _Vendor() as vendor:
            vendor.script = [(500, {}), (500, {}), (500, {})]
            result = self.call(vendor)
        self.assertEqual(result, JevUnavailable("vendor_error_http_500"))
        self.assertEqual(len(vendor.received), jev_runtime.MAX_ATTEMPTS)

    def test_auth_rejection_is_not_retried(self) -> None:
        with _Vendor() as vendor:
            vendor.script = [(401, {"error": "bad key"}), (200, _OK_BODY)]
            result = self.call(vendor)
        self.assertEqual(result, JevUnavailable("auth_rejected_http_401"))
        self.assertEqual(len(vendor.received), 1)

    def test_malformed_body_is_named(self) -> None:
        for body in (b"not json", {"answers": {}}, {"model": "jev-1.13.0", "answers": []}):
            with _Vendor() as vendor:
                vendor.script = [(200, body)]
                result = self.call(vendor)
            self.assertEqual(result, JevUnavailable("response_malformed"))

    def test_unreachable_vendor_is_a_transport_reason_not_a_raise(self) -> None:
        with _Vendor() as vendor:
            endpoint = vendor.endpoint
        result = call_systemone(
            _PAYLOAD, environ=self.environ, endpoint=endpoint, breaker=CircuitBreaker(), sleep=self.sleeps.append,
        )
        self.assertIsInstance(result, JevUnavailable)
        assert isinstance(result, JevUnavailable)
        self.assertTrue(result.reason.startswith("transport_"), result.reason)

    def test_timeout_never_exceeds_the_ceiling(self) -> None:
        seen: list[float] = []

        def opener(request: object, timeout: float) -> tuple[int, bytes]:
            seen.append(timeout)
            return 200, json.dumps(_OK_BODY).encode("utf-8")

        reply = call_systemone(
            _PAYLOAD, environ=self.environ, opener=opener, breaker=CircuitBreaker(), timeout_seconds=600,
        )
        self.assertIsInstance(reply, JevReply)
        self.assertEqual(seen, [jev_runtime.TIMEOUT_CEILING_SECONDS])
        self.assertLessEqual(jev_runtime.TIMEOUT_CEILING_SECONDS, 5.0)


class Breaker(_KeyFile):
    def test_opens_after_consecutive_failures_and_closes_after_cooldown(self) -> None:
        now = [100.0]
        breaker = CircuitBreaker(threshold=2, cooldown_seconds=30.0, clock=lambda: now[0])
        with _Vendor() as vendor:
            vendor.script = [(401, {}), (401, {}), (200, _OK_BODY)]
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
            vendor.script = [(401, {}), (200, _OK_BODY), (401, {}), (200, _OK_BODY)]
            results = [self.call(vendor, breaker=breaker) for _ in range(4)]
        self.assertNotIn(JevUnavailable("circuit_open"), results)
        self.assertEqual(len(vendor.received), 4)


if __name__ == "__main__":
    unittest.main()
