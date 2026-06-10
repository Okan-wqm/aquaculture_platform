"""Plan ARIA-V3 §2n + INFRA-HIGH-004 — cross-host autonomous-loop lease lock.

PROBLEM:
  The autonomous orchestrator can run BOTH as a local daemon AND as
  a GHA cron job (`aria-agent-executor.yml`). If both fire
  simultaneously — operator running `aria-kernel autonomy run` on
  their laptop while the 02:00 UTC cron also starts — two processes
  race on the same ack-ledger + materialize chain + outbox. Worst
  case: duplicate auto-mints + double-commit of the same draft. The
  Git layer would catch some of this; the kernel ledger would not.

V3 §2n SOLUTION (Tier-1: structurally impossible cross-host race):
  A SHARED lease file at ``aria-tools/locks/autonomous-host.lock``
  carries ``{host_id, pid, lease_acquired_at, lease_expires_at}``.
  The orchestrator writes its lease on every cycle (every 5 min).
  The lease is auto-committed by ``autonomy_orchestrator`` IF the
  lease state changed (so the GHA cron sees the latest lease via
  the snowball-committed file).

  GHA cron startup MUST refuse to enter the autonomous path when
  the lease is FRESH (last write < 5 min ago and from a different
  host). The cron emits ``autonomous_host_lease_blocked`` and
  exits cleanly — no error, no retry storm.

  Local daemon startup acquires the lease IF the existing lease is
  stale (last write > 5 min ago) or belongs to the same host_id.
  An already-running local daemon refreshes its OWN lease on every
  cycle.

The lease is NOT a mutex (no kernel-side locking primitive). It is
a TRUSTED-WITNESS contract: every actor honors the lease because
the audit-trail makes cheating visible at the next operator review.
That trust model is acceptable because:
  * Only the operator can run the local daemon (operator-approval-
    ref required to flip to autonomous profile per Plan ARIA-V3 §B2)
  * The GHA cron is single-instance (concurrency.group:
    aria-agent-executor-snowball + cancel-in-progress: false)
  * Cross-host race is the ONE concurrency edge — local daemon
    crash mid-cycle leaves a stale lease that ages out in 5 min

Audit-trail entries:
  * ``autonomous_host_lease_acquired`` — every fresh acquire
  * ``autonomous_host_lease_refreshed`` — every same-host refresh
  * ``autonomous_host_lease_blocked`` — cron exit on lease-fresh
  * ``autonomous_host_lease_released`` — explicit operator release
"""

from __future__ import annotations

import json
import os
import socket
from dataclasses import asdict, dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

from .tool_registry import (
    GovernanceError,
    append_tools_governance,
    ensure_tools_dir,
)


_LOCKS_DIR_RELATIVE = ("locks",)
_LEASE_FILENAME = "autonomous-host.lock"
_REMOTE_CAS_LEASE_FILENAME = "autonomous-host.cas.json"
_LEASE_DURATION_MINUTES: int = 5


@dataclass(frozen=True)
class HostLease:
    """Plan ARIA-V3 §2n — immutable lease record. Carries enough to
    decide acquire-vs-refuse on the next host's startup.
    """

    host_id: str
    pid: int
    lease_acquired_at: str
    lease_expires_at: str

    def is_fresh(self) -> bool:
        """A lease is fresh if its expires_at is still in the future."""
        try:
            expires = datetime.fromisoformat(
                self.lease_expires_at.replace("Z", "+00:00")
            )
        except ValueError:
            return False
        return expires > datetime.now(timezone.utc)


@dataclass(frozen=True)
class RemoteCasLease:
    """Remote-visible compare-and-swap lease record.

    This is the autonomous real-mode lease authority. The legacy
    ``HostLease`` file remains a local witness; this record carries the
    compare fields needed for local/GitHub-runner contention handling.
    """

    lease_id: str
    epoch: int
    owner: str
    target_ref: str
    head_sha: str
    acquired_at: str
    heartbeat_at: str
    expires_at: str

    def is_fresh(self) -> bool:
        try:
            expires = datetime.fromisoformat(self.expires_at.replace("Z", "+00:00"))
        except ValueError:
            return False
        return expires > datetime.now(timezone.utc)


