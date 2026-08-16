"""Binding a restored tools root to this host is not a migration.

``ORPHAN-HIGH-556``. A tree checked out from ``aria/state`` carries every
covered ledger and no ``repo_identity.json`` — that file records
``bound_repo_root``, an absolute path on the host that wrote it, so the shared
branch deliberately does not carry it. What the restored tree needs is a
BINDING: mint this host's identity for a tree that is already at the current
contract.

What it got instead was a MIGRATION. ``tools_contract_version`` read only the
host-local identity file, so an absent identity reported version 0, and
``migrate_tools_bootstrap`` dutifully ran the whole v0→v2→v3 chain on a
healthy v3 tree. Measured on the real restore path, every night:

* a full copy of the tools tree into ``.backups/migration-v0-to-v2-<ts>``;
* a rewrite of every covered ledger;
* nine migration-ceremony rows in ``governance.jsonl``.

TWO OPERATIONS SHARING ONE CODE PATH, because the tree could not say what it
already was. The root fix is therefore not a special case in the migration —
it is giving the tree a voice: ``tools_contract.json`` is a declared surface
carrying the contract version and the environment-independent canonical
identity, so it publishes with the tree, and a restored tree reports v3.

THE REWRITE WAS HAPPENING WHERE NOTHING COULD SEE IT, which is worse than the
cost. ``migration`` passes ``allow_legacy=True`` with a reason and an expiry,
which reads as an audited, time-boxed permit. It is neither: the enterprise
declared-surface check only fires when ``surface_for_path`` resolves, and
resolution requires ``repo_identity.json`` — the very file that does not exist
yet. Measured, the allowance is consulted ZERO times during a restore-time
bind. So ARIA rewrote every covered ledger of its hash-chained memory inside
the one window where its own guard was structurally blind.

This module closes that by removing the rewrite from the window, not by
widening what the guard can see before the bind — the second would be the
workaround. On the nightly path nothing is rewritten at all, and the single
governance row is written AFTER the identity exists, so it goes through the
governed appender with the gate live.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from .migration import _resolve_repo_root, migrate_tools_bootstrap, tools_lock
from .tool_registry import (
    GovernanceError,
    SCHEMA_VERSION as TOOLS_SCHEMA_VERSION,
    TOOLS_CONTRACT_FILENAME,
    append_tools_governance,
    sync_tools_contract,
    tools_contract_version,
    update_tools_index,
)
from .workspace import canonical_identity, default_actor, repo_hash


def bind_tools_root(
    *,
    tools_dir: str | Path,
    workspace_root: str | Path,
    reason: str,
) -> dict[str, Any]:
    """Bind a tools root to this host, migrating only when one is required.

    No ``acknowledge`` flag. The restore action passed one on every nightly
    run, which is an acknowledgement that acknowledges nothing — the operator
    was not there. It is still required on the delegated migration below,
    where a tree genuinely is about to be rewritten, and that delegation is
    recorded rather than silent.
    """
    if not reason.strip():
        raise ValueError("tools binding requires a reason")
    root = Path(tools_dir)
    # Frozen-profile guard at the entry point, not at the first write. Without
    # it a frozen bind would write `repo_identity.json` and only then be
    # refused at the governance row, leaving a partial write behind — the same
    # reason `migrate_tools_bootstrap` guards at its umbrella.
    from .runtime_profile import enforce_profile_for_write

    enforce_profile_for_write("tool_governance", base_dir=str(root))
    repo_root = _resolve_repo_root(workspace_root)
    expected_identity = canonical_identity(repo_root)

    if not root.exists() or not (root / TOOLS_CONTRACT_FILENAME).exists():
        # A tree published before the contract surface existed, or a genesis
        # store with nothing in it at all. Both need the migration chain, and
        # the chain now writes the contract file — so this branch is taken at
        # most once per store and the transition needs no flag day.
        return _delegate_to_migration(
            root,
            workspace_root=workspace_root,
            reason=reason,
            trigger="contract_absent",
            expected_identity=expected_identity,
        )

    _assert_store_belongs_to_this_repository(root, expected_identity)

    # BIND FIRST, ALWAYS — then migrate the bound tree if it is behind.
    #
    # The order is the finding's own lesson applied to the leftover case. A
    # migration is an operation ON a bound tree: `migrate_tools_v2_to_v3`
    # refuses outright without `repo_identity.json`, and the only reason that
    # ever worked was that the v0 path happened to mint one on the way past.
    # Binding first makes that precondition true by construction instead of by
    # accident, and it keeps the two operations separate rather than relying on
    # one to do the other's job — which is the whole finding.
    version = tools_contract_version(root)
    bound = _mint_host_identity(
        root,
        repo_root=repo_root,
        expected_identity=expected_identity,
        reason=reason,
        version=version,
    )
    if version < TOOLS_SCHEMA_VERSION:
        return _delegate_to_migration(
            root,
            workspace_root=workspace_root,
            reason=reason,
            trigger="contract_below_target",
            expected_identity=expected_identity,
        )
    return bound


def _mint_host_identity(
    root: Path,
    *,
    repo_root: Path,
    expected_identity: str,
    reason: str,
    version: int,
) -> dict[str, Any]:
    """The nightly path: write the host's half, record it, touch nothing else."""
    with tools_lock(root, "tools_binding", repo_hash(repo_root)):
        # IDENTITY FIRST, then the ledger row. The order is load-bearing: the
        # declared-surface gate cannot resolve a tools root without
        # `repo_identity.json`, so a governance row written before this line
        # would take the raw appender with the gate inert — the same blind
        # window this finding is about, reopened one row wide.
        _atomic_write_json(
            root / "repo_identity.json",
            {
                "aria_tools_contract_version": version,
                "schema_version": version,
                "bound_canonical_identity": expected_identity,
                "bound_repo_hash": expected_identity,  # legacy mirror
                "bound_repo_root": str(repo_root),
            },
        )
        sync_tools_contract(root)
        event = append_tools_governance(
            root,
            "tools_root_bound_to_host",
            {
                "reason": reason,
                "acknowledged_by": default_actor(),
                "bound_canonical_identity": expected_identity,
                "bound_repo_root": str(repo_root),
                "contract_version": version,
            },
        )
        update_tools_index(root)
    return {
        "schema_version": TOOLS_SCHEMA_VERSION,
        "operation": "bind",
        "status": "bound",
        "contract_version": version,
        "migrated": False,
        "bound_canonical_identity": expected_identity,
        "governance_event_id": event.get("event_id"),
    }


