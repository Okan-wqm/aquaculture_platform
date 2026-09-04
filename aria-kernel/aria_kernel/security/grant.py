"""Plan 033 Faz 033e — CampaignGrant: EdDSA JWS, single-use JTI, fail-closed.

WHY: the grant is the ONLY cryptographic signature in ARIA. It binds a campaign run
to a lab attestation, the profile/pack/graph digests, a policy digest and a risk
ceiling; the policy proxy re-verifies it on every hop. A grant with any other `alg`,
a bad signature, an expired/not-yet-valid window, a mismatched digest, an R4 class or
an un-approved R3 class is worth zero packets. A JTI activates for exactly one
`campaign_run_id` (the same run may re-activate for crash recovery; another cannot).
The private key lives OUTSIDE the workspace; if the signing backend is missing the
lane fails closed instead of degrading to an unsigned grant.
"""
from __future__ import annotations

import base64
import hashlib
import json
import os
import uuid
from dataclasses import asdict, dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

from ..ledger import append_declared_jsonl, load_declared_jsonl
from ..tool_registry import ensure_tools_dir, utc_now
from .scope_policy import RISK_CLASSES

GRANT_SURFACE = "security_grants"
GRANT_RELPATH: tuple[str, ...] = ("security", "grants.jsonl")
GRANT_TYP = "aria-campaign-grant+jws"
GRANT_ALG = "EdDSA"
MAX_GRANT_MINUTES = 30
AUTO_RISK_CLASSES = ("R0_PASSIVE", "R1_BOUNDED_READ", "R2_SYNTHETIC_MUTATION")


class SigningBackendUnavailable(RuntimeError):
    """`cryptography` (Ed25519) is not importable — grants cannot be issued or verified."""


class GrantError(ValueError):
    """The grant is invalid for the stated reason; zero packets may flow."""


def _backend() -> Any:
    try:
        from cryptography.hazmat.primitives import serialization
        from cryptography.hazmat.primitives.asymmetric import ed25519
    except ImportError as exc:  # pragma: no cover - environment dependent
        raise SigningBackendUnavailable("cryptography with Ed25519 is required for CampaignGrant") from exc
    return serialization, ed25519


def backend_available() -> bool:
    try:
        _backend()
        return True
    except SigningBackendUnavailable:
        return False


def _b64(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def _unb64(text: str) -> bytes:
    pad = "=" * (-len(text) % 4)
    return base64.urlsafe_b64decode(text + pad)


def _assert_outside_workspace(path: Path, workspace_root: str | Path | None) -> None:
    if workspace_root is None:
        return
    ws = Path(workspace_root).resolve()
    if ws == path.resolve() or ws in path.resolve().parents:
        raise GrantError(f"signing key path {path} must be outside the workspace {ws}")


def generate_keypair(key_dir: str | Path, *, workspace_root: str | Path | None = None) -> tuple[Path, Path]:
    """Write private.pem (0600) + public.raw into `key_dir` (0700, outside the workspace)."""
    serialization, ed25519 = _backend()
    directory = Path(key_dir)
    _assert_outside_workspace(directory, workspace_root)
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    os.chmod(directory, 0o700)
    private = ed25519.Ed25519PrivateKey.generate()
    priv_path = directory / "private.pem"
    pub_path = directory / "public.raw"
    pem = private.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption())
    fd = os.open(priv_path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "wb") as fh:
        fh.write(pem)
    pub_path.write_bytes(private.public_key().public_bytes(serialization.Encoding.Raw, serialization.PublicFormat.Raw))
    return priv_path, pub_path


@dataclass(frozen=True)
class GrantClaims:
    jti: str
    campaign_run_id: str
    lease_id: str
    lab_attestation_digest: str
    profile_digest: str
    pack_digests: tuple[str, ...]
    graph_digest: str
    policy_digest: str
    risk_class: str
    lab_network: str
    allowed_hosts: tuple[str, ...]
    iat: int
    exp: int
    recipe_digest: str | None = None
    human_approval_ref: str | None = None

    def validate_structure(self) -> None:
        if self.risk_class not in RISK_CLASSES:
            raise GrantError(f"unknown risk class {self.risk_class!r}")
        if self.risk_class == "R4_FORBIDDEN":
            raise GrantError("R4_FORBIDDEN can never be granted")
        if self.risk_class == "R3_HUMAN_REQUIRED" and not (self.human_approval_ref and self.recipe_digest):
            raise GrantError("R3 needs a human approval ref bound to an exact recipe digest")
        if self.exp - self.iat > MAX_GRANT_MINUTES * 60 or self.exp <= self.iat:
            raise GrantError("grant window must be positive and at most MAX_GRANT_MINUTES")
        if not self.allowed_hosts or not self.lab_network or not self.lease_id:
            raise GrantError("grant must bind a lease, a lab network and explicit hosts")
        for d in (self.lab_attestation_digest, self.profile_digest, self.graph_digest, self.policy_digest, *self.pack_digests):
            if not str(d).startswith("sha256:"):
                raise GrantError("every bound digest must be sha256:")


