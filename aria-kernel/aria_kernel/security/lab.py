"""Plan 033 Faz 033d — ephemeral lab contracts: spec, lease registry, attestation, teardown.

WHY: the ONLY legal active target is a per-campaign ephemeral lab. There is no
"register arbitrary target" path: a lease exists only when a TRUSTED provisioner
writes it, an attestation binds digests (images pinned by sha256, seed, migration)
and proves the lab network does not overlap the production deny inventory, and a
campaign cannot CLOSE without a teardown receipt. Real Docker provisioning is the
operator's infrastructure; the dry-run provisioner is honest about being dry-run
(never a qualifying cycle).
"""
from __future__ import annotations

import hashlib
import json
import ipaddress
import uuid
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any

from ..ledger import append_declared_jsonl, load_declared_jsonl
from ..tool_registry import ensure_tools_dir, utc_now
from .scope_policy import DenyInventory

LEASE_SURFACE = "security_lab_leases"
LEASE_RELPATH: tuple[str, ...] = ("security", "lab-leases.jsonl")
TEARDOWN_SURFACE = "security_lab_teardowns"
TEARDOWN_RELPATH: tuple[str, ...] = ("security", "lab-teardowns.jsonl")
LAB_TEMPLATES = ("aqua-two-tenant-v1",)
TRUSTED_PROVISIONERS = ("trusted_docker", "dry_run")
QUALIFYING_PROVISIONERS = ("trusted_docker",)
MIN_TENANTS = 2


class LabError(ValueError):
    pass


@dataclass(frozen=True)
class LabSpec:
    template: str
    image_digests: dict[str, str]
    migration_digest: str
    seed_digest: str
    network_cidr: str
    tenants: tuple[str, ...] = ("tenant-a", "tenant-b")

    def validate(self) -> None:
        if self.template not in LAB_TEMPLATES:
            raise LabError(f"unknown lab template {self.template!r}")
        for name, digest in self.image_digests.items():
            if not digest.startswith("sha256:") or len(digest) != 71:
                raise LabError(f"image {name!r} is not pinned to a sha256 digest (floating tags refused)")
        if len(self.tenants) < MIN_TENANTS or len(set(self.tenants)) != len(self.tenants):
            raise LabError("a lab needs at least two distinct synthetic tenants")
        net = ipaddress.ip_network(self.network_cidr, strict=False)
        if not net.is_private or net.is_loopback or net.is_link_local:
            raise LabError("lab network must be a private, non-loopback, non-link-local range")

    @property
    def digest(self) -> str:
        return "sha256:" + hashlib.sha256(json.dumps(asdict(self), sort_keys=True).encode("utf-8")).hexdigest()


@dataclass(frozen=True)
class LabLease:
    lease_id: str
    campaign_run_id: str
    spec_digest: str
    network_cidr: str
    target_hosts: tuple[str, ...]
    provisioner_kind: str
    created_at: str
    expires_at: str

    @property
    def qualifying(self) -> bool:
        return self.provisioner_kind in QUALIFYING_PROVISIONERS


def record_lease(spec: LabSpec, *, campaign_run_id: str, provisioner_kind: str, target_hosts: tuple[str, ...],
                 expires_at: str, base_dir: str | Path | None = None) -> LabLease:
    """Only a trusted provisioner identity may write a lease; there is no CLI for this."""
    if provisioner_kind not in TRUSTED_PROVISIONERS:
        raise LabError(f"provisioner {provisioner_kind!r} is not trusted; lease refused")
    spec.validate()
    lease = LabLease(lease_id="lease-" + uuid.uuid4().hex[:12], campaign_run_id=campaign_run_id, spec_digest=spec.digest,
                     network_cidr=spec.network_cidr, target_hosts=tuple(target_hosts), provisioner_kind=provisioner_kind,
                     created_at=utc_now(), expires_at=expires_at)
    path = ensure_tools_dir(base_dir).joinpath(*LEASE_RELPATH)
    path.parent.mkdir(parents=True, exist_ok=True)
    append_declared_jsonl(path, {"schema_version": 1, **asdict(lease), "qualifying": lease.qualifying}, expected_surface=LEASE_SURFACE)
    return lease


