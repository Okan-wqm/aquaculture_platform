"""Plan ARIA-V3 §A5 + §2i + AUDITTRAIL-CRITICAL-001/002 — ack ledger.

The autonomous-loop materialise gate (Phase A4) consumes one
``AckLedgerRow`` token per draft. Tokens are minted by either:

  * **operator** — explicit CLI invocation
    ``aria-kernel ack mint --draft-id X --reason Y --operator-approval-ref Z``
  * **autonomous_profile** — kernel auto-mint under the
    ``autonomous`` profile on the ``L3-snowball`` lane when the
    classifier+CI+review gates all pass (Phase B2).

Custody discipline (locked by I-V3-19c/d/e/f):

  * HMAC key lives at ``aria-tools/secrets/ack_hmac.key`` with
    ``chmod 0600``. Never committed; ``.gitignore`` covers the
    parent dir (Phase A2 ``.gitignore`` sweep) and I-V3-19c locks
    that.
  * Rolling key list — last 5 keys retained as ``{key_id, secret,
    minted_at, retired_at}`` records. Rotation appends a new key
    at index 0; old keys remain in the list for historical row
    verification (I-V3-19e).
  * DR runbook at ``docs/runbooks/aria-ack-key-rotation.md``
    (Phase A0 deliverable; I-V3-19f locks presence).

Append-only invariant (locked by I-V3-18):

  * Every mint writes one row to ``aria-tools/acks/acks.jsonl``
    using the declared ``ack_ledger`` append primitive (hash-chained
    per V2 §A.1).
  * Verification re-computes HMAC against the stored ``signature``
    using the row's ``signed_key_id`` resolved against the rolling
    key list.

One-time consumption (locked by I-V3-19):

  * ``consume_token(ack_id)`` rejects when ``consumed_at`` is
    already non-null. Returns the verified row to the caller
    (``materialize_*`` in Phase A4) so the materialise pipeline
    can link the row into its three-event audit chain
    (AUDITTRAIL-CRITICAL-003).
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import secrets
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .ack_row import ACK_ACTOR_KINDS, AckLedgerRow
from .ledger import append_declared_jsonl, load_declared_jsonl, state_transaction
from .tool_registry import GovernanceError, ensure_tools_dir

_LEDGER_RELATIVE = ("acks", "acks.jsonl")
_KEY_FILE_RELATIVE = ("secrets", "ack_hmac.key")
_MAX_ROLLING_KEYS: int = 5


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _ledger_path(base_dir: str | Path) -> Path:
    return Path(base_dir).joinpath(*_LEDGER_RELATIVE)


def _key_file_path(base_dir: str | Path) -> Path:
    return Path(base_dir).joinpath(*_KEY_FILE_RELATIVE)


_HASH_SUBJECT_EXCLUDE: frozenset[str] = frozenset({
    # Mutates post-mint (consume).
    "signature",
    "consumed_at",
    "consumed_by_event_id",
    # Plan ARIA-V2 §A.1 ledger hash chain — appended by
    # ``append_jsonl`` AFTER the HMAC subject is computed. Excluding
    # these keeps the HMAC stable across append (which mutates the
    # row) and rewrite_jsonl (which re-computes the chain). The
    # ledger's own integrity invariant covers the chain hashes
    # independently (V2 §A.1 verify_jsonl).
    "ledger_hash",
    "previous_ledger_hash",
})


def _canonical_row_bytes(row: dict[str, Any]) -> bytes:
    """Hash subject: every field EXCEPT signature + consumed-state +
    ledger chain hashes. Sorted JSON for determinism.
    """
    subject = {k: v for k, v in row.items() if k not in _HASH_SUBJECT_EXCLUDE}
    return json.dumps(subject, sort_keys=True, separators=(",", ":")).encode("utf-8")


def _hmac_sign(secret_b64: str, payload: bytes) -> str:
    secret = base64.b64decode(secret_b64.encode("ascii"))
    return hmac.new(secret, payload, hashlib.sha256).hexdigest()


def _atomic_write_secret(path: Path, content: str) -> None:
    """Plan ARIA-V3 §A5 — write the HMAC key file with 0600 perms
    via a temp-file + rename for atomicity. ``os.fchmod`` runs
    BEFORE the rename so the final file never exists with looser
    perms (even briefly).
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


