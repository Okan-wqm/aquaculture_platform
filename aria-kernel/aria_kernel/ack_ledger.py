"""Plan ARIA-V3 §A5 + §2i + AUDITTRAIL-CRITICAL-001/002 — ack ledger.

The autonomous-loop materialise gate (Phase A4) consumes one
``AckLedgerRow`` token per draft. Tokens are minted by either:

  * **operator** — explicit CLI invocation
    ``aria-kernel ack mint --draft-id X --kind agent --reason Y
    --body-sha256 D``; the ack's scope (``ack_row.AckScope``: draft,
    intent, target path, kind, body digest) is derived from the draft
    ledger, never passed in, and ``D`` — the digest ``aria-kernel ack
    scope`` printed with the body the operator read — must equal the
    derived body digest (ARIA-MEDIUM-512).
  * **autonomous_profile** — reserved primitive for a future executable
    lane contract (``record_autonomous_ack``: minted and consumed in one
    transaction). Current mainline authority derives no live auto-ack
    lane, so production materialization consumes operator-minted tokens.

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
    using ``ledger.append_jsonl`` (hash-chained per V2 §A.1).
  * Verification re-computes HMAC against the stored ``signature``
    using the row's ``signed_key_id`` resolved against the rolling
    key list.

One-time, scoped consumption (locked by I-V3-19 and
``tests/test_operator_ack_signature.py``, ARIA-MEDIUM-254 slice A):

  * ``consume_token(ack_id, scope)`` rejects a non-operator row, a row
    minted before scope binding, a row whose scope differs from the
    materialization's, and a row a legacy ``consumed_at`` value or a newer
    ``event=consumed`` transition already spent. It appends an
    ``aria/ack-consumption/v1`` transition row instead of rewriting the
    mint row, then returns a compatibility view to the caller
    (``materialize_*`` in Phase A4).
"""

from __future__ import annotations

import hmac
import uuid
from dataclasses import asdict
from pathlib import Path
from typing import Any

from .ack_row import ACK_ACTOR_KINDS, AckLedgerRow, AckScope
from .hmac_keyring import (
    HmacKeyring,
    hmac_sign as _hmac_sign,
    mint_key_entry as _mint_key_entry,
    utc_now_stamp as _utc_now,
)
from .ledger import append_declared_jsonl, canonical_json, load_declared_jsonl, state_transaction
from .tool_registry import GovernanceError, ensure_tools_dir

_LEDGER_RELATIVE = ("acks", "acks.jsonl")
_KEY_FILE_RELATIVE = ("secrets", "ack_hmac.key")


def _ledger_path(base_dir: str | Path) -> Path:
    return Path(base_dir).joinpath(*_LEDGER_RELATIVE)


def _key_file_path(base_dir: str | Path) -> Path:
    return Path(base_dir).joinpath(*_KEY_FILE_RELATIVE)


def _keyring(base_dir: str | Path) -> HmacKeyring:
    """The ack key file bound to the shared custody primitive.

    WHY: the 0600 atomic write, the rolling list and the key_id lookup
    used to live here as private helpers; ``hmac_keyring`` is now the
    single owner (operator-feedback signing shares it), and this module
    keeps only the ack-specific lifecycle — the operator init/rotate
    ceremony and its governance rows.
    """
    return HmacKeyring(path=_key_file_path(base_dir), purpose="ack")


_HASH_SUBJECT_BASE_EXCLUDE: frozenset[str] = frozenset({
    "signature",
    "ledger_hash",
    "previous_ledger_hash",
})


def _canonical_row_bytes(row: dict[str, Any]) -> bytes:
    """Return the signed HMAC subject for mint or transition rows.

    Legacy mint rows excluded ``consumed_at`` and
    ``consumed_by_event_id`` because consumption used to rewrite the
    mint row in place. New append-only consumption rows bind those
    fields into the signature because they are immutable transition
    data. The encoding is ``ledger.canonical_json``, the kernel's one
    canonicalizer, so the HMAC subject cannot drift from the ledger's
    hash contract.
    """
    exclude = set(_HASH_SUBJECT_BASE_EXCLUDE)
    if row.get("event") != "consumed":
        exclude.update({"consumed_at", "consumed_by_event_id"})
    subject = {k: v for k, v in row.items() if k not in exclude}
    return canonical_json(subject).encode("utf-8")


