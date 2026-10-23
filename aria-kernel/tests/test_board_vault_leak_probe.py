"""PLAN-v2 B0 — leak probe: with everything ARIA's runner holds, the Board's vault cannot be read.

§1.9: ARIA's runner uid, token, store and self-change can neither read nor
write the Board's code, key, vault or verdict. ARIA-MEDIUM-766: no
examination identity or held-out store existed outside the runner's reach.
board/SETUP.md (2026-10-21) put the vault in the private repository
Okan-wqm/aria-board-vault, its deploy key and a 32-byte AES-256-GCM data key in
the ``aria-board`` environment only, and left the cipher wrapper to B0.

What the runner holds, and what each probe pins:

* the vault's bytes (assume it got them) — every blob is AES-256-GCM
  ciphertext under the data key, bound to its vault path, and opens only with
  the key, which the wrapper reads from ``ARIA_BOARD_VAULT_DATA_KEY`` in the
  process environment and nowhere else (no key parameter, no file): in the
  runner's environment the wrapper refuses by name, to read and to write;
* the GitHub App installation tokens the kernel mints — the one mint scopes
  every token to this repository by name, so a token IT issues cannot reach
  aria-board-vault whatever the App installation's repository selection is.
  That is defence in depth only: the runner uid also holds the App's private
  key, which mints unscoped tokens, so the barrier remains the installation's
  repository selection (SETUP's UI check 1, an operator verification); the
  runner-identity probe (``RunnerIdentityLeakProbeTests`` below, and the
  operator's run of ``tools/aria-board/runner_vault_leak_probe.py`` as the
  runner uid) measures it with every credential that uid holds;
* the kernel's source — only ``examination_board`` names a Board secret, and
  it signs nothing itself (§2 'İmza': verdicts go through
  ``operator_request_signature``).

New API pinned here: ``aria_kernel.examination_board`` (the one new module of
PLAN-v2 §1.1) with ``VAULT_DATA_KEY_ENV``, ``seal_vault_blob`` and
``open_vault_blob``; the module's absence is the red at the base. The token
scope is red at the base by assertion (the mint body carries ``permissions``
alone).

Vault blob format (data at rest must stay readable across Board versions):
``b"aria-board-vault/v1\\n" + nonce(12) + AESGCM(key).encrypt(nonce, plaintext,
b"aria-board-vault/v1\\n" + context.encode("utf-8"))``.
"""
from __future__ import annotations

import base64
import importlib
import importlib.util
import inspect
import json
import os
import shutil
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from cryptography.hazmat.primitives.ciphers.aead import AESGCM

from aria_kernel import gh_token_factory as tf
from aria_kernel.operator_approval import OPERATORS_POLICY_RELPATH

_REPO_ROOT = Path(__file__).resolve().parents[2]
_KERNEL = _REPO_ROOT / "aria-kernel" / "aria_kernel"
_MODULE = "aria_kernel.examination_board"
_KEY_ENV = "ARIA_BOARD_VAULT_DATA_KEY"
_HEADER = b"aria-board-vault/v1\n"
_CANARY = b"held-out case 0042: the defect is in apps/hr-service/src/leave/leave.service.ts:88"
_CONTEXT = "cases/szz/0042.json"


def _board(case: unittest.TestCase):
    case.assertIsNotNone(importlib.util.find_spec(_MODULE), "aria_kernel.examination_board does not exist")
    return importlib.import_module(_MODULE)


def _env_with_key(key: bytes | None) -> dict[str, str]:
    env = {k: v for k, v in os.environ.items() if not k.startswith("ARIA_BOARD_")}
    if key is not None:
        env[_KEY_ENV] = base64.b64encode(key).decode("ascii")
    return env