def _load_keys(base_dir: str | Path) -> list[dict[str, Any]]:
    path = _key_file_path(base_dir)
    if not path.exists():
        return []
    data = json.loads(path.read_text(encoding="utf-8"))
    keys = data.get("keys")
    if not isinstance(keys, list):
        return []
    return keys


def _persist_keys(base_dir: str | Path, keys: list[dict[str, Any]]) -> None:
    path = _key_file_path(base_dir)
    payload = json.dumps(
        {"schema_version": 1, "keys": keys},
        sort_keys=True,
        indent=2,
    )
    _atomic_write_secret(path, payload)


def _resolve_key(
    base_dir: str | Path,
    *,
    key_id: str | None = None,
) -> dict[str, Any]:
    keys = _load_keys(base_dir)
    if not keys:
        raise GovernanceError(
            "hmac_key_missing: run `aria-kernel ack init` first "
            "(see docs/runbooks/aria-ack-key-rotation.md)"
        )
    if key_id is None:
        return keys[0]
    for entry in keys:
        if entry.get("key_id") == key_id:
            return entry
    raise GovernanceError(
        f"hmac_key_unknown: signed_key_id={key_id!r} not in rolling list"
    )


def init_ack_ledger(
    *,
    base_dir: str | Path,
    reason: str,
    operator_approval_ref: str,
    force: bool = False,
) -> dict[str, Any]:
    """Plan ARIA-V3 §A5 — mint the first HMAC key.

    ``--force`` allowed only when the key file is unreadable or
    explicitly re-initialising after DR (per runbook §4). The
    governance event marks ``dr_regenerated`` when forced.
    """
    root = ensure_tools_dir(base_dir)
    path = _key_file_path(root)
    existing_keys = _load_keys(root) if path.exists() else []
    if existing_keys and not force:
        raise GovernanceError(
            "ack_init_existing_key_present: pass --force to DR-regenerate "
            "(see docs/runbooks/aria-ack-key-rotation.md §4)"
        )
    new_key = {
        "key_id": str(uuid.uuid4()),
        "secret": base64.b64encode(secrets.token_bytes(32)).decode("ascii"),
        "minted_at": _utc_now(),
        "retired_at": None,
    }
    _persist_keys(root, [new_key])
    from .tool_registry import append_tools_governance
    append_tools_governance(
        root,
        "ack_key_dr_regenerated" if existing_keys else "ack_key_initialised",
        {
            "key_id": new_key["key_id"],
            "minted_at": new_key["minted_at"],
            "operator_approval_ref": operator_approval_ref,
            "reason": reason,
            "force": force,
        },
    )
    return {
        "status": "ok",
        "key_id": new_key["key_id"],
        "active_key_count": 1,
    }


def rotate_key(
    *,
    base_dir: str | Path,
    reason: str,
    operator_approval_ref: str,
    emergency: bool = False,
) -> dict[str, Any]:
    """Plan ARIA-V3 §A5 — append a new key at index 0; drop oldest
    if rolling list exceeds 5 entries.

    Emits ``ack_key_emergency_rotated`` when ``--emergency`` is set
    (distinct kind from scheduled ``ack_key_rotated`` so the
    incident timeline is reconstructable).
    """
    root = ensure_tools_dir(base_dir)
    keys = _load_keys(root)
    if not keys:
        raise GovernanceError(
            "ack_rotate_no_existing_key: run `aria-kernel ack init` first"
        )
    new_key = {
        "key_id": str(uuid.uuid4()),
        "secret": base64.b64encode(secrets.token_bytes(32)).decode("ascii"),
        "minted_at": _utc_now(),
        "retired_at": None,
    }
    # Mark previous head as retired (for historical verification).
    previous_head = dict(keys[0])
    previous_head["retired_at"] = _utc_now()
    rotated = [new_key, previous_head] + keys[1:]
    retired_keys = []
    if len(rotated) > _MAX_ROLLING_KEYS:
        retired_keys = [
            entry["key_id"] for entry in rotated[_MAX_ROLLING_KEYS:]
        ]
        rotated = rotated[:_MAX_ROLLING_KEYS]
    _persist_keys(root, rotated)
    from .tool_registry import append_tools_governance
    append_tools_governance(
        root,
        "ack_key_emergency_rotated" if emergency else "ack_key_rotated",
        {
            "old_key_id": previous_head["key_id"],
            "new_key_id": new_key["key_id"],
            "operator_approval_ref": operator_approval_ref,
            "reason": reason,
            "emergency": emergency,
            "retired_keys": retired_keys,
            "active_key_count": len(rotated),
        },
    )
    return {
        "status": "ok",
        "old_key_id": previous_head["key_id"],
        "new_key_id": new_key["key_id"],
        "retired_keys": retired_keys,
        "active_key_count": len(rotated),
    }


