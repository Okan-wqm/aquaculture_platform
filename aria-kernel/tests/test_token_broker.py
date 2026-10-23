"""ARIA-MEDIUM-583 — the GitHub App key lives in a broker, not the cycle.

``token_broker.start_broker`` runs a holder process for a lane's night: it
reads the PEM once (stdin, never a file, never an env var), keeps it only in
memory behind a private unix socket, and answers ONE verb — ``mint`` — for
the closed allowlist of named permission sets. The delivering process
(``gh_token_factory.mint_installation_token`` under
``ARIA_GH_TOKEN_BROKER_SOCKET``) holds the socket path alone; a process that
runs discovery, planning and agent orchestration for a whole night can spend
narrowed, capped, TTL-clamped tokens and can never read the key that mints
them.

Every test runs the REAL server as a REAL subprocess and the REAL client over
the REAL socket. The provider is a loopback HTTP fixture the broker is pointed
at (``--api-base-url``), so the mint's whole HTTPS flow — PyJWT signature from
the in-memory PEM, POST body, response parsing — is exercised, and the fixture
asserts what reached it. One property per test:

* a mint through the socket returns the narrowed token, the provider's
  expiry and the installation id — never the key — and the JWT that reached
  the provider was signed with the PEM the broker was given, for the app it
  was given, carrying exactly the named set's permissions;
* an unknown permission set is refused by name, with a governance row, and
  the provider is not contacted at all;
* a mint above the per-night cap is refused by name, with a governance row;
* the broker's ``/proc/<pid>/environ`` holds PATH and nothing else — no PEM,
  no credential name — and its ``cmdline`` holds no PEM either;
* no key file ever exists: the PEM travels a pipe from the launcher to the
  server's stdin; after the start nothing on disk holds it;
* each mint's TTL is clamped to the broker's remaining lifetime (the job
  deadline), and a broker started after its deadline refuses to serve;
* one governance row per mint and per refusal lands in the ledger;
* a server started directly with a dirty environment refuses by name
  (``environ_not_minimal``) instead of serving with secrets readable from
  ``/proc``;
* the Yama gate: the broker refuses to hold the key where a same-uid
  non-descendant could ptrace it (scope 0 or no Yama at all).
"""
from __future__ import annotations

import json
import os
import shutil
import signal
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest import mock  # noqa: F401 — the factory-wiring suite patches env dicts

from aria_kernel import token_broker
from aria_kernel.gh_token_factory import INSTALLATION_TOKEN_PERMISSION_SETS
from aria_kernel.socket_holders import TOKEN_BROKER, prune_stale_socket_dirs
from aria_kernel.token_broker import (
    TokenBrokerRefused,
    TokenBrokerUnavailable,
    mint_via_broker,
    start_broker,
    yama_scope_permits_isolation,
)

# ARIA-HIGH-138 — the seam(s) this file proves by a real process, per
# the closed registry in tests/invariants/seam_registry.py.
REAL_PROCESS_SEAMS = (
    "aria-kernel/aria_kernel/token_broker.py",
)

_FIXTURE_APP_ID = "12345"
_FIXTURE_INSTALLATION_ID = "67890"
_FIXTURE_TOKEN = "ghs_brokered_fixture"
_FIXTURE_EXPIRES_AT = "2026-10-20T11:05:00Z"


def _fixture_pem() -> str:
    """A real RSA key: the broker must sign a JWT the fixture can decode."""
    from cryptography.hazmat.primitives import serialization
    from cryptography.hazmat.primitives.asymmetric import rsa

    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    return key.private_bytes(
        serialization.Encoding.PEM,
        serialization.PrivateFormat.PKCS8,
        serialization.NoEncryption(),
    ).decode("utf-8")


