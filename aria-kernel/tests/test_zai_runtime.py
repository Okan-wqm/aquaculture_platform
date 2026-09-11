"""Z.ai runtime — the distinct transport, its credential boundary, its classifications.

Every network-shaped test talks to a local ``http.server`` on 127.0.0.1 through
the module's REAL ``urllib`` path, so the classification is exercised on actual
HTTP status lines and bodies rather than on a hand-built response object. No
external network (test_no_external_network_in_aria_kernel_tests).

What this pins, one property per test:

* The credential comes from ONE boundary. File wins when named; a file plus an
  env value is an ambiguity refusal; a group/world-readable file is refused
  by name; an empty or multi-line file is refused by name; nothing set is
  ``credential_not_configured``.
* The secret never appears in ``repr``, ``str``, dataclass equality, an
  exception message, a status row or a settings hash.
* The probe classifies 200 / 401 / 429 / 4xx-business-code / 5xx / transport
  failure into the (auth, quota, reason) triple the fleet admission reads,
  and records the vendor's code and message verbatim.
* A chat run returns the assistant content and the vendor's usage block as
  ``{input_tokens, output_tokens}``; a 200 with no usage yields ``usage=None``
  (the executor refuses to price that as zero); a 401 is an auth failure and a
  429 a credit exhaustion, exactly the fields the executor already reads from
  the Codex runtime.
* The Authorization header the vendor receives is ``Bearer <secret>`` and the
  request body carries the model and both messages — proven from the
  server's side, not the client's.
* The Anthropic-protocol route is not among the endpoints: this module does
  not redirect anything that speaks Anthropic Messages.
"""
from __future__ import annotations

import json
import os
import stat
import sys
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

_POC = Path(__file__).resolve().parents[2] / "tools" / "aria-poc"
if str(_POC) not in sys.path:
    sys.path.insert(0, str(_POC))

import zai_runtime  # noqa: E402


class _Vendor:
    """A scripted Z.ai stand-in: each request pops the next (status, body) and
    records what it received, so tests assert on the wire, not on intent."""

    def __init__(self) -> None:
        self.script: list[tuple[int, dict]] = []
        self.received: list[dict] = []
        self._server: ThreadingHTTPServer | None = None
        self._thread: threading.Thread | None = None

    @property
    def base_url(self) -> str:
        assert self._server is not None
        return f"http://127.0.0.1:{self._server.server_address[1]}"

    def start(self) -> "_Vendor":
        vendor = self

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self) -> None:  # noqa: N802 — http.server API
                length = int(self.headers.get("Content-Length") or 0)
                body = self.rfile.read(length)
                vendor.received.append({
                    "path": self.path,
                    "authorization": self.headers.get("Authorization"),
                    "content_type": self.headers.get("Content-Type"),
                    "user_agent": self.headers.get("User-Agent"),
                    "json": json.loads(body.decode("utf-8")),
                })
                status, payload = vendor.script.pop(0) if vendor.script else (500, {"error": {"code": "0", "message": "unscripted"}})
                raw = json.dumps(payload).encode("utf-8")
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(raw)))
                self.end_headers()
                self.wfile.write(raw)

            def log_message(self, *args: object) -> None:  # silence
                return

        self._server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self._thread = threading.Thread(target=self._server.serve_forever, daemon=True)
        self._thread.start()
        return self

    def stop(self) -> None:
        if self._server is not None:
            self._server.shutdown()
            self._server.server_close()


def _ok_completion(content: str = "OK", *, usage: dict | None = None, model: str = "glm-5.3") -> dict:
    payload = {
        "id": "chatcmpl-fixture", "model": model,
        "choices": [{"index": 0, "finish_reason": "stop", "message": {"role": "assistant", "content": content}}],
    }
    if usage is not None:
        payload["usage"] = usage
    return payload


def _vendor_error(code: str, message: str) -> dict:
    return {"error": {"code": code, "message": message}}