class VaultCipherTests(unittest.TestCase):
    def setUp(self) -> None:
        self.board = _board(self)
        self.key = AESGCM.generate_key(bit_length=256)

    def _seal(self, plaintext: bytes = _CANARY, context: str = _CONTEXT, key: bytes | None = None) -> bytes:
        with patch.dict(os.environ, _env_with_key(key or self.key), clear=True):
            return self.board.seal_vault_blob(plaintext, context=context)

    def _open(self, sealed: bytes, context: str = _CONTEXT, key: bytes | None = None) -> bytes:
        with patch.dict(os.environ, _env_with_key(key or self.key), clear=True):
            return self.board.open_vault_blob(sealed, context=context)

    def test_the_key_comes_from_the_board_environment_variable_only(self) -> None:
        self.assertEqual(self.board.VAULT_DATA_KEY_ENV, _KEY_ENV)
        for function in (self.board.seal_vault_blob, self.board.open_vault_blob):
            with self.subTest(function=function.__name__):
                names = list(inspect.signature(function).parameters)
                self.assertFalse([n for n in names if "key" in n.lower()],
                                 "no caller can hand the wrapper a key from anywhere else")

    def test_a_sealed_blob_opens_with_the_key_and_its_context(self) -> None:
        self.assertEqual(self._open(self._seal()), _CANARY)

    def test_the_blob_is_aes_256_gcm_in_the_documented_layout(self) -> None:
        sealed = self._seal()
        self.assertTrue(sealed.startswith(_HEADER))
        nonce, body = sealed[len(_HEADER):len(_HEADER) + 12], sealed[len(_HEADER) + 12:]
        opened = AESGCM(self.key).decrypt(nonce, body, _HEADER + _CONTEXT.encode("utf-8"))
        self.assertEqual(opened, _CANARY)
        self.assertEqual(len(sealed), len(_HEADER) + 12 + len(_CANARY) + 16)

    def test_each_seal_draws_a_fresh_nonce(self) -> None:
        self.assertNotEqual(self._seal(), self._seal())

    def test_the_case_content_never_appears_in_the_sealed_bytes(self) -> None:
        sealed = self._seal()
        for fragment in (_CANARY, b"leave.service.ts", b"held-out case", base64.b64encode(_CANARY)):
            self.assertNotIn(fragment, sealed)

    def test_the_runner_environment_cannot_open_or_write_the_vault(self) -> None:
        sealed = self._seal()
        with patch.dict(os.environ, _env_with_key(None), clear=True):
            with self.assertRaises(self.board.BoardRefusal) as opened:
                self.board.open_vault_blob(sealed, context=_CONTEXT)
            with self.assertRaises(self.board.BoardRefusal) as written:
                self.board.seal_vault_blob(b"planted case", context=_CONTEXT)
        self.assertIn("board_vault_key_unavailable", str(opened.exception))
        self.assertIn("board_vault_key_unavailable", str(written.exception))
        self.assertNotIn(_CANARY.decode(), str(opened.exception))

    def test_a_wrong_key_another_path_or_a_flipped_bit_is_unauthentic(self) -> None:
        sealed = self._seal()
        flipped = sealed[:-1] + bytes([sealed[-1] ^ 1])
        cases = {
            "wrong_key": lambda: self._open(sealed, key=AESGCM.generate_key(bit_length=256)),
            "moved_to_another_path": lambda: self._open(sealed, context="cases/szz/0043.json"),
            "flipped_tag_bit": lambda: self._open(flipped),
            "truncated": lambda: self._open(sealed[:len(_HEADER) + 8]),
            "foreign_header": lambda: self._open(b"aria-board-vault/v0\n" + sealed[len(_HEADER):]),
        }
        for name, attempt in cases.items():
            with self.subTest(case=name):
                with self.assertRaises(self.board.BoardRefusal) as raised:
                    attempt()
                self.assertIn("board_vault_blob_unauthentic", str(raised.exception))

    def test_only_a_256_bit_base64_key_is_a_key(self) -> None:
        for name, value in {"aes_128": base64.b64encode(os.urandom(16)).decode(), "not_base64": "%%%%",
                            "empty": "", "aes_512": base64.b64encode(os.urandom(64)).decode()}.items():
            env = _env_with_key(None)
            env[_KEY_ENV] = value
            with self.subTest(key=name), patch.dict(os.environ, env, clear=True):
                with self.assertRaises(self.board.BoardRefusal) as raised:
                    self.board.seal_vault_blob(_CANARY, context=_CONTEXT)
                self.assertRegex(str(raised.exception), r"board_vault_key_(invalid|unavailable)")