def _locks_dir(base_dir: str | Path) -> Path:
    return Path(base_dir).joinpath(*_LOCKS_DIR_RELATIVE)


def _lease_path(base_dir: str | Path) -> Path:
    return _locks_dir(base_dir) / _LEASE_FILENAME


def _resolve_host_id() -> str:
    """Plan ARIA-V3 §2n — host id derived from hostname.

    GHA runners self-identify via ``RUNNER_NAME`` env var (e.g.
    ``GitHub Actions 1``). Local hosts use ``socket.gethostname``.
    The two namespaces never collide in practice (operator runs on
    a developer machine; cron runs on a GHA runner).
    """
    runner = os.environ.get("RUNNER_NAME", "").strip()
    if runner:
        return f"gha-runner:{runner}"
    return f"local:{socket.gethostname()}"


def _utc_now() -> datetime:
    return datetime.now(timezone.utc)


def _read_lease(base_dir: str | Path) -> HostLease | None:
    path = _lease_path(base_dir)
    if not path.exists():
        return None
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return None
    try:
        return HostLease(
            host_id=str(payload["host_id"]),
            pid=int(payload["pid"]),
            lease_acquired_at=str(payload["lease_acquired_at"]),
            lease_expires_at=str(payload["lease_expires_at"]),
        )
    except (KeyError, TypeError, ValueError):
        return None


def _atomic_write_lease(path: Path, lease: HostLease) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f".{path.name}.tmp.{lease.pid}")
    tmp.write_text(
        json.dumps(
            {
                "host_id": lease.host_id,
                "pid": lease.pid,
                "lease_acquired_at": lease.lease_acquired_at,
                "lease_expires_at": lease.lease_expires_at,
            },
            indent=2,
            sort_keys=True,
        ),
        encoding="utf-8",
    )
    tmp.replace(path)


def _build_lease(host_id: str, pid: int) -> HostLease:
    now = _utc_now()
    return HostLease(
        host_id=host_id,
        pid=pid,
        lease_acquired_at=now.isoformat().replace("+00:00", "Z"),
        lease_expires_at=(now + timedelta(minutes=_LEASE_DURATION_MINUTES))
        .isoformat()
        .replace("+00:00", "Z"),
    )


def _remote_cas_lease_path(base_dir: str | Path) -> Path:
    return _locks_dir(base_dir) / _REMOTE_CAS_LEASE_FILENAME


def _read_remote_cas_lease(base_dir: str | Path) -> RemoteCasLease | None:
    path = _remote_cas_lease_path(base_dir)
    if not path.exists():
        return None
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return None
    try:
        return RemoteCasLease(
            lease_id=str(payload["lease_id"]),
            epoch=int(payload["epoch"]),
            owner=str(payload["owner"]),
            target_ref=str(payload["target_ref"]),
            head_sha=str(payload["head_sha"]),
            acquired_at=str(payload["acquired_at"]),
            heartbeat_at=str(payload["heartbeat_at"]),
            expires_at=str(payload["expires_at"]),
        )
    except (KeyError, TypeError, ValueError):
        return None


def _atomic_write_remote_cas_lease(path: Path, lease: RemoteCasLease) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f".{path.name}.tmp.{os.getpid()}")
    tmp.write_text(
        json.dumps(asdict(lease), indent=2, sort_keys=True),
        encoding="utf-8",
    )
    tmp.replace(path)