def _load_keys(base_dir: str | Path) -> list[dict[str, Any]]:
    return _keyring(base_dir).load()


def _persist_keys(base_dir: str | Path, keys: list[dict[str, Any]]) -> None:
    _keyring(base_dir).persist(keys)


def _resolve_key(
    base_dir: str | Path,
    *,
    key_id: str | None = None,
) -> dict[str, Any]:
    try:
        return _keyring(base_dir).resolve(key_id=key_id)
    except GovernanceError as exc:
        # The ack key is operator-minted, so a miss carries the ceremony
        # pointer the shared primitive cannot know about.
        if str(exc).startswith("hmac_key_missing"):
            raise GovernanceError(
                "hmac_key_missing: run `aria-kernel ack init` first "
                "(see docs/runbooks/aria-ack-key-rotation.md)"
            ) from exc
        raise GovernanceError(
            f"hmac_key_unknown: signed_key_id={key_id!r} not in rolling list"
        ) from exc


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
    new_key = _mint_key_entry()
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
    if not _load_keys(root):
        raise GovernanceError(
            "ack_rotate_no_existing_key: run `aria-kernel ack init` first"
        )
    # The shared primitive retires the previous head (historical rows stay
    # verifiable) and drops anything past the five-entry window.
    rotation = _keyring(root).rotate()
    new_key = rotation["new_key"]
    previous_head = rotation["previous_head"]
    retired_keys = rotation["retired_keys"]
    rotated = rotation["keys"]
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
    return _keyring(base_dir).redacted()


def _review_for_draft(kind: str, draft_id: str, base_dir: str | Path) -> tuple[AckScope, str]:
    """The scope an ack for ``draft_id`` authorizes and the body it digests, from the materializer's own function.

    WHY: the mint used to take ``intent_id`` and ``target_path`` from its
    caller, so a mint could name a subject the draft does not have, and the
    consumer compared none of it. The same per-kind function materialize
    derives its scope with derives it here, over the same draft ledger.
    """
    if kind == "agent":
        from .agent_genesis import ack_review_for_draft
    elif kind == "skill":
        from .skill_genesis import ack_review_for_draft
    else:
        raise GovernanceError(f"ack_mint_unknown_kind: {kind!r}")
    return ack_review_for_draft(draft_id, base_dir)


def review_draft(*, base_dir: str | Path, draft_id: str, kind: str) -> dict[str, Any]:
    """ARIA-MEDIUM-512 — what the operator reads before ``ack mint``: the draft's body and the scope that digests it.

    ``scope.body_sha256`` is the value ``ack mint --body-sha256`` names; the
    mint refuses any other, so the ack authorizes the body printed here.
    Read-only.
    """
    scope, body = _review_for_draft(kind, draft_id, ensure_tools_dir(base_dir))
    return {"scope": asdict(scope), "body": body}