def list_keys(*, base_dir: str | Path) -> list[dict[str, Any]]:
    """Return the rolling key list with secrets REDACTED (so the
    CLI output is safe to share). Each entry retains ``key_id``,
    ``minted_at``, ``retired_at``.
    """
    keys = _load_keys(base_dir)
    return [
        {
            "key_id": k.get("key_id"),
            "minted_at": k.get("minted_at"),
            "retired_at": k.get("retired_at"),
        }
        for k in keys
    ]


def mint_operator_ack(
    *,
    base_dir: str | Path,
    draft_id: str,
    intent_id: str,
    target_path: str,
    kind: str,
    reason: str,
    operator_user_id: str,
    profile_name: str,
    profile_state_at_mint: str,
    commit_sha_at_mint: str,
    breaker_state_at_mint: str = "ok",
    parent_observation_id: str | None = None,
) -> AckLedgerRow:
    """Plan ARIA-V3 §A5 — operator-driven token mint.

    The ``reason`` field is validated by the CLI layer
    (``_validate_reason`` from Plan ARIA-V2 §AUDITTRAIL-HIGH-005a)
    BEFORE reaching this function. Here we just trust the string
    and persist.
    """
    if kind not in ("agent", "skill"):
        raise GovernanceError(f"ack_mint_unknown_kind: {kind!r}")
    root = ensure_tools_dir(base_dir)
    head_key = _resolve_key(root)
    ack_id = str(uuid.uuid4())
    event_time = _utc_now()
    row_dict: dict[str, Any] = {
        "schema_version": 1,
        "ack_id": ack_id,
        "event_time": event_time,
        "actor_kind": "operator",
        "actor_user_id": operator_user_id,
        "profile_name": profile_name,
        "lane": None,
        "classifier_decision_hash": None,
        "draft_id": draft_id,
        "intent_id": intent_id,
        "target_path": target_path,
        "kind": kind,
        "reason": reason,
        "auto_reason_code": None,
        "signed_key_id": head_key["key_id"],
        "consumed_at": None,
        "consumed_by_event_id": None,
        "breaker_state_at_mint": breaker_state_at_mint,
        "profile_state_at_mint": profile_state_at_mint,
        "commit_sha_at_mint": commit_sha_at_mint,
        "parent_observation_id": parent_observation_id,
    }
    row_dict["signature"] = _hmac_sign(
        head_key["secret"], _canonical_row_bytes(row_dict),
    )
    append_declared_jsonl(
        _ledger_path(root),
        row_dict,
        expected_surface="ack_ledger",
    )
    from .tool_registry import append_tools_governance
    append_tools_governance(
        root,
        "ack_token_minted",
        {
            "ack_id": ack_id,
            "actor_kind": "operator",
            "draft_id": draft_id,
            "intent_id": intent_id,
            "target_path": target_path,
            "kind": kind,
        },
    )
    return AckLedgerRow(
        ack_id=ack_id,
        event_time=event_time,
        actor_kind="operator",
        actor_user_id=operator_user_id,
        profile_name=profile_name,
        lane=None,
        classifier_decision_hash=None,
        draft_id=draft_id,
        intent_id=intent_id,
        target_path=target_path,
        kind=kind,
        reason=reason,
        auto_reason_code=None,
        signature=row_dict["signature"],
        signed_key_id=head_key["key_id"],
        consumed_at=None,
        consumed_by_event_id=None,
        breaker_state_at_mint=breaker_state_at_mint,
        profile_state_at_mint=profile_state_at_mint,
        commit_sha_at_mint=commit_sha_at_mint,
        parent_observation_id=parent_observation_id,
    )