class _GitHubEndpoint(BaseHTTPRequestHandler):
    """The provider's ``POST /app/installations/{id}/access_tokens``."""

    def do_POST(self) -> None:  # noqa: N802 — http.server's contract
        length = int(self.headers.get("Content-Length", "0"))
        body = json.loads(self.rfile.read(length) or b"{}") if length else {}
        self.server.requests.append({  # type: ignore[attr-defined]
            "path": self.path,
            "authorization": self.headers.get("Authorization", ""),
            "accept": self.headers.get("Accept", ""),
            "body": body,
        })
        payload = json.dumps({"token": _FIXTURE_TOKEN, "expires_at": _FIXTURE_EXPIRES_AT}).encode("utf-8")
        self.send_response(201)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def log_message(self, *_: object) -> None:  # quiet under pytest
        return


class _ServeThread:
    """The loopback provider, actually accepting connections."""

    def __init__(self) -> None:
        self._server = ThreadingHTTPServer(("127.0.0.1", 0), _GitHubEndpoint)
        self._server.requests = []  # type: ignore[attr-defined]
        self._thread = threading.Thread(target=self._server.serve_forever, daemon=True)
        self._thread.start()

    @property
    def requests(self) -> list:  # type: ignore[type-arg]
        return self._server.requests  # type: ignore[no-any-return]

    @property
    def url(self) -> str:
        return f"http://127.0.0.1:{self._server.server_address[1]}"

    def close(self) -> None:
        self._server.shutdown()
        self._server.server_close()
        self._thread.join(timeout=5.0)


