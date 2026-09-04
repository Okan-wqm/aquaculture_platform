"""Plan 033 Faz 033d — persona broker: per-campaign/role/tenant credentials that never leak.

WHY: probes need to act as tenant-A user / tenant-B admin. Secrets live only in the
broker's memory (or an FD the executor is handed); the ledger holds handles + roles,
never secrets; revocation is per campaign. `assert_no_leak` is the tripwire tests use
to prove a secret is absent from env/argv/logs/prompts/artifacts.
"""
from __future__ import annotations

import secrets as _secrets
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from ..ledger import append_declared_jsonl
from ..tool_registry import ensure_tools_dir, utc_now

PERSONA_SURFACE = "security_personas"
PERSONA_RELPATH: tuple[str, ...] = ("security", "personas.jsonl")
ROLES = ("tenant_user", "tenant_admin", "platform_operator", "device")


class PersonaError(RuntimeError):
    pass


@dataclass(frozen=True)
class PersonaHandle:
    handle: str
    campaign_run_id: str
    role: str
    tenant: str


class PersonaBroker:
    def __init__(self, *, base_dir: str | Path | None = None) -> None:
        self._base_dir = base_dir
        self._secrets: dict[str, str] = {}
        self._issued: dict[str, PersonaHandle] = {}
        self._revoked: set[str] = set()

    def issue(self, *, campaign_run_id: str, role: str, tenant: str) -> PersonaHandle:
        if role not in ROLES:
            raise PersonaError(f"unknown role {role!r}")
        handle = PersonaHandle(handle="persona-" + uuid.uuid4().hex[:12], campaign_run_id=campaign_run_id, role=role, tenant=tenant)
        self._secrets[handle.handle] = _secrets.token_urlsafe(32)
        self._issued[handle.handle] = handle
        self._record({"event": "issued", **handle.__dict__})
        return handle

    def secret_for(self, handle: str) -> str:
        if handle in self._revoked or handle not in self._secrets:
            raise PersonaError("persona revoked or unknown")
        return self._secrets[handle]

    def revoke_campaign(self, campaign_run_id: str) -> int:
        count = 0
        for h, meta in list(self._issued.items()):
            if meta.campaign_run_id == campaign_run_id and h not in self._revoked:
                self._revoked.add(h)
                self._secrets.pop(h, None)
                count += 1
                self._record({"event": "revoked", **meta.__dict__})
        return count

    def is_active(self, handle: str) -> bool:
        return handle in self._issued and handle not in self._revoked

    def assert_no_leak(self, text: str) -> None:
        """Tripwire: raise if any live or revoked secret value appears in `text`."""
        for value in list(self._secrets.values()):
            if value and value in text:
                raise PersonaError("persona secret leaked into text")

    def _record(self, row: dict[str, Any]) -> None:
        assert "secret" not in row
        path = ensure_tools_dir(self._base_dir).joinpath(*PERSONA_RELPATH)
        path.parent.mkdir(parents=True, exist_ok=True)
        append_declared_jsonl(path, {"schema_version": 1, "recorded_at": utc_now(), **row}, expected_surface=PERSONA_SURFACE)

    def __repr__(self) -> str:  # never print secrets
        return f"PersonaBroker(issued={len(self._issued)}, revoked={len(self._revoked)})"


__all__ = ["PERSONA_RELPATH", "PERSONA_SURFACE", "ROLES", "PersonaBroker", "PersonaError", "PersonaHandle"]
