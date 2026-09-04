"""Plan 033 Faz 033d — SecurityScopePolicy: risk classes, ceilings, deny inventory.

WHY: the single place that decides WHAT may be touched and HOW MUCH. Production,
shared staging, real farm data and real OT are R4_FORBIDDEN by construction; the
deny inventory is repo-owned and an unreadable/incomplete inventory refuses active
work (fail-closed). No env var, issue text or LLM output can widen a ceiling.
"""
from __future__ import annotations

import hashlib
import ipaddress
import json
import threading
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

RISK_CLASSES = ("R0_PASSIVE", "R1_BOUNDED_READ", "R2_SYNTHETIC_MUTATION", "R3_HUMAN_REQUIRED", "R4_FORBIDDEN")
DENY_INVENTORY_RELPATH: tuple[str, ...] = ("infrastructure", "aria", "security-lab", "production-deny-inventory.json")
MAX_BODY_BYTES = 256 * 1024
MAX_RESPONSE_BYTES = 1024 * 1024
MAX_CAMPAIGN_BYTES = 250 * 1024 * 1024
# metadata endpoints that are not covered by the generic link-local/loopback checks
_METADATA_IPS = frozenset({"169.254.169.254", "fd00:ec2::254", "100.100.100.200", "192.0.0.192"})


@dataclass(frozen=True)
class Ceiling:
    max_requests: int
    max_rps: float
    max_concurrency: int
    max_mutations: int
    max_minutes: int


CEILINGS: dict[str, Ceiling] = {
    "R0_PASSIVE": Ceiling(0, 0.0, 0, 0, 0),
    "R1_BOUNDED_READ": Ceiling(10_000, 10.0, 4, 0, 30),
    "R2_SYNTHETIC_MUTATION": Ceiling(2_000, 5.0, 2, 200, 30),
    "R3_HUMAN_REQUIRED": Ceiling(0, 0.0, 0, 0, 0),
    "R4_FORBIDDEN": Ceiling(0, 0.0, 0, 0, 0),
}


class DenyInventoryUnavailable(RuntimeError):
    """The production deny inventory cannot be read or is incomplete — no active campaign may start."""


@dataclass(frozen=True)
class DenyInventory:
    hostname_suffixes: tuple[str, ...]
    cidrs: tuple[str, ...]
    labels: tuple[str, ...]
    complete: bool
    digest: str

    def matches_host(self, host: str) -> bool:
        h = host.lower().rstrip(".")
        return any(h == s or h.endswith("." + s) for s in self.hostname_suffixes)

    def matches_ip(self, ip: ipaddress.IPv4Address | ipaddress.IPv6Address) -> bool:
        for cidr in self.cidrs:
            try:
                if ip in ipaddress.ip_network(cidr, strict=False):
                    return True
            except ValueError:
                continue
        return False


def load_deny_inventory(workspace_root: str | Path) -> DenyInventory:
    path = Path(workspace_root).resolve().joinpath(*DENY_INVENTORY_RELPATH)
    try:
        raw = path.read_bytes()
        doc = json.loads(raw.decode("utf-8"))
    except (OSError, ValueError) as exc:
        raise DenyInventoryUnavailable(f"deny inventory unreadable: {path} ({exc})") from exc
    if not isinstance(doc, dict) or not isinstance(doc.get("hostname_suffixes"), list):
        raise DenyInventoryUnavailable(f"deny inventory malformed: {path}")
    complete = not bool(doc.get("cidrs_operator_must_fill")) or bool(doc.get("cidrs"))
    return DenyInventory(
        hostname_suffixes=tuple(str(s).lower() for s in doc.get("hostname_suffixes", [])),
        cidrs=tuple(str(c) for c in doc.get("cidrs", [])), labels=tuple(str(l) for l in doc.get("labels", [])),
        complete=complete, digest="sha256:" + hashlib.sha256(raw).hexdigest(),
    )


def canonical_ip(value: str) -> ipaddress.IPv4Address | ipaddress.IPv6Address:
    ip = ipaddress.ip_address(value.strip("[]"))
    mapped = getattr(ip, "ipv4_mapped", None)
    return mapped if mapped is not None else ip