def _delegate_to_migration(
    root: Path,
    *,
    workspace_root: str | Path,
    reason: str,
    trigger: str,
    expected_identity: str,
) -> dict[str, Any]:
    result = migrate_tools_bootstrap(
        tools_dir=str(root),
        workspace_root=workspace_root,
        acknowledge=True,
        reason=f"{reason} (migration required: {trigger})",
    )
    # Recorded rather than silent: a bind that turned into a migration rewrote
    # ledgers, and an operator reading the ledger must be able to see WHY
    # without inferring it from the ceremony rows around it.
    append_tools_governance(
        root,
        "tools_root_bind_required_migration",
        {
            "reason": reason,
            "trigger": trigger,
            "acknowledged_by": default_actor(),
            "starting_version": result.get("starting_version"),
            "final_version": result.get("final_version"),
        },
    )
    return {
        "schema_version": TOOLS_SCHEMA_VERSION,
        "operation": "bind",
        "status": "bound_via_migration",
        "contract_version": result.get("final_version"),
        "migrated": True,
        "migration_trigger": trigger,
        "bound_canonical_identity": expected_identity,
        "migration": result,
    }


def _assert_store_belongs_to_this_repository(root: Path, expected_identity: str) -> None:
    """A store published for another repository is refused, not adopted.

    Before the split there was nothing to check against: the migration simply
    rebound whatever tree it was pointed at to whatever repository it ran in.
    The published identity makes the mismatch VISIBLE, so it becomes a refusal
    rather than a silent adoption of another repository's memory.
    """
    try:
        contract = json.loads((root / TOOLS_CONTRACT_FILENAME).read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        raise GovernanceError(f"tools_contract_unreadable: {root.as_posix()}: {exc}") from exc
    if not isinstance(contract, dict):
        raise GovernanceError("tools_contract_malformed")
    published = contract.get("bound_canonical_identity")
    if published in (None, ""):
        # Written by a bootstrap that had no repository to bind to yet. There
        # is nothing to disagree with, so there is nothing to refuse.
        return
    if published != expected_identity:
        raise GovernanceError(
            "tools_root_foreign_store: the restored store was published for "
            f"canonical identity {published!r} but this checkout is "
            f"{expected_identity!r}; binding would adopt another repository's "
            "memory as this one's"
        )


def _atomic_write_json(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f".{path.name}.tmp")
    tmp.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    tmp.replace(path)


__all__ = ["bind_tools_root"]