def mint_auto_ack(
    *,
    base_dir: str | Path,
    draft_id: str,
    intent_id: str,
    target_path: str,
    kind: str,
    profile_name: str,
    lane: str,
    classifier_decision_hash: str,
    auto_reason_code: str,
    profile_state_at_mint: str,
    commit_sha_at_mint: str,
    breaker_state_at_mint: str = "ok",
    parent_observation_id: str | None = None,
) -> AckLedgerRow:
    """Plan ARIA-V3 §B2 — autonomous-profile auto-mint.

    Called by ``auto_action_gate`` (Phase A4) when profile ==
    ``autonomous`` AND lane == ``L3-snowball`` AND classifier
    passes AND breaker == ok. The auto-mint records its
    classifier-decision hash so the audit trail can replay the
    decision inputs (AUDITTRAIL-HIGH-007 closure).
    """
    if kind not in ("agent", "skill"):
        raise GovernanceError(f"ack_mint_unknown_kind: {kind!r}")
    root = ensure_tools_dir(base_dir)
    head_key = _resolve_key(root)
    ack_id = str(uuid.uuid4())
    event_time = _utc_now()
    row_dict: dict[str, Any] = {
        "schema_version": 1,
        "ack_id": ack_id,
        "event_time": event_time,
        "actor_kind": "autonomous_profile",
        "actor_user_id": None,
        "profile_name": profile_name,
        "lane": lane,
        "classifier_decision_hash": classifier_decision_hash,
        "draft_id": draft_id,
        "intent_id": intent_id,
        "target_path": target_path,
        "kind": kind,
        "reason": None,
        "auto_reason_code": auto_reason_code,
        "signed_key_id": head_key["key_id"],
        "consumed_at": None,
        "consumed_by_event_id": None,
        "breaker_state_at_mint": breaker_state_at_mint,
        "profile_state_at_mint": profile_state_at_mint,
        "commit_sha_at_mint": commit_sha_at_mint,
        "parent_observation_id": parent_observation_id,
    }
    row_dict["signature"] = _hmac_sign(
        head_key["secret"], _canonical_row_bytes(row_dict),
    )
    append_declared_jsonl(
        _ledger_path(root),
        row_dict,
        expected_surface="ack_ledger",
    )
    from .tool_registry import append_tools_governance
    append_tools_governance(
        root,
        "ack_token_minted",
        {
            "ack_id": ack_id,
            "actor_kind": "autonomous_profile",
            "draft_id": draft_id,
            "intent_id": intent_id,
            "target_path": target_path,
            "kind": kind,
            "lane": lane,
            "auto_reason_code": auto_reason_code,
        },
    )
    return AckLedgerRow(
        ack_id=ack_id,
        event_time=event_time,
        actor_kind="autonomous_profile",
        actor_user_id=None,
        profile_name=profile_name,
        lane=lane,
        classifier_decision_hash=classifier_decision_hash,
        draft_id=draft_id,
        intent_id=intent_id,
        target_path=target_path,
        kind=kind,
        reason=None,
        auto_reason_code=auto_reason_code,
        signature=row_dict["signature"],
        signed_key_id=head_key["key_id"],
        consumed_at=None,
        consumed_by_event_id=None,
        breaker_state_at_mint=breaker_state_at_mint,
        profile_state_at_mint=profile_state_at_mint,
        commit_sha_at_mint=commit_sha_at_mint,
        parent_observation_id=parent_observation_id,
    )


