"""Plan 033 Faz 033e — Evidence Vault: raw security evidence never touches Git or aria/state.

WHY: raw HTTP requests/responses carry tokens and PII. The ledger row is metadata +
digest + redacted preview + ref (bounded); the bytes go to an encrypted object store
OUTSIDE the workspace and the tools dir: per-campaign DEK wrapped by a KEK the
operator hands over as bytes (from an FD), AES-256-GCM, directory 0700 / objects
0600, retention with deletion receipts, seal-once manifests. An oversized object is
stored truncated and SAID to be truncated (downstream verdict = INCONCLUSIVE).
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import secrets
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

from ..ledger import append_declared_jsonl, load_declared_jsonl
from ..tool_registry import ensure_tools_dir, utc_now
from .scope_policy import MAX_RESPONSE_BYTES

EVIDENCE_SURFACE = "security_evidence"
EVIDENCE_RELPATH: tuple[str, ...] = ("security", "evidence.jsonl")
EVIDENCE_KINDS = ("http_exchange", "graphql_exchange", "mqtt_exchange", "zap_report", "probe_log", "packet_capture", "manifest")
RETENTION_DAYS_DEFAULT = 7
RETENTION_DAYS_CONFIRMED_CRITICAL = 30
PREVIEW_CHARS = 200
# header/kv lines are cut to the END of the line; bare bearer/JWT-shaped values are cut too
_REDACT = re.compile(r"(?i)(authorization|cookie|set-cookie|x-api-key|token|secret|password)\s*[:=][^\r\n]*")
_REDACT_VALUES = re.compile(r"(?i)\bbearer\s+\S+|eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_.-]+")


class VaultError(RuntimeError):
    pass


class VaultBackendUnavailable(VaultError):
    pass


def _aesgcm() -> Any:
    try:
        from cryptography.hazmat.primitives.ciphers.aead import AESGCM
    except ImportError as exc:  # pragma: no cover
        raise VaultBackendUnavailable("cryptography AES-GCM is required for the evidence vault") from exc
    return AESGCM


def kek_from_fd(fd: int) -> bytes:
    """Read a 32-byte KEK from an inherited file descriptor — never env, argv or a log."""
    with os.fdopen(fd, "rb", closefd=True) as fh:
        key = fh.read(32)
    if len(key) != 32:
        raise VaultError("KEK must be exactly 32 bytes")
    return key


def redacted_preview(data: bytes) -> str:
    text = data[: PREVIEW_CHARS * 4].decode("utf-8", errors="replace")
    text = _REDACT.sub(lambda m: m.group(1) + ": [REDACTED]", text)
    return _REDACT_VALUES.sub("[REDACTED]", text)[:PREVIEW_CHARS]


@dataclass(frozen=True)
class EvidenceRef:
    ref: str
    campaign_run_id: str
    kind: str
    digest: str
    size: int
    truncated: bool


class EvidenceVault:
    def __init__(self, root_dir: str | Path, kek: bytes, *, workspace_root: str | Path | None = None,
                 base_dir: str | Path | None = None) -> None:
        self._AESGCM = _aesgcm()
        root = Path(root_dir).resolve()
        for forbidden in (workspace_root, base_dir):
            if forbidden is not None:
                f = Path(forbidden).resolve()
                if root == f or f in root.parents:
                    raise VaultError(f"vault {root} must be outside {f}")
        if len(kek) != 32:
            raise VaultError("KEK must be 32 bytes")
        self._root = root
        self._kek = kek
        self._base_dir = base_dir
        root.mkdir(parents=True, exist_ok=True, mode=0o700)
        os.chmod(root, 0o700)

    # --- keys -------------------------------------------------------------
    def _campaign_dir(self, campaign_run_id: str) -> Path:
        d = self._root / campaign_run_id
        d.mkdir(exist_ok=True, mode=0o700)
        return d

    def _dek(self, campaign_run_id: str) -> bytes:
        wrapped = self._campaign_dir(campaign_run_id) / "dek.wrapped"
        aes = self._AESGCM(self._kek)
        if wrapped.exists():
            blob = wrapped.read_bytes()
            return aes.decrypt(blob[:12], blob[12:], campaign_run_id.encode("utf-8"))
        dek = secrets.token_bytes(32)
        nonce = secrets.token_bytes(12)
        fd = os.open(wrapped, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "wb") as fh:
            fh.write(nonce + aes.encrypt(nonce, dek, campaign_run_id.encode("utf-8")))
        return dek

    # --- objects ----------------------------------------------------------
    def is_sealed(self, campaign_run_id: str) -> bool:
        return (self._root / campaign_run_id / "manifest.json").exists()

    def put(self, *, campaign_run_id: str, kind: str, data: bytes, retention_days: int = RETENTION_DAYS_DEFAULT,
            now: datetime | None = None) -> EvidenceRef:
        if kind not in EVIDENCE_KINDS:
            raise VaultError(f"unknown evidence kind {kind!r}")
        if self.is_sealed(campaign_run_id):
            raise VaultError("campaign evidence is sealed; no further writes")
        truncated = len(data) > MAX_RESPONSE_BYTES
        body = data[:MAX_RESPONSE_BYTES]
        digest = "sha256:" + hashlib.sha256(body).hexdigest()
        ref = f"vault://{campaign_run_id}/{digest[7:]}"
        nonce = secrets.token_bytes(12)
        blob = nonce + self._AESGCM(self._dek(campaign_run_id)).encrypt(nonce, body, ref.encode("utf-8"))
        path = self._campaign_dir(campaign_run_id) / f"{digest[7:]}.bin"
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "wb") as fh:
            fh.write(blob)
        stamp = now or datetime.now(timezone.utc)
        row = {"schema_version": 1, "recorded_at": utc_now(), "campaign_run_id": campaign_run_id, "kind": kind,
               "digest": digest, "size": len(body), "truncated": truncated, "ref": ref,
               "preview": redacted_preview(body), "retention_days": int(retention_days),
               "expires_at": (stamp + timedelta(days=int(retention_days))).isoformat()}
        ledger = ensure_tools_dir(self._base_dir).joinpath(*EVIDENCE_RELPATH)
        ledger.parent.mkdir(parents=True, exist_ok=True)
        append_declared_jsonl(ledger, row, expected_surface=EVIDENCE_SURFACE)
        return EvidenceRef(ref=ref, campaign_run_id=campaign_run_id, kind=kind, digest=digest, size=len(body), truncated=truncated)

    def get(self, ref: str) -> bytes:
        if not ref.startswith("vault://"):
            raise VaultError("not a vault ref")
        campaign_run_id, obj = ref[len("vault://"):].split("/", 1)
        path = self._root / campaign_run_id / f"{obj}.bin"
        if not path.exists():
            raise VaultError("evidence object missing (purged or never stored)")
        blob = path.read_bytes()
        return self._AESGCM(self._dek(campaign_run_id)).decrypt(blob[:12], blob[12:], ref.encode("utf-8"))

    def seal(self, campaign_run_id: str) -> str:
        d = self._campaign_dir(campaign_run_id)
        objects = sorted(p.name[:-4] for p in d.glob("*.bin"))
        manifest = {"campaign_run_id": campaign_run_id, "objects": objects, "sealed_at": utc_now()}
        raw = json.dumps(manifest, sort_keys=True).encode("utf-8")
        digest = "sha256:" + hashlib.sha256(raw).hexdigest()
        fd = os.open(d / "manifest.json", os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "wb") as fh:
            fh.write(raw)
        ledger = ensure_tools_dir(self._base_dir).joinpath(*EVIDENCE_RELPATH)
        append_declared_jsonl(ledger, {"schema_version": 1, "recorded_at": utc_now(), "campaign_run_id": campaign_run_id,
                                       "kind": "manifest", "digest": digest, "size": len(raw), "truncated": False,
                                       "ref": f"vault://{campaign_run_id}/manifest", "preview": f"{len(objects)} objects",
                                       "retention_days": RETENTION_DAYS_CONFIRMED_CRITICAL,
                                       "expires_at": (datetime.now(timezone.utc) + timedelta(days=RETENTION_DAYS_CONFIRMED_CRITICAL)).isoformat()},
                              expected_surface=EVIDENCE_SURFACE)
        return digest

    def purge_expired(self, *, now: datetime | None = None) -> list[str]:
        """Delete expired objects and write a deletion receipt per object."""
        stamp = now or datetime.now(timezone.utc)
        ledger = ensure_tools_dir(self._base_dir).joinpath(*EVIDENCE_RELPATH)
        if not ledger.exists():
            return []
        purged: list[str] = []
        for row in load_declared_jsonl(ledger, expected_surface=EVIDENCE_SURFACE):
            if row.get("kind") == "manifest" or row.get("kind") == "deletion_receipt":
                continue
            try:
                expires = datetime.fromisoformat(str(row.get("expires_at")))
            except ValueError:
                continue
            ref = str(row.get("ref"))
            path = self._root / ref[len("vault://"):].split("/", 1)[0] / (ref.rsplit("/", 1)[1] + ".bin")
            if expires <= stamp and path.exists():
                path.unlink()
                purged.append(ref)
                append_declared_jsonl(ledger, {"schema_version": 1, "recorded_at": utc_now(), "campaign_run_id": row.get("campaign_run_id"),
                                               "kind": "deletion_receipt", "digest": row.get("digest"), "size": 0, "truncated": False,
                                               "ref": ref, "preview": "purged", "retention_days": 0, "expires_at": stamp.isoformat()},
                                      expected_surface=EVIDENCE_SURFACE)
        return purged


__all__ = [
    "EVIDENCE_KINDS", "EVIDENCE_RELPATH", "EVIDENCE_SURFACE", "PREVIEW_CHARS", "RETENTION_DAYS_CONFIRMED_CRITICAL",
    "RETENTION_DAYS_DEFAULT", "EvidenceRef", "EvidenceVault", "VaultBackendUnavailable", "VaultError",
    "kek_from_fd", "redacted_preview",
]