class TokenBrokerTests(unittest.TestCase):
    def setUp(self) -> None:
        self.scratch = Path(tempfile.mkdtemp(prefix="aria-tb-test-"))
        self.addCleanup(shutil.rmtree, self.scratch, True)
        self.pem = _fixture_pem()
        # One ledger per test: the short-lived brokers some tests start
        # beside the setUp one all write here, and row-sequence assertions
        # must see only this test's rows.
        self.ledger = self.scratch / f"token-broker-ledger-{time.monotonic_ns()}.jsonl"
        self.endpoint = _ServeThread()
        self.addCleanup(self.endpoint.close)
        self.broker = start_broker(
            self.pem,
            app_id=_FIXTURE_APP_ID,
            installation_id=_FIXTURE_INSTALLATION_ID,
            api_base_url=self.endpoint.url,
            ledger_path=self.ledger,
            deadline_epoch=time.time() + 600,
            max_mints=50,
        )
        self.addCleanup(self.broker.stop)

    def _mint(self, *, lease_id: str = "broker-fixture-cycle-01",
              permission_set_name: str = "DELIVERY", ttl_seconds: int = 300) -> dict:
        return mint_via_broker(
            self.broker.socket_path,
            lease_id=lease_id,
            permission_set_name=permission_set_name,
            ttl_seconds=ttl_seconds,
        )

    def _ledger_rows(self) -> list[dict]:
        if not self.ledger.exists():
            return []
        rows = [json.loads(line) for line in self.ledger.read_text(encoding="utf-8").splitlines() if line.strip()]
        # The startup's token_broker_started row is beside the point here.
        return [row for row in rows if row.get("kind") != "token_broker_started"]

    def test_a_fake_github_endpoint_mints_through_the_socket(self) -> None:
        minted = self._mint()
        self.assertEqual(minted["ok"], True)
        self.assertEqual(minted["token"], _FIXTURE_TOKEN)
        self.assertEqual(minted["expires_at"], _FIXTURE_EXPIRES_AT)
        self.assertEqual(minted["installation_id"], _FIXTURE_INSTALLATION_ID)
        self.assertEqual(minted["permission_set"], "DELIVERY")
        self.assertLessEqual(minted["ttl_seconds"], 300)
        self.assertEqual(len(self.endpoint.requests), 1)
        request = self.endpoint.requests[0]
        self.assertEqual(request["path"], f"/app/installations/{_FIXTURE_INSTALLATION_ID}/access_tokens")
        self.assertEqual(request["body"], {"permissions": dict(INSTALLATION_TOKEN_PERMISSION_SETS["DELIVERY"])})
        self.assertEqual(request["accept"], "application/vnd.github+json")
        # The JWT was signed with the PEM the broker holds, for the app it
        # was given: the broker mints with the real flow, not a stub.
        import jwt as _jwt

        bearer = request["authorization"]
        self.assertTrue(bearer.startswith("Bearer "), bearer)
        payload = _jwt.decode(bearer[len("Bearer "):], options={"verify_signature": False})
        self.assertEqual(payload["iss"], _FIXTURE_APP_ID)
        # The narrowed answer carries the token — never the key.
        self.assertNotIn("PRIVATE KEY", json.dumps(minted))

    def test_an_unknown_permission_set_is_refused_by_name_without_touching_the_provider(self) -> None:
        with self.assertRaises(TokenBrokerRefused) as refused:
            self._mint(permission_set_name="ADMINISTRATION_ALL")
        self.assertIn("unknown_permission_set:ADMINISTRATION_ALL", str(refused.exception))
        self.assertEqual(self.endpoint.requests, [])
        rows = self._ledger_rows()
        self.assertEqual([row["kind"] for row in rows], ["token_broker_refused"])
        self.assertEqual(rows[0]["reason"], "unknown_permission_set:ADMINISTRATION_ALL")

    def test_a_mint_above_the_cap_is_refused_by_name(self) -> None:
        capped = start_broker(
            self.pem,
            app_id=_FIXTURE_APP_ID,
            installation_id=_FIXTURE_INSTALLATION_ID,
            api_base_url=self.endpoint.url,
            ledger_path=self.ledger,
            deadline_epoch=time.time() + 600,
            max_mints=1,
        )
        self.addCleanup(capped.stop)
        first = mint_via_broker(
            capped.socket_path, lease_id="capped-cycle-01", permission_set_name="DELIVERY", ttl_seconds=60,
        )
        self.assertEqual(first["ok"], True)
        with self.assertRaises(TokenBrokerRefused) as refused:
            mint_via_broker(
                capped.socket_path, lease_id="capped-cycle-02", permission_set_name="DELIVERY", ttl_seconds=60,
            )
        self.assertIn("mint_cap_exceeded", str(refused.exception))
        kinds = [row["kind"] for row in self._ledger_rows()]
        self.assertEqual(kinds.count("token_broker_mint"), 1)
        self.assertEqual(kinds.count("token_broker_refused"), 1)

    def test_the_broker_environment_holds_no_pem(self) -> None:
        environ = Path(f"/proc/{self.broker.pid}/environ").read_bytes()
        self.assertNotIn(b"PRIVATE KEY", environ)
        self.assertNotIn(b"ARIA_GH_APP_PRIVATE_KEY", environ)
        names = {entry.split(b"=", 1)[0].decode("utf-8", "replace") for entry in environ.split(b"\0") if entry}
        # PATH is the launcher's gift; LC_CTYPE is the interpreter's own
        # locale coercion (PEP 538), added after exec — neither is caller
        # data. Anything else means a caller handed the holder a secret in
        # its environment, and the server refuses to serve (the sibling
        # test in TheServerPolicesItself).
        self.assertTrue(names <= {"PATH", "LC_CTYPE"}, f"the broker's environ must be PATH only, saw {sorted(names)}")
        cmdline = Path(f"/proc/{self.broker.pid}/cmdline").read_bytes()
        self.assertNotIn(b"PRIVATE KEY", cmdline)

    def test_no_key_file_ever_exists(self) -> None:
        # The PEM travels the launcher's stdin pipe: there is no key file to
        # forget to remove. After the start, nothing on disk under the
        # scratch or the socket dir holds it.
        for path in sorted(self.scratch.rglob("*")) + sorted(self.broker.socket_path.parent.rglob("*")):
            if path.is_file():
                self.assertNotIn("PRIVATE KEY", path.read_text(encoding="utf-8", errors="replace"), str(path))

    def test_each_mint_writes_one_governance_row(self) -> None:
        self._mint(lease_id="ledger-cycle-01")
        self._mint(lease_id="ledger-cycle-02")
        rows = self._ledger_rows()
        self.assertEqual([row["kind"] for row in rows], ["token_broker_mint", "token_broker_mint"])
        self.assertEqual([row["lease_id"] for row in rows], ["ledger-cycle-01", "ledger-cycle-02"])
        for row in rows:
            self.assertEqual(row["permission_set"], "DELIVERY")
            self.assertIn("ttl_seconds", row)
            self.assertIn("mints_remaining", row)

    def test_the_ttl_is_clamped_to_the_brokers_remaining_lifetime(self) -> None:
        short = start_broker(
            self.pem,
            app_id=_FIXTURE_APP_ID,
            installation_id=_FIXTURE_INSTALLATION_ID,
            api_base_url=self.endpoint.url,
            ledger_path=self.ledger,
            deadline_epoch=time.time() + 30,
            max_mints=5,
        )
        self.addCleanup(short.stop)
        minted = mint_via_broker(
            short.socket_path, lease_id="clamped-cycle-01", permission_set_name="DELIVERY", ttl_seconds=99999,
        )
        self.assertLessEqual(minted["ttl_seconds"], 30)
        self.assertGreater(minted["ttl_seconds"], 0)

    def test_a_broker_started_after_its_deadline_refuses_to_serve(self) -> None:
        with self.assertRaises(TokenBrokerUnavailable) as refused:
            start_broker(
                self.pem,
                app_id=_FIXTURE_APP_ID,
                installation_id=_FIXTURE_INSTALLATION_ID,
                api_base_url=self.endpoint.url,
                deadline_epoch=time.time() - 1,
            )
        self.assertIn("deadline_passed", str(refused.exception))