class BoardSecretsHaveOneOwnerTests(unittest.TestCase):
    def test_only_examination_board_names_a_board_secret_and_it_signs_nothing_itself(self) -> None:
        _board(self)
        named = sorted(path.relative_to(_KERNEL).as_posix() for path in _KERNEL.rglob("*.py")
                       if "ARIA_BOARD_" in path.read_text(encoding="utf-8"))
        self.assertEqual(named, ["examination_board.py"])
        source = (_KERNEL / "examination_board.py").read_text(encoding="utf-8")
        for mechanism in ("ssh-keygen", "ed25519", "Ed25519", "import hmac", "hmac.new"):
            with self.subTest(mechanism=mechanism):
                self.assertNotIn(mechanism, source, "Board verdicts are signed through operator_request_signature")


class _Response:
    def __init__(self, payload: dict) -> None:
        self._body = json.dumps(payload).encode("utf-8")

    def read(self) -> bytes:
        return self._body

    def __enter__(self) -> "_Response":
        return self

    def __exit__(self, *_: object) -> bool:
        return False


class _FakeJwt:
    @staticmethod
    def encode(payload: dict, key: str, algorithm: str) -> str:
        return "header.payload.signature"


class KernelTokensCannotReachTheVaultTests(unittest.TestCase):
    """The runner's GitHub credential: every App token the kernel mints names this repository alone."""

    def setUp(self) -> None:
        scratch = tempfile.TemporaryDirectory(prefix="aria-board-token-scope-")
        self.addCleanup(scratch.cleanup)
        self.root = Path(scratch.name)
        policy = self.root / OPERATORS_POLICY_RELPATH
        policy.parent.mkdir(parents=True)
        shutil.copyfile(_REPO_ROOT / OPERATORS_POLICY_RELPATH, policy)
        self.repository = json.loads(policy.read_text(encoding="utf-8"))["repository"]
        pem = self.root / "app.pem"
        pem.write_text("-----BEGIN RSA PRIVATE KEY-----\nfixture\n-----END RSA PRIVATE KEY-----\n", encoding="utf-8")
        env = {k: v for k, v in os.environ.items() if k not in ("ARIA_DRY_RUN", "ARIA_GH_TOKEN_BROKER_SOCKET")}
        env.update({"ARIA_GH_APP_INSTALLATION_ID": "12345", "ARIA_GH_APP_ID": "678",
                    "ARIA_GH_APP_PRIVATE_KEY_PATH": str(pem), "ARIA_REQUIRE_MODE_A": "true"})
        for patcher in (patch.dict(os.environ, env, clear=True), patch.dict("sys.modules", {"jwt": _FakeJwt()})):
            patcher.start()
            self.addCleanup(patcher.stop)
        self.posted: list[dict] = []

        def urlopen(request, timeout):  # noqa: ANN001 — urlopen's shape
            self.posted.append(json.loads(request.data.decode("utf-8")))
            return _Response({"token": "ghs_fixture", "expires_at": "2026-10-23T00:05:00Z"})

        opener = patch("urllib.request.urlopen", urlopen)  # allowlist-external-network: the opener is replaced by the in-process fake above; no request leaves the test
        opener.start()
        self.addCleanup(opener.stop)

    def _assert_minted_for_this_repository_only(self, permissions) -> None:  # noqa: ANN001 — a named set
        name = self.repository.split("/")[1]
        lease = tf.mint_installation_token(cycle_id="board-leak-probe", workspace_root=self.root,
                                           permissions=permissions)
        self.addCleanup(lambda: lease.token_file.unlink(missing_ok=True))
        self.assertEqual(len(self.posted), 1)
        self.assertEqual(self.posted[0].get("repositories"), [name],
                         "an unscoped installation token reaches every repository the App is installed on")
        self.assertNotIn("aria-board-vault", json.dumps(self.posted[0]))

    def test_the_default_set_is_minted_for_this_repository_only(self) -> None:
        self._assert_minted_for_this_repository_only(tf.DEFAULT_INSTALLATION_TOKEN_PERMISSIONS)

    def test_the_merge_lane_set_is_minted_for_this_repository_only(self) -> None:
        self._assert_minted_for_this_repository_only(tf.MERGE_LANE_INSTALLATION_TOKEN_PERMISSIONS)

    def test_the_runner_status_set_is_minted_for_this_repository_only(self) -> None:
        self._assert_minted_for_this_repository_only(tf.RUNNER_STATUS_PERMISSIONS)