def _build_remote_cas_lease(
    *,
    previous: RemoteCasLease | None,
    owner: str,
    target_ref: str,
    head_sha: str,
) -> RemoteCasLease:
    import hashlib

    now = _utc_now()
    epoch = (previous.epoch + 1) if previous is not None else 1
    seed = f"{owner}:{target_ref}:{head_sha}:{epoch}:{now.isoformat()}"
    return RemoteCasLease(
        lease_id="sha256:" + hashlib.sha256(seed.encode("utf-8")).hexdigest(),
        epoch=epoch,
        owner=owner,
        target_ref=target_ref,
        head_sha=head_sha,
        acquired_at=now.isoformat().replace("+00:00", "Z"),
        heartbeat_at=now.isoformat().replace("+00:00", "Z"),
        expires_at=(now + timedelta(minutes=_LEASE_DURATION_MINUTES)).isoformat().replace("+00:00", "Z"),
    )


def acquire_remote_cas_lease(
    *,
    base_dir: str | Path,
    target_ref: str,
    head_sha: str,
    owner: str | None = None,
    allow_same_owner_refresh: bool = True,
) -> RemoteCasLease:
    """Acquire the remote-visible autonomous lease with CAS semantics.

    The compare fields are ``epoch``, ``owner``, ``target_ref``,
    ``head_sha``, and ``expires_at``. A fresh lease held by another
    owner fails closed. A stale lease can be reaped by incrementing
    epoch. Same-owner refresh is allowed only when the target ref and
    head SHA still match, preventing a stale heartbeat from silently
    carrying a lease across a different commit.
    """
    root = ensure_tools_dir(base_dir)
    holder = owner or _resolve_host_id()
    if not target_ref or not head_sha:
        raise GovernanceError("remote_cas_lease_requires_target_ref_and_head_sha")
    existing = _read_remote_cas_lease(root)
    if existing is not None and existing.is_fresh():
        same_owner = existing.owner == holder
        same_target = existing.target_ref == target_ref and existing.head_sha == head_sha
        if not (same_owner and same_target and allow_same_owner_refresh):
            append_tools_governance(
                root,
                "remote_cas_lease_blocked",
                {
                    "requesting_owner": holder,
                    "requesting_target_ref": target_ref,
                    "requesting_head_sha": head_sha,
                    "existing": asdict(existing),
                },
            )
            raise GovernanceError(
                "remote_cas_lease_blocked: fresh lease held by "
                f"{existing.owner!r} for {existing.target_ref}@{existing.head_sha}"
            )
    next_lease = _build_remote_cas_lease(
        previous=existing,
        owner=holder,
        target_ref=target_ref,
        head_sha=head_sha,
    )
    _atomic_write_remote_cas_lease(_remote_cas_lease_path(root), next_lease)
    append_tools_governance(
        root,
        "remote_cas_lease_acquired",
        {
            "lease_id": next_lease.lease_id,
            "epoch": next_lease.epoch,
            "owner": holder,
            "target_ref": target_ref,
            "head_sha": head_sha,
            "predecessor_was_stale": existing is not None and not existing.is_fresh(),
        },
    )
    return next_lease


def remote_cas_lease_state(base_dir: str | Path) -> dict[str, Any]:
    existing = _read_remote_cas_lease(base_dir)
    if existing is None:
        return {"state": "no_lease"}
    payload = asdict(existing)
    payload["state"] = "fresh" if existing.is_fresh() else "stale"
    return payload


