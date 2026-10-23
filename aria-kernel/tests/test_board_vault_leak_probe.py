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
* its GitHub App installation tokens — the one mint scopes every token to
  this repository by name, so a token the kernel mints cannot reach
  aria-board-vault whatever the App installation's repository selection is
  (SETUP's UI check 1 becomes a property of the code);
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

if __name__ == "__main__":
    unittest.main()