_PROBE_PATH = _REPO_ROOT / "tools" / "aria-board" / "runner_vault_leak_probe.py"


def _probe_module():
    name = "aria_board_runner_vault_leak_probe"
    if name not in sys.modules:
        spec = importlib.util.spec_from_file_location(name, _PROBE_PATH)
        module = importlib.util.module_from_spec(spec)
        sys.modules[name] = module  # a dataclass resolves its module by name
        spec.loader.exec_module(module)
    return sys.modules[name]


class _Answers:
    """A fixture credential source: GitHub answers ``status`` for the vault."""

    def __init__(self, probe, name: str, status: str, http: int | None) -> None:  # noqa: ANN001 — the module
        self.name, self._reach = name, probe.Reach(name, status, http, "fixture")

    def reach(self, repository: str):  # noqa: ANN201 — probe.Reach
        return self._reach


class RunnerIdentityLeakProbeTests(unittest.TestCase):
    """B0 corrective R6: the runner-identity probe goes red when a credential reaches the vault, green when none does.

    The fixture sources stand in for the runner uid's credentials; the real
    run, as the runner uid with its App key, gh login and git credentials, is
    the operator's B0 exit step (PR body).
    """

    def setUp(self) -> None:
        self.probe = _probe_module()
        self.app = self.probe.AppPrivateKeySource.name

    def test_the_vault_name_has_one_owner(self) -> None:
        self.assertEqual(self.probe.VAULT_REPOSITORY, _board(self).VAULT_REPOSITORY)
        self.assertEqual(self.probe.VAULT_REPOSITORY, "Okan-wqm/aria-board-vault")

    def test_red_when_a_credential_source_answers_200(self) -> None:
        status, report = self.probe.run_probe(
            [_Answers(self.probe, self.app, self.probe.REACHABLE, 200),
             _Answers(self.probe, "gh_cli", self.probe.UNREACHABLE, 404)], data_key=[])
        self.assertEqual((status, report["verdict"]), (1, "red"))

    def test_green_when_every_source_including_the_app_key_is_refused(self) -> None:
        status, report = self.probe.run_probe(
            [_Answers(self.probe, self.app, self.probe.UNREACHABLE, 404),
             _Answers(self.probe, "gh_cli", self.probe.UNREACHABLE, 404),
             _Answers(self.probe, "git_https", self.probe.NO_CREDENTIAL, None),
             _Answers(self.probe, "git_ssh", self.probe.UNREACHABLE, 404)], data_key=[])
        self.assertEqual((status, report["verdict"]), (0, "green"))

    def test_no_green_without_the_app_key_or_with_an_unclassified_answer(self) -> None:
        refused = _Answers(self.probe, "gh_cli", self.probe.UNREACHABLE, 404)
        status, report = self.probe.run_probe([refused], data_key=[])
        self.assertEqual((status, report["required_sources_missing"]), (2, [self.app]))
        status, _ = self.probe.run_probe(
            [_Answers(self.probe, self.app, self.probe.INCONCLUSIVE, 500), refused], data_key=[])
        self.assertEqual(status, 2)

    def test_a_present_data_key_is_red_by_name_and_never_by_value(self) -> None:
        secret = base64.b64encode(os.urandom(32)).decode("ascii")
        with tempfile.TemporaryDirectory(prefix="aria-leak-probe-home-") as home:
            env_file = Path(home) / ".env"
            env_file.write_text(f"PATH=/usr/bin\nARIA_BOARD_VAULT_DATA_KEY={secret}\n", encoding="utf-8")
            (Path(home) / "aria-board-vault.key").write_text(secret, encoding="utf-8")
            findings = self.probe.data_key_findings(environ={_KEY_ENV: secret, "HOME": home},
                                                    env_files=[env_file], scan_roots=[Path(home)])
            status, report = self.probe.run_probe(
                [_Answers(self.probe, self.app, self.probe.UNREACHABLE, 404)], data_key=findings)
        self.assertEqual(status, 1)
        self.assertEqual(len(findings), 3, findings)
        self.assertNotIn(secret, json.dumps(report))

    def test_the_app_key_source_mints_unscoped_asks_for_the_vault_and_revokes(self) -> None:
        from cryptography.hazmat.primitives import hashes, serialization
        from cryptography.hazmat.primitives.asymmetric import padding, rsa
        import urllib.error

        key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
        for answer, expected in ((404, self.probe.UNREACHABLE), (200, self.probe.REACHABLE)):
            with self.subTest(answer=answer), tempfile.TemporaryDirectory(prefix="aria-leak-probe-pem-") as tmp:
                pem = Path(tmp) / "app.pem"
                pem.write_bytes(key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8,
                                                  serialization.NoEncryption()))
                seen: list[tuple[str, str, bytes | None, str]] = []

                def opener(request):  # noqa: ANN001, ANN202 — urllib's Request
                    seen.append((request.get_method(), request.full_url, request.data,
                                 request.get_header("Authorization")))
                    if request.full_url.endswith("/access_tokens"):
                        return _Response({"token": "ghs_fixture_unscoped", "expires_at": "2026-10-23T01:00:00Z"})
                    if request.get_method() == "GET" and answer != 200:
                        raise urllib.error.HTTPError(request.full_url, answer, "Not Found", None, None)
                    response = _Response({})
                    response.status = 200
                    return response

                source = self.probe.AppPrivateKeySource(app_id="678", installation_id="12345",
                                                        private_key_path=pem, opener=opener)
                reach = source.reach(self.probe.VAULT_REPOSITORY)
                self.assertEqual(reach.status, expected)
                methods = [(method, url.split("api.github.com")[1]) for method, url, _, _ in seen]
                self.assertEqual(methods, [("POST", "/app/installations/12345/access_tokens"),
                                           ("GET", "/repos/Okan-wqm/aria-board-vault"),
                                           ("DELETE", "/installation/token")])
                self.assertEqual(seen[0][2], b"{}", "the mint asks for every repository the installation selects")
                jwt = seen[0][3].split(" ", 1)[1]
                signing_input, signature = jwt.rsplit(".", 1)
                key.public_key().verify(base64.urlsafe_b64decode(signature + "=" * (-len(signature) % 4)),
                                        signing_input.encode("ascii"), padding.PKCS1v15(), hashes.SHA256())
                self.assertNotIn("ghs_fixture_unscoped", json.dumps(reach.report()))

    def test_gh_and_git_answers_are_classified(self) -> None:
        cases = {
            ("gh", 1, "gh: Not Found (HTTP 404)"): self.probe.UNREACHABLE,
            ("gh", 0, ""): self.probe.REACHABLE,
            ("gh", 4, "To get started with GitHub CLI, please run:  gh auth login"): self.probe.NO_CREDENTIAL,
            ("git", 128, "remote: Repository not found.\nfatal: repository not found"): self.probe.UNREACHABLE,
            ("git", 0, ""): self.probe.REACHABLE,
            ("git", 128, "fatal: could not read Username: terminal prompts disabled"): self.probe.NO_CREDENTIAL,
            ("git", 128, "fatal: unable to access: Could not resolve host"): self.probe.INCONCLUSIVE,
        }
        for (tool, code, stderr), expected in cases.items():
            with self.subTest(tool=tool, code=code), tempfile.TemporaryDirectory(prefix="aria-leak-cli-") as tmp:
                binary = Path(tmp) / tool
                binary.write_text(f"#!{sys.executable}\nimport sys\nsys.stderr.write({stderr!r})\n"
                                  f"raise SystemExit({code})\n", encoding="utf-8")
                binary.chmod(0o755)
                source = (self.probe.GhCliSource(gh_cli=str(binary), env={"PATH": os.environ["PATH"]})
                          if tool == "gh" else
                          self.probe.GitRemoteSource(transport="https", git_cli=str(binary),
                                                     env={"PATH": os.environ["PATH"]}))
                self.assertEqual(source.reach(self.probe.VAULT_REPOSITORY).status, expected)

if __name__ == "__main__":
    unittest.main()