def find_lease(lease_id: str, *, base_dir: str | Path | None = None) -> LabLease | None:
    path = ensure_tools_dir(base_dir).joinpath(*LEASE_RELPATH)
    if not path.exists():
        return None
    for row in load_declared_jsonl(path, expected_surface=LEASE_SURFACE):
        if row.get("lease_id") == lease_id:
            return LabLease(**{k: (tuple(v) if k == "target_hosts" else v) for k, v in row.items()
                               if k in LabLease.__dataclass_fields__})
    return None


@dataclass(frozen=True)
class LabAttestation:
    lease_id: str
    spec_digest: str
    inventory_digest: str
    network_cidr: str
    provisioner_kind: str
    qualifying: bool
    attested_at: str

    @property
    def digest(self) -> str:
        return "sha256:" + hashlib.sha256(json.dumps(asdict(self), sort_keys=True).encode("utf-8")).hexdigest()


def attest_lab(spec: LabSpec, lease: LabLease, inventory: DenyInventory) -> LabAttestation:
    """Bind digests + prove the lab network cannot overlap production. Fail-closed."""
    spec.validate()
    if lease.spec_digest != spec.digest:
        raise LabError("lease/spec digest mismatch")
    if lease.provisioner_kind not in TRUSTED_PROVISIONERS:
        raise LabError("lease provisioner not trusted")
    lab_net = ipaddress.ip_network(lease.network_cidr, strict=False)
    for cidr in inventory.cidrs:
        try:
            deny_net = ipaddress.ip_network(cidr, strict=False)
        except ValueError as exc:
            raise LabError(f"deny inventory cidr {cidr!r} unparseable — refusing to attest") from exc
        if lab_net.overlaps(deny_net):
            raise LabError(f"lab network {lease.network_cidr} overlaps production inventory {cidr}")
    for host in lease.target_hosts:
        if inventory.matches_host(host):
            raise LabError(f"lab target host {host!r} matches production deny inventory")
    return LabAttestation(lease_id=lease.lease_id, spec_digest=spec.digest, inventory_digest=inventory.digest,
                          network_cidr=lease.network_cidr, provisioner_kind=lease.provisioner_kind,
                          qualifying=lease.qualifying, attested_at=utc_now())


def record_teardown(*, lease_id: str, campaign_run_id: str, ok: bool, leaked_resources: tuple[str, ...] = (),
                    base_dir: str | Path | None = None) -> dict[str, Any]:
    path = ensure_tools_dir(base_dir).joinpath(*TEARDOWN_RELPATH)
    path.parent.mkdir(parents=True, exist_ok=True)
    row = {"schema_version": 1, "recorded_at": utc_now(), "lease_id": lease_id, "campaign_run_id": campaign_run_id,
           "ok": bool(ok) and not leaked_resources, "leaked_resources": list(leaked_resources)}
    return append_declared_jsonl(path, row, expected_surface=TEARDOWN_SURFACE)


def teardown_verified(lease_id: str, *, base_dir: str | Path | None = None) -> bool:
    path = ensure_tools_dir(base_dir).joinpath(*TEARDOWN_RELPATH)
    if not path.exists():
        return False
    rows = [r for r in load_declared_jsonl(path, expected_surface=TEARDOWN_SURFACE) if r.get("lease_id") == lease_id]
    return bool(rows) and bool(rows[-1].get("ok"))


def dry_run_provision(spec: LabSpec, *, campaign_run_id: str, expires_at: str,
                      base_dir: str | Path | None = None) -> LabLease:
    """Contract-only provisioning for tests/CI: honest `dry_run` kind, never qualifying."""
    return record_lease(spec, campaign_run_id=campaign_run_id, provisioner_kind="dry_run",
                        target_hosts=("api.lab.internal", "gateway.lab.internal"), expires_at=expires_at, base_dir=base_dir)


__all__ = [
    "LAB_TEMPLATES", "LEASE_RELPATH", "LEASE_SURFACE", "MIN_TENANTS", "QUALIFYING_PROVISIONERS", "TEARDOWN_RELPATH",
    "TEARDOWN_SURFACE", "TRUSTED_PROVISIONERS", "LabAttestation", "LabError", "LabLease", "LabSpec",
    "attest_lab", "dry_run_provision", "find_lease", "record_lease", "record_teardown", "teardown_verified",
]
