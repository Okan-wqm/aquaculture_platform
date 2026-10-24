"""PLAN-v2 §1.1 / §2 'Kurul kararı + kasa' — the Examination Board: the one new module of the program.

WHY (ARIA-MEDIUM-766, PLAN-v2 §1.9). The Board judges ARIA from outside
ARIA's trust domain: ARIA's runner uid, token, store and self-change can
neither read nor write the Board's code, key, vault or verdict. Its held-out
cases live in a private repository (``Okan-wqm/aria-board-vault``) whose deploy
key exists only in the GitHub environment ``aria-board`` (main only, a
GitHub-hosted runner). Access control on that repository is one barrier; this
module is the second: every vault blob is AES-256-GCM ciphertext under the
data key the same environment holds, so the bytes alone, wherever they leak
to, open for nobody else.

WHAT (B0). The cipher wrapper and its custody rule:

* the data key comes from :data:`VAULT_DATA_KEY_ENV` in the process
  environment and from nowhere else — no function takes a key, and no file is
  read — so a process without the Board environment (ARIA's runner) can
  neither open nor write a blob, and is refused by name
  (``board_vault_key_unavailable``) rather than handed a default;
* a blob is ``VAULT_BLOB_HEADER + nonce(12) + AESGCM(key).encrypt(nonce,
  plaintext, VAULT_BLOB_HEADER + context)``: the header versions the layout
  (vault data must stay readable across Board versions), a fresh random nonce
  per seal, and the vault path as associated data, so a blob moved to another
  case's path does not open (``board_vault_blob_unauthentic``);
* nothing here signs: Board verdicts are signed through
  ``operator_request_signature`` in ``aria-board-verdict`` (§2 'İmza'), and
  B2 adds the verdict ledger to this module.

No error carries plaintext, key material or the context's case content.

ISOLATION (§1.9, B0 corrective R3). The process that holds the data key runs
THIS FILE and nothing else of ARIA: the Board job starts it by path in
isolated mode (``python3 -I aria-kernel/aria_kernel/examination_board.py
vault-custody-check``), so the ``aria_kernel`` package ``__init__`` — which
imports the whole ARIA-changeable kernel — never runs, and this module
imports the standard library and ``cryptography`` alone (installed from
``.github/board/cipher-requirements.txt`` by hash). Its refusals are therefore
its own type, :class:`BoardRefusal`, not the kernel's ``GovernanceError``.
Pinned by ``tests/invariants/test_board_job_guard.py``.
"""
from __future__ import annotations

import argparse
import base64
import binascii
import json
import os
import sys

from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives.ciphers.aead import AESGCM


class BoardRefusal(Exception):
    """A named refusal of the Examination Board: the message opens with its reason code.

    No refusal carries plaintext, key material or case content.
    """


# The aria-board environment's secret (board/SETUP.md, 2026-10-21): 32 random
# bytes, base64. Named here and in no other kernel module (pinned by
# tests/test_board_vault_leak_probe.py).
VAULT_DATA_KEY_ENV = "ARIA_BOARD_VAULT_DATA_KEY"
# The private repository that holds the sealed cases (board/SETUP.md). Only a
# Board job may check it out (the job guard), and no credential of ARIA's
# runner may reach it (the runner-identity leak probe,
# tools/aria-board/runner_vault_leak_probe.py).
VAULT_REPOSITORY = "Okan-wqm/aria-board-vault"
VAULT_BLOB_HEADER = b"aria-board-vault/v1\n"
_KEY_BYTES = 32
_NONCE_BYTES = 12
_TAG_BYTES = 16

VAULT_KEY_UNAVAILABLE = "board_vault_key_unavailable"
VAULT_KEY_INVALID = "board_vault_key_invalid"
VAULT_BLOB_UNAUTHENTIC = "board_vault_blob_unauthentic"
VAULT_CONTEXT_INVALID = "board_vault_context_invalid"

# The custody check's blob: a fixed probe, never a case, at a path no case uses.
_CUSTODY_PROBE = b"aria-board-vault custody probe"
_CUSTODY_CONTEXT = "custody/probe"