class CredentialBoundary(unittest.TestCase):
    SECRET = "zai-fixture-secret-value-not-a-real-key"

    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="aria-zai-cred-"))
        self.addCleanup(lambda: __import__("shutil").rmtree(self.tmp, ignore_errors=True))

    def _key_file(self, content: str, mode: int = 0o600) -> Path:
        path = self.tmp / "zai.key"
        path.write_text(content, encoding="utf-8")
        os.chmod(path, mode)
        return path

    def test_nothing_configured_is_named(self) -> None:
        with self.assertRaises(zai_runtime.ZaiCredentialUnavailable) as caught:
            zai_runtime.read_zai_credential({})
        self.assertEqual(caught.exception.reason, "credential_not_configured")
        self.assertFalse(zai_runtime.zai_credential_configured({}))

    def test_a_0600_file_is_the_credential(self) -> None:
        path = self._key_file(self.SECRET + "\n")
        credential = zai_runtime.read_zai_credential({zai_runtime.ZAI_CREDENTIAL_FILE_ENV: str(path)})
        self.assertEqual(credential.source, "file")
        self.assertEqual(credential.location, str(path))
        self.assertEqual(credential.authorization_header(), "Bearer " + self.SECRET)
        self.assertTrue(zai_runtime.zai_credential_configured({zai_runtime.ZAI_CREDENTIAL_FILE_ENV: str(path)}))

    def test_a_group_or_world_readable_file_is_refused_by_name(self) -> None:
        path = self._key_file(self.SECRET, mode=0o640)
        with self.assertRaises(zai_runtime.ZaiCredentialUnavailable) as caught:
            zai_runtime.read_zai_credential({zai_runtime.ZAI_CREDENTIAL_FILE_ENV: str(path)})
        self.assertEqual(caught.exception.reason, "credential_file_permissions")
        self.assertNotIn(self.SECRET, str(caught.exception))

    def test_an_empty_or_multiline_file_is_refused_by_name(self) -> None:
        for content in ("", "\n", "line-one\nline-two\n"):
            path = self._key_file(content)
            with self.subTest(content=repr(content)):
                with self.assertRaises(zai_runtime.ZaiCredentialUnavailable) as caught:
                    zai_runtime.read_zai_credential({zai_runtime.ZAI_CREDENTIAL_FILE_ENV: str(path)})
                self.assertEqual(caught.exception.reason, "credential_file_empty")

    def test_a_missing_file_is_refused_by_name(self) -> None:
        with self.assertRaises(zai_runtime.ZaiCredentialUnavailable) as caught:
            zai_runtime.read_zai_credential({zai_runtime.ZAI_CREDENTIAL_FILE_ENV: str(self.tmp / "absent")})
        self.assertEqual(caught.exception.reason, "credential_file_unreadable")

    def test_the_env_form_is_accepted_for_ci_injection(self) -> None:
        credential = zai_runtime.read_zai_credential({zai_runtime.ZAI_CREDENTIAL_ENV: self.SECRET})
        self.assertEqual(credential.source, "env")
        self.assertEqual(credential.location, zai_runtime.ZAI_CREDENTIAL_ENV)
        self.assertEqual(credential.authorization_header(), "Bearer " + self.SECRET)

    def test_two_sources_at_once_are_an_ambiguity_refusal(self) -> None:
        path = self._key_file(self.SECRET)
        with self.assertRaises(zai_runtime.ZaiCredentialUnavailable) as caught:
            zai_runtime.read_zai_credential({
                zai_runtime.ZAI_CREDENTIAL_FILE_ENV: str(path),
                zai_runtime.ZAI_CREDENTIAL_ENV: "other",
            })
        self.assertEqual(caught.exception.reason, "credential_sources_ambiguous")

    def test_the_secret_never_leaks_through_repr_str_eq_or_the_settings_hash(self) -> None:
        credential = zai_runtime.read_zai_credential({zai_runtime.ZAI_CREDENTIAL_ENV: self.SECRET})
        self.assertNotIn(self.SECRET, repr(credential))
        self.assertNotIn(self.SECRET, str(credential))
        self.assertNotIn(self.SECRET, json.dumps(credential.__dict__.get("source")))
        twin = zai_runtime.read_zai_credential({zai_runtime.ZAI_CREDENTIAL_ENV: "different-secret"})
        self.assertEqual(credential, twin, "equality must not compare the secret")
        digest = zai_runtime.zai_settings_hash(endpoint="coding", base_url="https://x", model="glm-5.3")
        self.assertTrue(digest.startswith("sha256:"))
        self.assertNotIn(self.SECRET, digest)

    def test_endpoint_and_model_resolution(self) -> None:
        self.assertEqual(zai_runtime.resolve_zai_endpoint({}), ("coding", zai_runtime.ZAI_ENDPOINTS["coding"]))
        self.assertEqual(zai_runtime.resolve_zai_endpoint({zai_runtime.ZAI_ENDPOINT_ENV: "general"})[0], "general")
        with self.assertRaises(zai_runtime.ZaiCredentialUnavailable) as caught:
            zai_runtime.resolve_zai_endpoint({zai_runtime.ZAI_ENDPOINT_ENV: "anthropic"})
        self.assertEqual(caught.exception.reason, "endpoint_unknown")
        self.assertEqual(zai_runtime.resolve_zai_endpoint({zai_runtime.ZAI_ENDPOINT_ENV: "https://gw.example/v4/"}),
                         ("custom", "https://gw.example/v4"))
        self.assertEqual(zai_runtime.resolve_zai_model({}), zai_runtime.DEFAULT_ZAI_MODEL)
        self.assertEqual(zai_runtime.resolve_zai_model({zai_runtime.ZAI_MODEL_ENV: "glm-5"}), "glm-5")

    def test_no_anthropic_protocol_route_exists_here(self) -> None:
        self.assertEqual(set(zai_runtime.ZAI_ENDPOINTS), {"coding", "general"})
        for url in zai_runtime.ZAI_ENDPOINTS.values():
            self.assertNotIn("anthropic", url)