def acquire_lease(
    *,
    base_dir: str | Path,
    host_id: str | None = None,
    pid: int | None = None,
    allow_same_host_refresh: bool = True,
) -> HostLease:
    """Plan ARIA-V3 §2n + INFRA-HIGH-004 — acquire or refresh the
    autonomous-loop host lease.

    Returns the acquired ``HostLease`` on success. Raises
    ``GovernanceError`` with ``autonomous_host_lease_blocked`` when
    the existing lease is fresh AND belongs to a different host.

    ``allow_same_host_refresh`` (default True) lets a long-running
    local daemon refresh its OWN lease without restart; the GHA cron
    sets it to False because the cron is short-lived and should not
    extend a stale local lease.
    """
    host = host_id or _resolve_host_id()
    own_pid = pid or os.getpid()
    root = ensure_tools_dir(base_dir)
    existing = _read_lease(root)
    if existing is not None and existing.is_fresh():
        if existing.host_id == host and allow_same_host_refresh:
            refreshed = _build_lease(host, own_pid)
            _atomic_write_lease(_lease_path(root), refreshed)
            append_tools_governance(
                root,
                "autonomous_host_lease_refreshed",
                {
                    "host_id": host,
                    "pid": own_pid,
                    "lease_expires_at": refreshed.lease_expires_at,
                },
            )
            return refreshed
        # Different host owns a fresh lease — refuse.
        append_tools_governance(
            root,
            "autonomous_host_lease_blocked",
            {
                "requesting_host_id": host,
                "requesting_pid": own_pid,
                "existing_host_id": existing.host_id,
                "existing_lease_expires_at": existing.lease_expires_at,
            },
        )
        raise GovernanceError(
            f"autonomous_host_lease_blocked: another host "
            f"({existing.host_id!r}) holds a fresh lease until "
            f"{existing.lease_expires_at}"
        )
    # No lease OR stale — acquire fresh.
    fresh = _build_lease(host, own_pid)
    _atomic_write_lease(_lease_path(root), fresh)
    append_tools_governance(
        root,
        "autonomous_host_lease_acquired",
        {
            "host_id": host,
            "pid": own_pid,
            "lease_expires_at": fresh.lease_expires_at,
            "predecessor_was_stale": existing is not None,
        },
    )
    return fresh


def release_lease(
    *,
    base_dir: str | Path,
    host_id: str | None = None,
    operator_approval_ref: str | None = None,
) -> dict[str, Any]:
    """Plan ARIA-V3 §2n — explicit operator release. Used when the
    operator wants to hand the lease over to a different host (e.g.
    decommissioning a developer laptop). Refuses if no lease exists.
    """
    host = host_id or _resolve_host_id()
    root = ensure_tools_dir(base_dir)
    existing = _read_lease(root)
    if existing is None:
        raise GovernanceError("autonomous_host_lease_release_no_lease_present")
    if existing.host_id != host and not operator_approval_ref:
        raise GovernanceError(
            f"autonomous_host_lease_release_requires_approval_ref: "
            f"existing lease belongs to {existing.host_id!r} but "
            f"caller is {host!r}"
        )
    path = _lease_path(root)
    if path.exists():
        path.unlink()
    append_tools_governance(
        root,
        "autonomous_host_lease_released",
        {
            "host_id_released": existing.host_id,
            "released_by": host,
            "operator_approval_ref": operator_approval_ref,
        },
    )
    return {"status": "released"}


def lease_state(base_dir: str | Path) -> dict[str, Any]:
    """Plan ARIA-V3 §2n — diagnostic readout of the current lease.

    Returns ``{"state": "no_lease"}`` when absent, ``{"state":
    "stale", ...}`` when present-but-expired, or ``{"state":
    "fresh", ...}`` with the full HostLease fields.
    """
    existing = _read_lease(base_dir)
    if existing is None:
        return {"state": "no_lease"}
    if existing.is_fresh():
        return {
            "state": "fresh",
            "host_id": existing.host_id,
            "pid": existing.pid,
            "lease_acquired_at": existing.lease_acquired_at,
            "lease_expires_at": existing.lease_expires_at,
        }
    return {
        "state": "stale",
        "host_id": existing.host_id,
        "pid": existing.pid,
        "lease_acquired_at": existing.lease_acquired_at,
        "lease_expires_at": existing.lease_expires_at,
    }


__all__ = [
    "HostLease",
    "RemoteCasLease",
    "acquire_remote_cas_lease",
    "acquire_lease",
    "lease_state",
    "release_lease",
    "remote_cas_lease_state",
]