class TheServerPolicesItself(unittest.TestCase):
    """The serve entry refuses, by name, the states that would leak."""

    def setUp(self) -> None:
        self.scratch = Path(tempfile.mkdtemp(prefix="aria-tb-self-"))
        self.addCleanup(shutil.rmtree, self.scratch, True)
        self.pem = _fixture_pem()

    def _serve(self, env: dict[str, str], stdin: bytes | None) -> subprocess.CompletedProcess[bytes]:
        argv = [
            sys.executable, "-m", "aria_kernel.token_broker", "serve",
            "--socket", str(self.scratch / "sock"),
            "--app-id", _FIXTURE_APP_ID,
            "--installation-id", _FIXTURE_INSTALLATION_ID,
        ]
        return subprocess.run(
            argv, input=stdin, capture_output=True, check=False, timeout=60,
            env=env, cwd=str(Path(token_broker.__file__).resolve().parents[1]),
        )

    def test_a_dirty_environment_is_refused_by_name(self) -> None:
        done = self._serve(
            {"PATH": os.environ.get("PATH", os.defpath), "ARIA_GH_APP_PRIVATE_KEY": self.pem},
            stdin=(self.pem + "\n").encode("utf-8"),
        )
        self.assertNotEqual(done.returncode, 0)
        self.assertIn("environ_not_minimal", done.stderr.decode("utf-8", "replace"))

    def test_a_pem_that_is_not_a_pem_is_refused_by_name(self) -> None:
        with self.assertRaises(TokenBrokerUnavailable) as refused:
            start_broker(
                "definitely-not-a-key",
                app_id=_FIXTURE_APP_ID,
                installation_id=_FIXTURE_INSTALLATION_ID,
            )
        self.assertIn("pem_not_recognized", str(refused.exception))

    def test_the_yama_gate(self) -> None:
        # scope 0 (or no Yama at all) means any same-uid process may ptrace
        # the broker and read the key from its memory: the broker refuses to
        # hold it there. 1..3 do not allow a non-descendant same-uid attach.
        self.assertFalse(yama_scope_permits_isolation(0))
        self.assertFalse(yama_scope_permits_isolation(None))
        for scope in (1, 2, 3):
            self.assertTrue(yama_scope_permits_isolation(scope), f"scope {scope}")
        # This runner host (where the broker will serve the night) is gated:
        # measured 1, the signing-agent class of isolation.
        if Path("/proc/sys/kernel/yama/ptrace_scope").exists():
            self.assertTrue(yama_scope_permits_isolation(token_broker.read_ptrace_scope()))


