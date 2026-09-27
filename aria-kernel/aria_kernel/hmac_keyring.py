"""Rolling HMAC key custody — the ONE primitive behind every kernel-held signing key.

WHY: ``ack_ledger`` (Plan ARIA-V3 §A5) carried the kernel's only rolling-key
custody code: a 0600 secret file written atomically, a ``key_id``-addressed
rolling list capped at five entries so historical rows stay verifiable
after rotation, and HMAC-SHA256 over canonical row bytes. Operator-feedback
signing (V9.5 hard-fail check 12, ``operator_feedback_signature``) needs
exactly that custody with its OWN key material. ``promotion_veto`` already
learned (i1) that two copies of a security primitive are two things to fix,
so the custody moved here and each owner binds only its key FILE to it.

WHAT: :class:`HmacKeyring` is bound to one key-file path and one ``purpose``
(the error vocabulary prefix). Owners decide the key LIFECYCLE — the ack
ledger keeps its operator ceremony (``aria-kernel ack init``), the
operator-feedback signer mints on first use because the kernel is both the
signer and the verifier there. Both call :meth:`HmacKeyring.resolve` with a
``key_id`` at verification time, which is what makes rotation safe: an old
key is retired, never deleted, until it rolls off the five-entry window.
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import secrets
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .tool_registry import GovernanceError

KEY_FILE_SCHEMA_VERSION: int = 1
MAX_ROLLING_KEYS: int = 5
SECRET_BYTES: int = 32


def utc_now_stamp() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def hmac_sign(secret_b64: str, payload: bytes) -> str:
    """HMAC-SHA256 hex digest of ``payload`` under a base64-encoded secret."""
    secret = base64.b64decode(secret_b64.encode("ascii"))
    return hmac.new(secret, payload, hashlib.sha256).hexdigest()


def atomic_write_secret(path: Path, content: str) -> None:
    """Write a secret file with 0600 perms via temp-file + rename.

    ``os.fchmod`` runs BEFORE the rename so the final file never exists with
    looser perms, even briefly; the parent directory is created on demand
    because the secrets directory is gitignored and absent on a fresh store.
    """
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f".{path.name}.tmp.{os.getpid()}")
    with tmp.open("w", encoding="utf-8") as handle:
        os.fchmod(handle.fileno(), 0o600)
        handle.write(content)
        handle.flush()
        os.fsync(handle.fileno())
    tmp.replace(path)
    os.chmod(path, 0o600)


def mint_key_entry() -> dict[str, Any]:
    """A fresh rolling-list entry: random id, 32 random bytes, not retired."""
    return {
        "key_id": str(uuid.uuid4()),
        "secret": base64.b64encode(secrets.token_bytes(SECRET_BYTES)).decode("ascii"),
        "minted_at": utc_now_stamp(),
        "retired_at": None,
    }


@dataclass(frozen=True)
class HmacKeyring:
    """One key file, one purpose. Index 0 of the rolling list is the head key."""

    path: Path
    purpose: str

    def load(self) -> list[dict[str, Any]]:
        if not self.path.exists():
            return []
        data = json.loads(self.path.read_text(encoding="utf-8"))
        keys = data.get("keys") if isinstance(data, dict) else None
        if not isinstance(keys, list):
            return []
        return [entry for entry in keys if isinstance(entry, dict)]

    def persist(self, keys: list[dict[str, Any]]) -> None:
        payload = json.dumps(
            {"schema_version": KEY_FILE_SCHEMA_VERSION, "keys": keys},
            sort_keys=True,
            indent=2,
        )
        atomic_write_secret(self.path, payload)

    def resolve(self, *, key_id: str | None = None) -> dict[str, Any]:
        """The head key, or the entry for ``key_id``; a miss is a named refusal."""
        keys = self.load()
        if not keys:
            raise GovernanceError(f"hmac_key_missing:{self.purpose}")
        if key_id is None:
            return keys[0]
        for entry in keys:
            if entry.get("key_id") == key_id:
                return entry
        raise GovernanceError(
            f"hmac_key_unknown:{self.purpose}: key_id={key_id!r} not in rolling list"
        )

    def ensure_head(self) -> dict[str, Any]:
        """Head key, minted on first use — for keys the kernel owns end to end."""
        keys = self.load()
        if keys:
            return keys[0]
        new_key = mint_key_entry()
        self.persist([new_key])
        return new_key

    def rotate(self) -> dict[str, Any]:
        """Append a new head; retire the old head; drop entries past the window.

        Returns ``{"new_key", "previous_head", "retired_keys", "keys"}`` so
        the owner can write its own governance row without re-reading the
        secret file.
        """
        keys = self.load()
        if not keys:
            raise GovernanceError(f"hmac_rotate_no_existing_key:{self.purpose}")
        new_key = mint_key_entry()
        previous_head = dict(keys[0])
        previous_head["retired_at"] = utc_now_stamp()
        rotated = [new_key, previous_head] + keys[1:]
        retired_keys: list[str] = []
        if len(rotated) > MAX_ROLLING_KEYS:
            retired_keys = [str(entry["key_id"]) for entry in rotated[MAX_ROLLING_KEYS:]]
            rotated = rotated[:MAX_ROLLING_KEYS]
        self.persist(rotated)
        return {
            "new_key": new_key,
            "previous_head": previous_head,
            "retired_keys": retired_keys,
            "keys": rotated,
        }

    def redacted(self) -> list[dict[str, Any]]:
        """The rolling list with secrets stripped, safe to print."""
        return [
            {
                "key_id": entry.get("key_id"),
                "minted_at": entry.get("minted_at"),
                "retired_at": entry.get("retired_at"),
            }
            for entry in self.load()
        ]


__all__ = [
    "KEY_FILE_SCHEMA_VERSION",
    "MAX_ROLLING_KEYS",
    "HmacKeyring",
    "atomic_write_secret",
    "hmac_sign",
    "mint_key_entry",
    "utc_now_stamp",
]