def _cipher() -> AESGCM:
    """The data key from the Board environment, or a named refusal (never a default)."""
    encoded = os.environ.get(VAULT_DATA_KEY_ENV, "")
    if not encoded:
        raise BoardRefusal(f"{VAULT_KEY_UNAVAILABLE}: {VAULT_DATA_KEY_ENV} is not in this process's environment")
    try:
        key = base64.b64decode(encoded, validate=True)
    except (binascii.Error, ValueError) as exc:
        raise BoardRefusal(f"{VAULT_KEY_INVALID}: {VAULT_DATA_KEY_ENV} is not base64") from exc
    if len(key) != _KEY_BYTES:
        raise BoardRefusal(f"{VAULT_KEY_INVALID}: {VAULT_DATA_KEY_ENV} is not a 256-bit key")
    return AESGCM(key)


def _associated_data(context: str) -> bytes:
    if not isinstance(context, str) or not context:
        raise BoardRefusal(f"{VAULT_CONTEXT_INVALID}: a blob is bound to its non-empty vault path")
    return VAULT_BLOB_HEADER + context.encode("utf-8")


def seal_vault_blob(plaintext: bytes, *, context: str) -> bytes:
    """``plaintext`` sealed for the vault path ``context`` under the Board environment's data key."""
    cipher = _cipher()
    associated = _associated_data(context)
    nonce = os.urandom(_NONCE_BYTES)
    return VAULT_BLOB_HEADER + nonce + cipher.encrypt(nonce, bytes(plaintext), associated)


def open_vault_blob(blob: bytes, *, context: str) -> bytes:
    """The plaintext of a blob sealed for ``context``; any other key, path, layout or bit is refused by name."""
    cipher = _cipher()
    associated = _associated_data(context)
    body = bytes(blob)
    if not body.startswith(VAULT_BLOB_HEADER) or len(body) < len(VAULT_BLOB_HEADER) + _NONCE_BYTES + _TAG_BYTES:
        raise BoardRefusal(f"{VAULT_BLOB_UNAUTHENTIC}: not a {VAULT_BLOB_HEADER.decode('ascii').strip()} blob")
    nonce_end = len(VAULT_BLOB_HEADER) + _NONCE_BYTES
    try:
        return cipher.decrypt(body[len(VAULT_BLOB_HEADER):nonce_end], body[nonce_end:], associated)
    except InvalidTag as exc:
        raise BoardRefusal(f"{VAULT_BLOB_UNAUTHENTIC}: the blob does not open for this key and path") from exc


def vault_custody_check() -> dict[str, str]:
    """The Board job's proof that its environment holds a working data key: a probe seals and opens.

    Raises the wrapper's named refusal when the key is absent or malformed;
    prints and stores no blob.
    """
    if open_vault_blob(seal_vault_blob(_CUSTODY_PROBE, context=_CUSTODY_CONTEXT), context=_CUSTODY_CONTEXT) \
            != _CUSTODY_PROBE:
        raise BoardRefusal(f"{VAULT_BLOB_UNAUTHENTIC}: the custody probe did not round-trip")
    return {"board_vault_key": "ok", "cipher": "AES-256-GCM", "layout": VAULT_BLOB_HEADER.decode("ascii").strip()}


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="python3 -I aria-kernel/aria_kernel/examination_board.py",
                                     description="PLAN-v2 B0 — the Examination Board's vault custody")
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("vault-custody-check", help="seal and open a fixed probe with the environment's data key")
    parser.parse_args(argv)
    try:
        report = vault_custody_check()
    except BoardRefusal as exc:
        sys.stderr.write(f"{exc}\n")
        return 1
    sys.stdout.write(json.dumps(report, sort_keys=True) + "\n")
    return 0


__all__ = [
    "BoardRefusal",
    "VAULT_BLOB_HEADER",
    "VAULT_BLOB_UNAUTHENTIC",
    "VAULT_CONTEXT_INVALID",
    "VAULT_DATA_KEY_ENV",
    "VAULT_KEY_INVALID",
    "VAULT_KEY_UNAVAILABLE",
    "VAULT_REPOSITORY",
    "open_vault_blob",
    "seal_vault_blob",
    "vault_custody_check",
]


if __name__ == "__main__":
    raise SystemExit(main())