class _VendorCase(unittest.TestCase):
    SECRET = "zai-fixture-secret-value-not-a-real-key"

    def setUp(self) -> None:
        self.vendor = _Vendor().start()
        self.addCleanup(self.vendor.stop)
        self.credential = zai_runtime.read_zai_credential({zai_runtime.ZAI_CREDENTIAL_ENV: self.SECRET})

    def probe(self) -> zai_runtime.ZaiStatusObservation:
        return zai_runtime.probe_zai_status(
            self.credential, endpoint="coding", base_url=self.vendor.base_url,
            model="glm-5.3", timeout_seconds=5,
        )


class ProbeClassification(_VendorCase):
    def test_a_completion_is_auth_and_quota_available(self) -> None:
        self.vendor.script.append((200, _ok_completion(usage={"prompt_tokens": 9, "completion_tokens": 1})))
        seen = self.probe()
        self.assertEqual((seen.auth_observation, seen.quota_observation, seen.reason),
                         ("available", "available", "chat_completion_ok"))
        self.assertEqual(seen.http_status, 200)
        self.assertEqual(self.vendor.received[0]["path"], "/chat/completions")
        self.assertEqual(self.vendor.received[0]["json"]["max_tokens"], 1)
        self.assertEqual(self.vendor.received[0]["json"]["model"], "glm-5.3")

    def test_a_401_is_auth_unavailable_and_keeps_the_vendor_code(self) -> None:
        self.vendor.script.append((401, _vendor_error("1001", "Authentication parameter not received in Header")))
        seen = self.probe()
        self.assertEqual(seen.auth_observation, "unavailable")
        self.assertEqual(seen.error_code, "1001")
        self.assertIn("Authentication", seen.error_message or "")
        self.assertNotIn(self.SECRET, json.dumps(seen.as_row()))

    def test_a_429_is_quota_exhausted_with_auth_still_available(self) -> None:
        self.vendor.script.append((429, _vendor_error("1302", "rate limit")))
        seen = self.probe()
        self.assertEqual((seen.auth_observation, seen.quota_observation), ("available", "exhausted"))

    def test_a_balance_business_code_is_quota_exhausted_even_on_a_generic_status(self) -> None:
        self.vendor.script.append((400, _vendor_error("1113", "insufficient balance")))
        seen = self.probe()
        self.assertEqual((seen.auth_observation, seen.quota_observation), ("available", "exhausted"))
        self.assertEqual(seen.error_code, "1113")

    def test_an_authenticated_refusal_is_named_not_admitted(self) -> None:
        self.vendor.script.append((404, _vendor_error("1211", "model not found")))
        seen = self.probe()
        self.assertEqual((seen.auth_observation, seen.quota_observation), ("available", "unknown"))
        self.assertEqual(seen.reason, "request_refused_http_404")

    def test_a_vendor_5xx_is_unknown_not_a_verdict(self) -> None:
        self.vendor.script.append((503, {"error": {"code": "9999", "message": "upstream"}}))
        seen = self.probe()
        self.assertEqual((seen.auth_observation, seen.quota_observation), ("unknown", "unknown"))

    def test_a_dead_endpoint_is_a_transport_observation(self) -> None:
        self.vendor.stop()
        seen = self.probe()
        self.assertEqual((seen.auth_observation, seen.quota_observation), ("unknown", "unknown"))
        self.assertTrue(seen.reason.startswith("transport_"), seen.reason)
        self.assertIsNone(seen.http_status)