def _signed_mint_row(
    *,
    root: Path,
    scope: AckScope,
    actor_kind: str,
    actor_user_id: str | None,
    profile_name: str,
    lane: str | None,
    classifier_decision_hash: str | None,
    reason: str | None,
    auto_reason_code: str | None,
    profile_state_at_mint: str,
    commit_sha_at_mint: str,
    breaker_state_at_mint: str,
    parent_observation_id: str | None,
) -> tuple[dict[str, Any], AckLedgerRow]:
    """The one mint-row body for both actor kinds, signed and not yet written.

    Only the actor-conditional values differ between an operator and an
    autonomous mint, so the row is built and signed here once. The returned
    dataclass is built from the signed dict itself BEFORE anything is
    written, so a row key the dataclass does not declare is a TypeError at
    mint — refusing it with no signed, consumable token already on the
    ledger — instead of a silent schema widening.
    """
    if scope.kind not in ("agent", "skill"):
        raise GovernanceError(f"ack_mint_unknown_kind: {scope.kind!r}")
    head_key = _resolve_key(root)
    row_dict: dict[str, Any] = {
        "schema_version": 1,
        "ack_id": str(uuid.uuid4()),
        "event_time": _utc_now(),
        "actor_kind": actor_kind,
        "actor_user_id": actor_user_id,
        "profile_name": profile_name,
        "lane": lane,
        "classifier_decision_hash": classifier_decision_hash,
        "draft_id": scope.draft_id,
        "intent_id": scope.intent_id,
        "target_path": scope.target_path,
        "kind": scope.kind,
        "body_sha256": scope.body_sha256,
        "reason": reason,
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
    return row_dict, AckLedgerRow(**row_dict)


def _announce_mint(root: Path, row: AckLedgerRow, extra: dict[str, Any] | None) -> None:
    from .tool_registry import append_tools_governance
    append_tools_governance(
        root,
        "ack_token_minted",
        {
            "ack_id": row.ack_id,
            "actor_kind": row.actor_kind,
            "draft_id": row.draft_id,
            "intent_id": row.intent_id,
            "target_path": row.target_path,
            "kind": row.kind,
            "body_sha256": row.body_sha256,
            **(extra or {}),
        },
    )


def mint_operator_ack(
    *,
    base_dir: str | Path,
    draft_id: str,
    kind: str,
    reason: str,
    operator_user_id: str,
    profile_name: str,
    profile_state_at_mint: str,
    commit_sha_at_mint: str,
    reviewed_body_sha256: str,
    breaker_state_at_mint: str = "ok",
    parent_observation_id: str | None = None,
) -> AckLedgerRow:
    """Plan ARIA-V3 §A5 — operator-driven token mint, scoped to the body the operator reviewed.

    The scope (draft, intent, target path, kind, body digest) is derived from
    the draft ledger (:func:`_review_for_draft`), never taken from the caller.
    ``reviewed_body_sha256`` is the digest :func:`review_draft` printed with
    the body the operator read (ARIA-MEDIUM-512): when the draft's latest
    body is another one — re-drafted between the review and the mint — the
    mint refuses ``ack_mint_body_not_reviewed`` and writes nothing, so an ack
    never authorizes a body its operator did not read.

    The ``reason`` field is validated by the CLI layer
    (``_validate_reason`` from Plan ARIA-V2 §AUDITTRAIL-HIGH-005a)
    BEFORE reaching this function. Here we just trust the string
    and persist.
    """
    root = ensure_tools_dir(base_dir)
    scope, _body = _review_for_draft(kind, draft_id, root)
    reviewed = str(reviewed_body_sha256 or "").strip().lower()
    if reviewed != scope.body_sha256:
        raise GovernanceError(
            f"ack_mint_body_not_reviewed: draft {draft_id!r} holds body sha256 "
            f"{scope.body_sha256}, not the reviewed {reviewed or '<none>'}; read it with "
            f"`aria-kernel ack scope --draft-id {draft_id} --kind {kind}` and mint for that body"
        )
    row_dict, row = _signed_mint_row(
        root=root,
        scope=scope,
        actor_kind="operator",
        actor_user_id=operator_user_id,
        profile_name=profile_name,
        lane=None,
        classifier_decision_hash=None,
        reason=reason,
        auto_reason_code=None,
        profile_state_at_mint=profile_state_at_mint,
        commit_sha_at_mint=commit_sha_at_mint,
        breaker_state_at_mint=breaker_state_at_mint,
        parent_observation_id=parent_observation_id,
    )
    append_declared_jsonl(_ledger_path(root), row_dict, expected_surface="ack_ledger")
    _announce_mint(root, row, None)
    return row


def _signed_consumption_row(
    target_row: dict[str, Any],
    *,
    root: Path,
    consumed_at: str,
    materialize_event_id: str,
) -> dict[str, Any]:
    """The ``aria/ack-consumption/v1`` transition for ``target_row``, signed with the mint row's key."""
    key = _resolve_key(root, key_id=str(target_row["signed_key_id"]))
    transition_row: dict[str, Any] = {
        "$schema": "aria/ack-consumption/v1",
        "schema_version": 1,
        "event": "consumed",
        "ack_id": target_row["ack_id"],
        "consumed_at": consumed_at,
        "consumed_by_event_id": materialize_event_id,
        "signed_key_id": target_row["signed_key_id"],
        "parent_ack_ledger_hash": target_row.get("ledger_hash"),
        "draft_id": target_row.get("draft_id"),
        "intent_id": target_row.get("intent_id"),
        "target_path": target_row.get("target_path"),
    }
    transition_row["signature"] = _hmac_sign(
        key["secret"], _canonical_row_bytes(transition_row),
    )
    return transition_row


def _announce_consumption(
    root: Path,
    target_row: dict[str, Any],
    persisted_transition: dict[str, Any],
) -> dict[str, Any]:
    """Record ``ack_token_consumed`` and return the consume-shaped result both paths share."""
    from .tool_registry import append_tools_governance
    ack_id = str(target_row["ack_id"])
    consumed_at = persisted_transition["consumed_at"]
    materialize_event_id = persisted_transition["consumed_by_event_id"]
    append_tools_governance(
        root,
        "ack_token_consumed",
        {
            "ack_id": ack_id,
            "materialize_event_id": materialize_event_id,
            "consumed_at": consumed_at,
            "consumption_ledger_hash": persisted_transition.get("ledger_hash"),
        },
    )
    compatible_row = dict(target_row)
    compatible_row["consumed_at"] = consumed_at
    compatible_row["consumed_by_event_id"] = materialize_event_id
    return {
        "status": "ok",
        "ack_id": ack_id,
        "consumed_at": consumed_at,
        "row": compatible_row,
        "consumption_row": persisted_transition,
    }


def record_autonomous_ack(
    *,
    base_dir: str | Path,
    scope: AckScope,
    materialize_event_id: str,
    profile_name: str,
    lane: str,
    classifier_decision_hash: str,
    auto_reason_code: str,
    profile_state_at_mint: str,
    commit_sha_at_mint: str,
    breaker_state_at_mint: str,
    parent_observation_id: str | None = None,
) -> dict[str, Any]:
    """Plan ARIA-V3 §B2 — an autonomous ack, minted AND consumed by one materialization.

    Reserved primitive for a future executable lane contract
    (``auto_action_gate.AUTONOMOUS_AUTO_ACK_LANES`` is empty, so no current
    lane reaches it). WHY one transaction: a separate autonomous mint left a
    signed, unconsumed row any operator-path consumer could spend by id
    (ARIA-MEDIUM-254 slice A). The mint row and its consumption row are
    appended under one ledger lock, so no autonomous row is ever consumable,
    and :func:`consume_token` refuses every non-operator row by id.
    """
    root = ensure_tools_dir(base_dir)
    row_dict, row = _signed_mint_row(
        root=root,
        scope=scope,
        actor_kind="autonomous_profile",
        actor_user_id=None,
        profile_name=profile_name,
        lane=lane,
        classifier_decision_hash=classifier_decision_hash,
        reason=None,
        auto_reason_code=auto_reason_code,
        profile_state_at_mint=profile_state_at_mint,
        commit_sha_at_mint=commit_sha_at_mint,
        breaker_state_at_mint=breaker_state_at_mint,
        parent_observation_id=parent_observation_id,
    )
    ledger_path = _ledger_path(root)
    with state_transaction([ledger_path]) as txn:
        persisted_mint = txn.append_declared_jsonl(ledger_path, row_dict, expected_surface="ack_ledger")
        persisted_transition = txn.append_declared_jsonl(
            ledger_path,
            _signed_consumption_row(persisted_mint, root=root, consumed_at=_utc_now(),
                                    materialize_event_id=materialize_event_id),
            expected_surface="ack_ledger",
        )
    _announce_mint(root, row, {"lane": lane, "auto_reason_code": auto_reason_code})
    return _announce_consumption(root, persisted_mint, persisted_transition)


def consume_token(
    *,
    base_dir: str | Path,
    ack_id: str,
    materialize_event_id: str,
    scope: AckScope,
) -> dict[str, Any]:
    """Append an immutable consumption transition for the operator ack ``ack_id`` minted for ``scope``.

    Refused, in order, with nothing written: no such mint row
    (``ack_token_not_found``); a row that is not an operator's
    (``ack_token_not_operator_signed`` — an autonomous row is consumed by
    the materialization that minted it, never by id); a row minted before
    scope binding (``ack_token_scope_unbound``: it carries no
    ``body_sha256``, so it cannot say which body it authorized — the
    operator re-mints); a row that binds another scope
    (``ack_token_scope_mismatch:<field>``); a consumed row
    (``ack_token_already_consumed``); a row whose signature does not verify.

    Compatibility rule: pre-2026-05-26 rows that were rewritten with
    ``consumed_at`` populated still read as consumed. New consumption
    never rewrites the mint row; it appends ``event="consumed"`` signed
    with the same key as the mint row.
    """
    root = ensure_tools_dir(base_dir)
    ledger_path = _ledger_path(root)
    with state_transaction([ledger_path]) as txn:
        rows = txn.load_declared_jsonl(
            ledger_path,
            expected_surface="ack_ledger",
        )
        target_row: dict[str, Any] | None = None
        consumed_transition: dict[str, Any] | None = None
        for row in rows:
            if row.get("ack_id") != ack_id:
                continue
            if row.get("event") == "consumed" or row.get("$schema") == "aria/ack-consumption/v1":
                consumed_transition = row
                continue
            if row.get("actor_kind") in ACK_ACTOR_KINDS:
                target_row = row
        if target_row is None:
            raise GovernanceError(f"ack_token_not_found: ack_id={ack_id!r}")
        if target_row.get("actor_kind") != "operator":
            raise GovernanceError(
                f"ack_token_not_operator_signed: ack_id={ack_id!r} "
                f"actor_kind={target_row.get('actor_kind')!r}"
            )
        if "body_sha256" not in target_row:
            raise GovernanceError(
                f"ack_token_scope_unbound: ack_id={ack_id!r} was minted before "
                "scope binding; mint a new ack for the draft as it stands"
            )
        mismatched = scope.mismatched_field(target_row)
        if mismatched is not None:
            raise GovernanceError(
                f"ack_token_scope_mismatch:{mismatched}: ack_id={ack_id!r} "
                f"minted={target_row.get(mismatched)!r} "
                f"materializing={getattr(scope, mismatched)!r}"
            )
        if target_row.get("consumed_at") is not None or consumed_transition is not None:
            consumed_at = (
                consumed_transition or target_row
            ).get("consumed_at")
            consumed_by = (
                consumed_transition or target_row
            ).get("consumed_by_event_id")
            raise GovernanceError(
                f"ack_token_already_consumed: ack_id={ack_id!r} "
                f"consumed_at={consumed_at} by={consumed_by!r}"
            )
        verification = verify_row(target_row, base_dir=root)
        if not verification.get("valid"):
            raise GovernanceError(
                f"ack_token_signature_invalid: ack_id={ack_id!r} "
                f"reason={verification.get('reason')}"
            )
        persisted_transition = txn.append_declared_jsonl(
            ledger_path,
            _signed_consumption_row(target_row, root=root, consumed_at=_utc_now(),
                                    materialize_event_id=materialize_event_id),
            expected_surface="ack_ledger",
        )
    return _announce_consumption(root, target_row, persisted_transition)


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
    "mint_operator_ack",
    "record_autonomous_ack",
    "rotate_key",
    "verify_range",
    "verify_row",
]