def classify_target(*, host: str, resolved_ips: tuple[str, ...], inventory: DenyInventory,
                    lab_network: str | None) -> tuple[str, str]:
    """Return (risk_class, reason). Anything not inside the campaign's own lab network
    is R4_FORBIDDEN: v1 has no public, production, metadata or out-of-scope target."""
    if inventory.matches_host(host):
        return "R4_FORBIDDEN", f"host {host!r} matches production deny inventory"
    if not resolved_ips:
        return "R4_FORBIDDEN", "unresolved host (no pinned IP)"
    net = ipaddress.ip_network(lab_network, strict=False) if lab_network else None
    for raw in resolved_ips:
        try:
            ip = canonical_ip(raw)
        except ValueError:
            return "R4_FORBIDDEN", f"unparseable ip {raw!r}"
        if str(ip) in _METADATA_IPS:
            return "R4_FORBIDDEN", "cloud metadata endpoint"
        if ip.is_loopback or ip.is_link_local or ip.is_multicast or ip.is_unspecified or ip.is_reserved:
            return "R4_FORBIDDEN", f"{ip} is loopback/link-local/multicast/unspecified/reserved"
        if inventory.matches_ip(ip):
            return "R4_FORBIDDEN", f"{ip} inside production deny inventory"
        if net is None or ip not in net:
            return "R4_FORBIDDEN", f"{ip} outside the campaign lab network {lab_network!r}"
    return "R1_BOUNDED_READ", "inside lab network"


class Budget:
    """Atomic campaign budget derived from a risk ceiling; the proxy consumes it per hop."""

    def __init__(self, risk_class: str) -> None:
        if risk_class not in RISK_CLASSES:
            raise ValueError(f"unknown risk class {risk_class!r}")
        self.risk_class = risk_class
        self.ceiling = CEILINGS[risk_class]
        self._lock = threading.Lock()
        self.requests = 0
        self.mutations = 0
        self.bytes_out = 0
        self.exhausted_reason: str | None = None

    def try_consume(self, *, mutation: bool = False, bytes_out: int = 0) -> tuple[bool, str]:
        with self._lock:
            if self.exhausted_reason:
                return False, self.exhausted_reason
            if bytes_out > MAX_BODY_BYTES:
                return False, "body exceeds MAX_BODY_BYTES"
            if self.requests + 1 > self.ceiling.max_requests:
                self.exhausted_reason = "request ceiling reached"
                return False, self.exhausted_reason
            if mutation and self.mutations + 1 > self.ceiling.max_mutations:
                self.exhausted_reason = "mutation ceiling reached"
                return False, self.exhausted_reason
            if self.bytes_out + bytes_out > MAX_CAMPAIGN_BYTES:
                self.exhausted_reason = "campaign byte ceiling reached"
                return False, self.exhausted_reason
            self.requests += 1
            self.mutations += 1 if mutation else 0
            self.bytes_out += bytes_out
            return True, "ok"


@dataclass(frozen=True)
class SecurityScopePolicy:
    """Repo-owned policy digest: which ceilings apply, which inventory was in force."""
    inventory_digest: str
    inventory_complete: bool
    ceilings: dict[str, Ceiling] = field(default_factory=lambda: dict(CEILINGS))

    @property
    def policy_digest(self) -> str:
        payload = {"inventory_digest": self.inventory_digest, "ceilings": {k: v.__dict__ for k, v in self.ceilings.items()},
                   "limits": [MAX_BODY_BYTES, MAX_RESPONSE_BYTES, MAX_CAMPAIGN_BYTES]}
        return "sha256:" + hashlib.sha256(json.dumps(payload, sort_keys=True).encode("utf-8")).hexdigest()

    def max_auto_risk(self) -> str:
        """R2 is the automatic ceiling; R3 needs a human grant; incomplete inventory caps at R0."""
        return "R2_SYNTHETIC_MUTATION" if self.inventory_complete else "R0_PASSIVE"


def load_policy(workspace_root: str | Path) -> SecurityScopePolicy:
    inv = load_deny_inventory(workspace_root)
    return SecurityScopePolicy(inventory_digest=inv.digest, inventory_complete=inv.complete)


__all__ = [
    "CEILINGS", "DENY_INVENTORY_RELPATH", "MAX_BODY_BYTES", "MAX_CAMPAIGN_BYTES", "MAX_RESPONSE_BYTES",
    "RISK_CLASSES", "Budget", "Ceiling", "DenyInventory", "DenyInventoryUnavailable", "SecurityScopePolicy",
    "canonical_ip", "classify_target", "load_deny_inventory", "load_policy",
]