class ChatRun(_VendorCase):
    def run_chat(self) -> zai_runtime.ZaiRunResult:
        return zai_runtime.run_zai_chat(
            self.credential, base_url=self.vendor.base_url, model="glm-5.3",
            system="You are an ARIA judge.", user="Return the JSON envelope.", timeout_seconds=5,
            max_tokens=64,
        )

    def test_the_wire_carries_bearer_auth_model_and_both_messages(self) -> None:
        self.vendor.script.append((200, _ok_completion('{"verdict":"ok"}', usage={"prompt_tokens": 20, "completion_tokens": 5})))
        result = self.run_chat()
        wire = self.vendor.received[0]
        self.assertEqual(wire["authorization"], "Bearer " + self.SECRET)
        self.assertEqual(wire["content_type"], "application/json")
        self.assertEqual(wire["user_agent"], zai_runtime.USER_AGENT)
        self.assertEqual(wire["json"]["model"], "glm-5.3")
        self.assertEqual([m["role"] for m in wire["json"]["messages"]], ["system", "user"])
        self.assertFalse(wire["json"]["stream"])
        self.assertEqual(wire["json"]["max_tokens"], 64)
        self.assertNotIn("response_format", wire["json"], "JSON mode is off by default (glm-5.3 mangles .json paths under it)")
        self.assertNotIn("reasoning_effort", wire["json"], "no effort given, vendor default kept")
        self.assertEqual(result.returncode, 0)
        self.assertEqual(result.final_message, '{"verdict":"ok"}')
        self.assertEqual(result.usage, {"input_tokens": 20, "output_tokens": 5})
        self.assertEqual(result.response_id, "chatcmpl-fixture")
        self.assertEqual(result.finish_reason, "stop")
        self.assertIsNone(result.auth_failure)
        self.assertIsNone(result.credit_exhaustion)

    def test_the_route_effort_maps_onto_the_vendor_vocabulary(self) -> None:
        for effort, expected in (("ultra", "max"), ("xhigh", "max"), ("high", "high"), ("low", "low")):
            self.vendor.script.append((200, _ok_completion("x", usage={"prompt_tokens": 1, "completion_tokens": 1})))
            zai_runtime.run_zai_chat(self.credential, base_url=self.vendor.base_url, model="glm-5.3",
                                     system="s", user="u", timeout_seconds=5, reasoning_effort=effort)
            with self.subTest(effort=effort):
                self.assertEqual(self.vendor.received[-1]["json"]["reasoning_effort"], expected)

    def test_a_length_finish_with_empty_content_is_named_not_a_mystery(self) -> None:
        payload = _ok_completion("", usage={"prompt_tokens": 17230, "completion_tokens": 8192})
        payload["choices"][0]["finish_reason"] = "length"
        payload["choices"][0]["message"]["reasoning_content"] = "..." * 100
        self.vendor.script.append((200, payload))
        result = self.run_chat()
        self.assertEqual(result.returncode, 1)
        self.assertEqual(result.finish_reason, "length")
        self.assertEqual(result.error_code, "output_budget_exhausted")
        self.assertIsNone(result.auth_failure)
        self.assertIsNone(result.credit_exhaustion)
        self.assertEqual(result.usage, {"input_tokens": 17230, "output_tokens": 8192})

    def test_json_object_mode_is_opt_in(self) -> None:
        self.assertFalse(zai_runtime.resolve_zai_json_object({}))
        self.assertTrue(zai_runtime.resolve_zai_json_object({zai_runtime.ZAI_JSON_OBJECT_ENV: "1"}))
        self.vendor.script.append((200, _ok_completion("x", usage={"prompt_tokens": 1, "completion_tokens": 1})))
        zai_runtime.run_zai_chat(self.credential, base_url=self.vendor.base_url, model="glm-5.3",
                                 system="s", user="u", timeout_seconds=5, json_object=True)
        self.assertEqual(self.vendor.received[-1]["json"]["response_format"], {"type": "json_object"})

    def test_the_max_tokens_default_and_operator_override(self) -> None:
        self.assertEqual(zai_runtime.resolve_zai_max_tokens({}), zai_runtime.DEFAULT_ZAI_MAX_TOKENS)
        self.assertEqual(zai_runtime.resolve_zai_max_tokens({zai_runtime.ZAI_MAX_TOKENS_ENV: "4096"}), 4096)
        with self.assertRaises(zai_runtime.ZaiCredentialUnavailable):
            zai_runtime.resolve_zai_max_tokens({zai_runtime.ZAI_MAX_TOKENS_ENV: "lots"})

    def test_a_200_without_usage_leaves_usage_none(self) -> None:
        self.vendor.script.append((200, _ok_completion("text")))
        result = self.run_chat()
        self.assertEqual(result.returncode, 0)
        self.assertIsNone(result.usage)

    def test_a_401_is_an_auth_failure_with_no_message(self) -> None:
        self.vendor.script.append((401, _vendor_error("1002", "invalid api key")))
        result = self.run_chat()
        self.assertEqual(result.returncode, 1)
        self.assertEqual(result.auth_failure, "auth_rejected_http_401")
        self.assertEqual(result.final_message, "")
        self.assertNotIn(self.SECRET, repr(result))

    def test_a_429_is_credit_exhaustion(self) -> None:
        self.vendor.script.append((429, _vendor_error("1302", "rate limit")))
        result = self.run_chat()
        self.assertEqual(result.credit_exhaustion, "quota_or_rate_limited_http_429")
        self.assertIsNone(result.auth_failure)

    def test_a_dead_endpoint_raises_the_named_transport_error(self) -> None:
        self.vendor.stop()
        with self.assertRaises(zai_runtime.ZaiTransportUnavailable) as caught:
            self.run_chat()
        self.assertNotIn(self.SECRET, str(caught.exception))


if __name__ == "__main__":
    unittest.main()