class GrantSigner:
    def __init__(self, private_key_path: str | Path, *, workspace_root: str | Path | None = None) -> None:
        serialization, ed25519 = _backend()
        path = Path(private_key_path)
        _assert_outside_workspace(path, workspace_root)
        if (path.stat().st_mode & 0o077) != 0:
            raise GrantError("private key file must not be group/world accessible")
        self._key = serialization.load_pem_private_key(path.read_bytes(), password=None)
        if not isinstance(self._key, ed25519.Ed25519PrivateKey):
            raise GrantError("private key is not Ed25519")
        self.kid = "ed25519:" + hashlib.sha256(
            self._key.public_key().public_bytes(serialization.Encoding.Raw, serialization.PublicFormat.Raw)).hexdigest()[:16]

    def sign(self, claims: GrantClaims) -> str:
        claims.validate_structure()
        header = _b64(json.dumps({"alg": GRANT_ALG, "typ": GRANT_TYP, "kid": self.kid}, sort_keys=True).encode("utf-8"))
        payload = _b64(json.dumps(asdict(claims), sort_keys=True).encode("utf-8"))
        signing_input = f"{header}.{payload}".encode("ascii")
        return f"{header}.{payload}.{_b64(self._key.sign(signing_input))}"


def new_claims(*, campaign_run_id: str, lease_id: str, lab_attestation_digest: str, profile_digest: str,
               pack_digests: tuple[str, ...], graph_digest: str, policy_digest: str, risk_class: str,
               lab_network: str, allowed_hosts: tuple[str, ...], minutes: int = MAX_GRANT_MINUTES,
               recipe_digest: str | None = None, human_approval_ref: str | None = None,
               now: datetime | None = None) -> GrantClaims:
    stamp = now or datetime.now(timezone.utc)
    iat = int(stamp.timestamp())
    return GrantClaims(jti="jti-" + uuid.uuid4().hex, campaign_run_id=campaign_run_id, lease_id=lease_id,
                       lab_attestation_digest=lab_attestation_digest, profile_digest=profile_digest,
                       pack_digests=tuple(pack_digests), graph_digest=graph_digest, policy_digest=policy_digest,
                       risk_class=risk_class, lab_network=lab_network, allowed_hosts=tuple(allowed_hosts), iat=iat,
                       exp=iat + int(timedelta(minutes=minutes).total_seconds()), recipe_digest=recipe_digest,
                       human_approval_ref=human_approval_ref)


def grant_digest(token: str) -> str:
    return "sha256:" + hashlib.sha256(token.encode("ascii")).hexdigest()


def verify_grant(token: str, public_key_raw: bytes, *, now: datetime | None = None,
                 expected: dict[str, Any] | None = None) -> GrantClaims:
    """Cryptographic + structural verification. Does NOT consult the JTI registry — see `activate_grant`."""
    serialization, ed25519 = _backend()
    parts = token.split(".")
    if len(parts) != 3:
        raise GrantError("malformed compact JWS")
    try:
        header = json.loads(_unb64(parts[0]))
        payload = json.loads(_unb64(parts[1]))
        signature = _unb64(parts[2])
    except (ValueError, TypeError) as exc:
        raise GrantError("undecodable JWS segments") from exc
    if header.get("alg") != GRANT_ALG or header.get("typ") != GRANT_TYP:
        raise GrantError(f"alg/typ rejected: {header.get('alg')!r}/{header.get('typ')!r}")
    try:
        ed25519.Ed25519PublicKey.from_public_bytes(public_key_raw).verify(signature, f"{parts[0]}.{parts[1]}".encode("ascii"))
    except Exception as exc:  # cryptography raises InvalidSignature
        raise GrantError("signature invalid") from exc
    try:
        claims = GrantClaims(**{**payload, "pack_digests": tuple(payload.get("pack_digests", ())),
                                "allowed_hosts": tuple(payload.get("allowed_hosts", ()))})
    except TypeError as exc:
        raise GrantError("claims do not match the grant schema") from exc
    claims.validate_structure()
    ts = int((now or datetime.now(timezone.utc)).timestamp())
    if ts < claims.iat - 5:
        raise GrantError("grant not yet valid")
    if ts >= claims.exp:
        raise GrantError("grant expired")
    for key, value in (expected or {}).items():
        have = getattr(claims, key, None)
        if (tuple(value) if isinstance(value, (list, tuple)) else value) != have:
            raise GrantError(f"grant {key} mismatch")
    return claims


def activate_grant(claims: GrantClaims, token: str, *, base_dir: str | Path | None = None) -> dict[str, Any]:
    """Single-use JTI: a JTI activates for exactly one campaign_run_id (idempotent for that run)."""
    path = ensure_tools_dir(base_dir).joinpath(*GRANT_RELPATH)
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.exists():
        for row in load_declared_jsonl(path, expected_surface=GRANT_SURFACE):
            if row.get("jti") == claims.jti and row.get("campaign_run_id") != claims.campaign_run_id:
                raise GrantError("jti already activated by another campaign run")
    row = {"schema_version": 1, "activated_at": utc_now(), "jti": claims.jti, "campaign_run_id": claims.campaign_run_id,
           "lease_id": claims.lease_id, "risk_class": claims.risk_class, "grant_digest": grant_digest(token),
           "exp": claims.exp}
    return append_declared_jsonl(path, row, expected_surface=GRANT_SURFACE)


__all__ = [
    "AUTO_RISK_CLASSES", "GRANT_ALG", "GRANT_RELPATH", "GRANT_SURFACE", "GRANT_TYP", "MAX_GRANT_MINUTES",
    "GrantClaims", "GrantError", "GrantSigner", "SigningBackendUnavailable", "activate_grant",
    "backend_available", "generate_keypair", "grant_digest", "new_claims", "verify_grant",
]