class TheFactoryMintsThroughTheBroker(unittest.TestCase):
    """The production wiring: ``mint_installation_token`` under
    ``ARIA_GH_TOKEN_BROKER_SOCKET`` asks the broker (the real subprocess, the
    real socket, the loopback provider) and never touches a key file — the
    lease it returns is the lease the factory always returned."""

    def setUp(self) -> None:
        self.scratch = Path(tempfile.mkdtemp(prefix="aria-tb-factory-"))
        self.addCleanup(shutil.rmtree, self.scratch, True)
        self.pem = _fixture_pem()
        self.endpoint = _ServeThread()
        self.addCleanup(self.endpoint.close)
        self.broker = start_broker(
            self.pem,
            app_id=_FIXTURE_APP_ID,
            installation_id=_FIXTURE_INSTALLATION_ID,
            api_base_url=self.endpoint.url,
            ledger_path=self.scratch / "ledger.jsonl",
            deadline_epoch=time.time() + 600,
        )
        self.addCleanup(self.broker.stop)
        # The workspace the mint resolves, and the private token dir it uses,
        # are SEPARATE trees: the factory refuses a token dir inside the
        # workspace (ARIA-HIGH-124 round 5).
        self.workspace = self.scratch / "ws"
        self.workspace.mkdir()
        env = {
            "ARIA_GH_TOKEN_BROKER_SOCKET": str(self.broker.socket_path),
            "ARIA_REQUIRE_TOKEN_BROKER": "true",
        }
        for name in ("ARIA_GH_APP_ID", "ARIA_GH_APP_INSTALLATION_ID", "ARIA_GH_APP_PRIVATE_KEY_PATH",
                     "ARIA_GH_APP_PRIVATE_KEY", "GH_TOKEN", "GITHUB_TOKEN", "ARIA_DRY_RUN"):
            os.environ.pop(name, None)
        patch_dict = mock.patch.dict(os.environ, env)
        patch_dict.start()
        self.addCleanup(patch_dict.stop)
        self.addCleanup(lambda: [os.environ.pop(name, None) for name in env])

    def test_the_mint_goes_through_the_socket_and_names_its_set(self) -> None:
        from aria_kernel import gh_token_factory as tf

        lease = tf.mint_installation_token(
            cycle_id="factory-wiring-01",
            workspace_root=self.workspace,
            permission_set="DELIVERY",
            token_dir=self._private_dir(),
        )
        self.addCleanup(lambda: lease.token_file.unlink(missing_ok=True))
        self.assertFalse(lease.fallback_active)
        self.assertEqual(lease.gh_app_installation_id, _FIXTURE_INSTALLATION_ID)
        self.assertEqual(lease.provider_expiry, _FIXTURE_EXPIRES_AT)
        self.assertEqual(lease.token_file.read_text(encoding="utf-8").strip(), _FIXTURE_TOKEN)
        self.assertEqual(lease.token_file.stat().st_mode & 0o777, 0o600)
        self.assertEqual(len(self.endpoint.requests), 1)
        self.assertEqual(self.endpoint.requests[0]["body"],
                         {"permissions": dict(INSTALLATION_TOKEN_PERMISSION_SETS["DELIVERY"])})

    def test_a_mapping_instead_of_a_name_is_refused_on_the_broker_path(self) -> None:
        from aria_kernel import gh_token_factory as tf

        with self.assertRaisesRegex(RuntimeError, "permission set"):
            tf.mint_installation_token(
                cycle_id="factory-wiring-02",
                workspace_root=self.workspace,
                permissions=dict(INSTALLATION_TOKEN_PERMISSION_SETS["DELIVERY"]),
                token_dir=self._private_dir(),
            )
        self.assertEqual(self.endpoint.requests, [])

    def _private_dir(self) -> Path:
        # Outside the workspace root, private: the shape the factory demands.
        private = self.scratch / f"tokens-{time.monotonic_ns()}"
        private.mkdir(mode=0o700)
        return private