def consume_token(
    *,
    base_dir: str | Path,
    ack_id: str,
    materialize_event_id: str,
) -> dict[str, Any]:
    """Plan ARIA-V3 §A5 + I-V3-19 — one-time append-only consumption."""
    root = ensure_tools_dir(base_dir)
    path = _ledger_path(root)
    with state_transaction([path]) as txn:
        rows = txn.load_declared_jsonl(path, expected_surface="ack_ledger")
        target_row: dict[str, Any] | None = None
        consumed_event: dict[str, Any] | None = None
        for row in rows:
            if row.get("ack_id") != ack_id:
                continue
            if row.get("event") == "ack_token_consumed":
                consumed_event = row
            elif target_row is None:
                target_row = dict(row)
            if row.get("consumed_at") is not None:
                consumed_event = row
        if target_row is None:
            raise GovernanceError(f"ack_token_not_found: ack_id={ack_id!r}")
        if consumed_event is not None:
            raise GovernanceError(
                f"ack_token_already_consumed: ack_id={ack_id!r} "
                f"consumed_at={consumed_event.get('consumed_at')} "
                f"by={consumed_event.get('consumed_by_event_id') or consumed_event.get('materialize_event_id')!r}"
            )
        verification = verify_row(target_row, base_dir=root)
        if not verification.get("valid"):
            raise GovernanceError(
                f"ack_token_signature_invalid: ack_id={ack_id!r} "
                f"reason={verification.get('reason')}"
            )
        consumed_at = _utc_now()
        consumed_row = {
            "schema_version": 1,
            "event": "ack_token_consumed",
            "ack_id": ack_id,
            "event_time": consumed_at,
            "consumed_at": consumed_at,
            "consumed_by_event_id": materialize_event_id,
            "materialize_event_id": materialize_event_id,
            "target_path": target_row.get("target_path"),
            "draft_id": target_row.get("draft_id"),
            "intent_id": target_row.get("intent_id"),
            "kind": target_row.get("kind"),
            "signed_key_id": target_row.get("signed_key_id"),
        }
        key = _resolve_key(root, key_id=str(target_row["signed_key_id"]))
        consumed_row["signature"] = _hmac_sign(
            key["secret"], _canonical_row_bytes(consumed_row),
        )
        txn.append_declared_jsonl(
            path,
            consumed_row,
            expected_surface="ack_ledger",
        )
    from .tool_registry import append_tools_governance
    append_tools_governance(
        root,
        "ack_token_consumed",
        {
            "ack_id": ack_id,
            "materialize_event_id": materialize_event_id,
            "consumed_at": consumed_row["consumed_at"],
        },
    )
    return {
        "status": "ok",
        "ack_id": ack_id,
        "consumed_at": consumed_row["consumed_at"],
        "row": {**target_row, **consumed_row},
    }


def verify_row(
    row: dict[str, Any],
    *,
    base_dir: str | Path,
) -> dict[str, Any]:
    """Plan ARIA-V3 §A5 — recompute HMAC against the row's
    ``signed_key_id``. Returns ``{"valid": bool, "reason": str|None}``.
    """
    signed_key_id = row.get("signed_key_id")
    if not signed_key_id:
        return {"valid": False, "reason": "missing_signed_key_id"}
    try:
        key = _resolve_key(base_dir, key_id=signed_key_id)
    except GovernanceError as exc:
        return {"valid": False, "reason": str(exc)}
    expected = _hmac_sign(key["secret"], _canonical_row_bytes(row))
    actual = row.get("signature") or ""
    return {
        "valid": hmac.compare_digest(expected, actual),
        "reason": None if hmac.compare_digest(expected, actual) else "signature_mismatch",
    }


def verify_range(
    *,
    base_dir: str | Path,
    last_n: int | None = None,
) -> dict[str, Any]:
    """Plan ARIA-V3 §A5 — verify the last N ledger rows.

    Returns a structured result the CLI can pretty-print. ``last_n``
    None means full ledger.
    """
    root = ensure_tools_dir(base_dir)
    rows = load_declared_jsonl(_ledger_path(root), expected_surface="ack_ledger")
    if last_n is not None:
        rows = rows[-last_n:]
    results: list[dict[str, Any]] = []
    for row in rows:
        outcome = verify_row(row, base_dir=root)
        results.append({
            "ack_id": row.get("ack_id"),
            "valid": outcome["valid"],
            "reason": outcome["reason"],
            "signed_key_id": row.get("signed_key_id"),
            "actor_kind": row.get("actor_kind"),
        })
    return {
        "status": "ok",
        "rows_checked": len(rows),
        "invalid_count": sum(1 for r in results if not r["valid"]),
        "results": results,
    }


__all__ = [
    "consume_token",
    "init_ack_ledger",
    "list_keys",
    "mint_auto_ack",
    "mint_operator_ack",
    "rotate_key",
    "verify_range",
    "verify_row",
]
