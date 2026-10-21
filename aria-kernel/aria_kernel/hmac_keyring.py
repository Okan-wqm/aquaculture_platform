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

REVOCATION (ARIA-LOW-598) is the one exception to that grace: a key believed
compromised is taken OUT of the rolling list at once — its secret is dropped
from the file — and a revocation record (``key_id``, ``revoked_at``,
``reason``; never the secret) is kept beside the list for good. A revoked
``key_id`` never resolves again, so a row it signed reads as revoked
(unverifiable, its content intact), never as valid and never as unknown; and
nothing that rewrites the list (rotation, init, a DR regeneration) can drop
the record.
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

    def _document(self) -> dict[str, Any]:
        if not self.path.exists():
            return {}
        data = json.loads(self.path.read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else {}

    def load(self) -> list[dict[str, Any]]:
        keys = self._document().get("keys")
        if not isinstance(keys, list):
            return []
        return [entry for entry in keys if isinstance(entry, dict)]

    def revoked(self) -> list[dict[str, Any]]:
        """The revocation records, oldest first — ids and reasons, never a secret."""
        records = self._document().get("revoked")
        if not isinstance(records, list):
            return []
        return [entry for entry in records if isinstance(entry, dict)]

    def persist(self, keys: list[dict[str, Any]]) -> None:
        """Write the rolling list; the revocation records carry over unchanged.

        Only :meth:`revoke` adds to them and nothing removes one, so no
        rotation, init or DR regeneration can make a revoked key resolve again.
        """
        self._write(keys, self.revoked())

    def _write(self, keys: list[dict[str, Any]], revoked: list[dict[str, Any]]) -> None:
        document: dict[str, Any] = {"schema_version": KEY_FILE_SCHEMA_VERSION, "keys": keys}
        if revoked:
            document["revoked"] = revoked
        atomic_write_secret(self.path, json.dumps(document, sort_keys=True, indent=2))

    def resolve(self, *, key_id: str | None = None) -> dict[str, Any]:
        """The head key, or the entry for ``key_id``; a miss is a named refusal."""
        keys = self.load()
        if not keys:
            raise GovernanceError(f"hmac_key_missing:{self.purpose}")
        if key_id is None:
            return keys[0]
        for record in self.revoked():
            if record.get("key_id") == key_id:
                raise GovernanceError(
                    f"hmac_key_revoked:{self.purpose}: key_id={key_id!r} "
                    f"revoked at {record.get('revoked_at')}"
                )
        for entry in keys:
            if entry.get("key_id") == key_id:
                return entry
        raise GovernanceError(
            f"hmac_key_unknown:{self.purpose}: key_id={key_id!r} not in rolling list"
        )

    def revoke(self, key_id: str, *, reason: str) -> dict[str, Any]:
        """Take ``key_id`` out of the rolling list now and record why.

        Refuses the head (the next row would be signed by a retired key, or by
        none): rotate first, then revoke the key that was the head. Refuses an
        id the list does not hold, and one already revoked. Returns
        ``{"revoked", "keys"}`` so the owner can write its governance row.
        """
        keys = self.load()
        revoked = self.revoked()
        if any(record.get("key_id") == key_id for record in revoked):
            raise GovernanceError(f"hmac_key_already_revoked:{self.purpose}: key_id={key_id!r}")
        index = next((i for i, entry in enumerate(keys) if entry.get("key_id") == key_id), None)
        if index is None:
            raise GovernanceError(
                f"hmac_key_unknown:{self.purpose}: key_id={key_id!r} not in rolling list"
            )
        if index == 0:
            raise GovernanceError(
                f"hmac_revoke_head_key:{self.purpose}: key_id={key_id!r} is the signing head; "
                "rotate first, then revoke it"
            )
        record = {
            "key_id": key_id,
            "minted_at": keys[index].get("minted_at"),
            "revoked_at": utc_now_stamp(),
            "reason": reason,
        }
        remaining = keys[:index] + keys[index + 1:]
        self._write(remaining, revoked + [record])
        return {"revoked": record, "keys": remaining}

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