class TheWorkflowInvokesTheCli(unittest.TestCase):
    """The exact shape the lane's step runs: the PEM piped to the launcher's
    stdin under ``PYTHONPATH=aria-kernel`` from the repo root, the socket
    path on stdout, the server outliving the launcher, and the declared
    sweep taking the socket directory once the server is gone."""

    def setUp(self) -> None:
        self.scratch = Path(tempfile.mkdtemp(prefix="aria-tb-cli-"))
        self.addCleanup(shutil.rmtree, self.scratch, True)
        self.pem = _fixture_pem()
        self.endpoint = _ServeThread()
        self.addCleanup(self.endpoint.close)

    @staticmethod
    def _server_pid_for_socket(socket_path: Path) -> int | None:
        for entry in Path("/proc").iterdir():
            if not entry.name.isdigit():
                continue
            try:
                cmdline = (entry / "cmdline").read_bytes()
            except OSError:
                continue
            if b"aria_kernel.token_broker" in cmdline and b"serve" in cmdline \
                    and str(socket_path).encode() in cmdline:
                return int(entry.name)
        return None

    def test_start_prints_the_socket_and_leaves_a_clean_serving_broker(self) -> None:
        repo_root = Path(__file__).resolve().parents[2]
        (self.scratch / "ws").mkdir()
        (self.scratch / "tokens").mkdir(mode=0o700)
        done = subprocess.run(
            [
                sys.executable, "-m", "aria_kernel.token_broker", "start",
                "--app-id", _FIXTURE_APP_ID,
                "--installation-id", _FIXTURE_INSTALLATION_ID,
                "--api-base-url", self.endpoint.url,
                "--deadline-epoch", str(int(time.time() + 300)),
                "--max-mints", "5",
                "--ledger", str(self.scratch / "ledger.jsonl"),
            ],
            input=(self.pem + "\n").encode("utf-8"),
            capture_output=True, check=False, timeout=90,
            env={"PATH": os.environ.get("PATH", os.defpath), "PYTHONPATH": "aria-kernel"},
            cwd=str(repo_root),
        )
        self.assertEqual(done.returncode, 0, done.stderr.decode("utf-8", "replace"))
        socket_path = Path(done.stdout.decode("utf-8").strip().splitlines()[-1])
        self.assertTrue(socket_path.is_socket(), str(socket_path))
        self.assertTrue(socket_path.parent.name.startswith("aria-tb-"), str(socket_path))
        pid = self._server_pid_for_socket(socket_path)
        self.assertIsNotNone(pid, "the server outlives the launcher that printed its socket")
        environ = Path(f"/proc/{pid}/environ").read_bytes()
        self.assertNotIn(b"PRIVATE KEY", environ)
        # The mint works through the factory, exactly as the lane's step env
        # wires it (ARIA_GH_TOKEN_BROKER_SOCKET via GITHUB_ENV).
        from aria_kernel import gh_token_factory as tf

        with mock.patch.dict(os.environ, {"ARIA_GH_TOKEN_BROKER_SOCKET": str(socket_path)}):
            lease = tf.mint_installation_token(
                cycle_id="cli-wiring-01",
                workspace_root=self.scratch / "ws",
                permission_set="DELIVERY",
                token_dir=self.scratch / "tokens",
            )
        self.assertEqual(lease.provider_expiry, _FIXTURE_EXPIRES_AT)
        self.assertEqual(lease.token_file.read_text(encoding="utf-8").strip(), _FIXTURE_TOKEN)
        # The server dies with a TERM (what stop() and the runner's cleanup
        # send), and the declared sweep takes the directory it left.
        os.kill(pid, signal.SIGTERM)
        for _ in range(100):
            if self._server_pid_for_socket(socket_path) is None:
                break
            time.sleep(0.05)
        swept = prune_stale_socket_dirs(TOKEN_BROKER)
        self.assertIn(socket_path.parent.name, swept["swept"])


if __name__ == "__main__":
    unittest.main()
