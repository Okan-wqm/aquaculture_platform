"""Plan ARIA-V3 §A5 + §2i + AUDITTRAIL-CRITICAL-001/002 — ack ledger.

The autonomous-loop materialise gate (Phase A4) consumes one
``AckLedgerRow`` token per draft. Tokens are minted by either:

  * **operator** — explicit CLI invocation
    ``aria-kernel ack mint --draft-id X --kind agent --reason Y
    --body-sha256 D --signing-key K --signer-principal P --actor-class T0``;
    the ack's scope (``ack_row.AckScope``: draft, intent, target path,
    kind, body digest) is derived from the draft ledger, never passed in,
    and ``D`` — the digest ``aria-kernel ack scope`` printed with the body
    the operator read — must equal the derived body digest
    (ARIA-MEDIUM-512). The row is signed with the OPERATOR's ed25519 key
    (ARIA-MEDIUM-254, below).
  * **autonomous_profile** — reserved primitive for a future executable
    lane contract (``record_autonomous_ack``: minted and consumed in one
    transaction). Current mainline authority derives no live auto-ack
    lane, so production materialization consumes operator-minted tokens.

Operator signature (ARIA-MEDIUM-254, ``tests/test_operator_ack_signature.py``):

  * An operator ack used to be HMAC-signed with a key under the store's
    untracked ``secrets/``. That directory is never published to aria/state
    and every self-hosted job sweeps it (``git clean -ffdx``) before the
    store is restored, so an ack minted in one job could never verify in a
    later one. An operator mint is now the operator's signed act: a subject
    of row kind ``operator_ack`` in the ``aria-operator-request`` namespace
    with the ADR-0023 terms (actor class, audience, expiry), signed with
    ``ssh-keygen`` and verified at consumption against the allowed-signers
    file committed on main (``operator_request_signature``). Nothing the
    kernel or the runner holds can mint one, and the verifier needs no
    secret, so any job with a checkout on main verifies it.
  * The consumption transition of an operator ack is the runner's record
    and carries no signature: it binds its mint row by
    ``parent_ack_ledger_hash`` on the hash-chained ledger, and
    :func:`verify_range` checks that binding.

Custody discipline for the remaining HMAC rows — autonomous mints and their
transitions, and operator rows minted before ARIA-MEDIUM-254 (locked by
I-V3-19c/d/e/f):

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
  * Verification of an HMAC row re-computes HMAC against the stored
    ``signature`` using the row's ``signed_key_id`` resolved against the
    rolling key list; an operator row is verified by ``ssh-keygen``.

One-time, scoped consumption (locked by I-V3-19 and
``tests/test_operator_ack_signature.py``, ARIA-MEDIUM-254 slice A):

  * ``consume_token(ack_id, scope, workspace_root)`` rejects a non-operator
    row, a row minted before scope binding, a row whose scope differs from
    the materialization's, a row a legacy ``consumed_at`` value or a newer
    ``event=consumed`` transition already spent, and a row that is not the
    operator's signed act or whose signature or terms the anchor at
    ``workspace_root`` refuses. It appends an
    ``aria/ack-consumption/v1`` transition row instead of rewriting the
    mint row, then returns a compatibility view to the caller
    (``materialize_*`` in Phase A4).
"""

from __future__ import annotations

import hmac
import sys
import uuid
from dataclasses import asdict
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, TextIO

from .ack_row import ACK_ACTOR_KINDS, ACK_ROW_SCHEMA_VERSION, OPERATOR_ACK_ROW_KIND, AckLedgerRow, AckScope
from .hmac_keyring import (
    HmacKeyring,
    hmac_sign as _hmac_sign,
    mint_key_entry as _mint_key_entry,
    utc_now_stamp as _utc_now,
)
from .ledger import append_declared_jsonl, canonical_json, load_declared_jsonl, state_transaction
from .operator_request_signature import (
    OPERATOR_ACTOR_CLASSES,
    SIGNATURE_NAMESPACE,
    AllowedSigners,
    allowed_signers_for_checkout,
    operator_act_terms_reason,
    refuse_untrusted_signing_environment,
    sign_operator_subject,
    verify_operator_signature,
)
from .operator_request_terms import utc_iso
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
        # ARIA-LOW-598 — a revoked key's row is unverifiable, not forged and
        # not unknown: the verdict names the revocation (runbook §3).
        if str(exc).startswith("hmac_key_revoked"):
            raise GovernanceError(f"signed_key_revoked: signed_key_id={key_id!r}") from exc
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
    # ARIA-HIGH-238 — the first HMAC key (or its DR regeneration) is the
    # root of every later ack signature, so the ref must be the operator's
    # own GitHub act naming the operation.
    from .operator_approval import require_operator_act

    approval = require_operator_act(
        operator_approval_ref,
        surface="ack_key_operation",
        scope={"operation": "dr_regenerate" if existing_keys else "init"},
        base_dir=root,
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
            "operator_approval": approval,
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
    # ARIA-HIGH-238 — rotation retires the key older acks were signed with;
    # the ref must be the operator's own GitHub act naming the operation.
    from .operator_approval import require_operator_act

    approval = require_operator_act(
        operator_approval_ref,
        surface="ack_key_operation",
        scope={"operation": "emergency_rotate" if emergency else "rotate"},
        base_dir=root,
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
            "operator_approval": approval,
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


def revoke_key(
    *,
    base_dir: str | Path,
    key_id: str,
    reason: str,
    operator_approval_ref: str,
) -> dict[str, Any]:
    """ARIA-LOW-598 — quarantine a compromised key (runbook §3, step 2).

    Rotation keeps the previous head in the rolling list so its rows stay
    verifiable — which, for a LEAKED key, is the problem: whoever holds it can
    forge rows that verify until it rolls off the five-entry window. This
    drops the key's secret from the file at once, keeps a revocation record,
    and writes an ``ack_key_revoked`` governance row. Every row it signed then
    verifies as ``signed_key_revoked`` — unverifiable, its content intact.
    The head key is refused: rotate first (``ack rotate-key --emergency``).
    """
    root = ensure_tools_dir(base_dir)
    if not _load_keys(root):
        raise GovernanceError(
            "ack_revoke_no_existing_key: run `aria-kernel ack init` first"
        )
    revocation = _keyring(root).revoke(key_id, reason=reason)
    record = revocation["revoked"]
    from .tool_registry import append_tools_governance
    append_tools_governance(
        root,
        "ack_key_revoked",
        {
            "key_id": key_id,
            "minted_at": record["minted_at"],
            "revoked_at": record["revoked_at"],
            "operator_approval_ref": operator_approval_ref,
            "reason": reason,
            "active_key_count": len(revocation["keys"]),
        },
    )
    return {
        "status": "ok",
        "revoked_key_id": key_id,
        "revoked_at": record["revoked_at"],
        "active_key_count": len(revocation["keys"]),
    }


def revoked_keys(*, base_dir: str | Path) -> list[dict[str, Any]]:
    """The revocation records (``key_id``, ``minted_at``, ``revoked_at``, ``reason``)."""
    return _keyring(base_dir).revoked()


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


# ARIA-MEDIUM-254 — refusal vocabulary of an operator ack's signature.
ACK_OPERATOR_SIGNATURE_REQUIRED = "operator_signature_required"
ACK_ANCHOR_UNBOUND = "anchor_unbound"


def _mint_row_body(
    *,
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
    signed_key_id: str | None,
    operator_terms: dict[str, str] | None,
) -> dict[str, Any]:
    """The one mint-row body for both actor kinds, not yet signed.

    Only the actor-conditional values differ between an operator and an
    autonomous mint, so the row is built here once; the caller signs it
    (operator: the operator's key; autonomous: the HMAC key) and checks it
    against the ``AckLedgerRow`` schema before anything is written.
    ``operator_terms`` carries the ADR-0023 terms of an operator mint
    (``actor_class``, ``audience``, ``expires_at``); ``signer_principal`` is
    stamped by the signer.
    """
    if scope.kind not in ("agent", "skill"):
        raise GovernanceError(f"ack_mint_unknown_kind: {scope.kind!r}")
    terms = operator_terms or {}
    return {
        "schema_version": ACK_ROW_SCHEMA_VERSION,
        "row_kind": OPERATOR_ACK_ROW_KIND if operator_terms is not None else None,
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
        "signed_key_id": signed_key_id,
        "consumed_at": None,
        "consumed_by_event_id": None,
        "breaker_state_at_mint": breaker_state_at_mint,
        "profile_state_at_mint": profile_state_at_mint,
        "commit_sha_at_mint": commit_sha_at_mint,
        "parent_observation_id": parent_observation_id,
        "actor_class": terms.get("actor_class"),
        "audience": terms.get("audience"),
        "expires_at": terms.get("expires_at"),
        "signer_principal": None,
    }


def _hmac_signed_mint_row(root: Path, **body: Any) -> tuple[dict[str, Any], AckLedgerRow]:
    """An autonomous mint row, HMAC-signed with the head key and checked against the schema, not yet written.

    The dataclass is built from the signed dict itself BEFORE anything is
    written, so a row key the dataclass does not declare is a TypeError at
    mint — refusing it with no signed, consumable token already on the
    ledger — instead of a silent schema widening.
    """
    head_key = _resolve_key(root)
    row_dict = _mint_row_body(**body, signed_key_id=head_key["key_id"], operator_terms=None)
    row_dict["signature"] = _hmac_sign(
        head_key["secret"], _canonical_row_bytes(row_dict),
    )
    return row_dict, AckLedgerRow(**row_dict)


def operator_ack_reason(row: dict[str, Any], anchor: AllowedSigners, *, now: datetime | None) -> str | None:
    """ARIA-MEDIUM-254 — why ``row`` is not an operator's signed ack under ``anchor``, or None.

    The row must be an ``operator_ack`` subject; with ``now`` its ADR-0023
    terms must hold (an admitted actor class, this repository's audience, an
    expiry inside the registry bound and not passed); and ``ssh-keygen``
    must verify its signature in the ``aria-operator-request`` namespace
    against the allowed-signers file committed at the anchor. ``now`` is
    None only for an audit of a historical row (:func:`verify_row`), which
    judges the signature alone.
    """
    if row.get("row_kind") != OPERATOR_ACK_ROW_KIND:
        return ACK_OPERATOR_SIGNATURE_REQUIRED
    if now is not None:
        reason = operator_act_terms_reason(
            row, entry=anchor.namespaces.get(SIGNATURE_NAMESPACE), audience=anchor.audience, now=now,
        )
        if reason is not None:
            return reason
    return verify_operator_signature(
        row, namespace=SIGNATURE_NAMESPACE, allowed_signers=anchor.content, namespaces=anchor.namespaces,
    ).reason


def _anchor_for(workspace_root: str | Path | None, root: Path) -> tuple[AllowedSigners | None, str | None]:
    """The allowed-signers anchor at ``workspace_root``'s commit proven on main, or ``(None, reason)``."""
    if workspace_root is None:
        return None, ACK_ANCHOR_UNBOUND
    return allowed_signers_for_checkout(workspace_root, base_dir=root)


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
    signing_key: str | Path,
    signer_principal: str,
    actor_class: str,
    workspace_root: str | Path,
    expires_in_hours: int | None = None,
    subject_stream: TextIO | None = None,
    breaker_state_at_mint: str = "ok",
    parent_observation_id: str | None = None,
) -> AckLedgerRow:
    """Plan ARIA-V3 §A5 — operator-driven token mint, scoped to the body the operator reviewed, signed by the operator.

    The scope (draft, intent, target path, kind, body digest) is derived from
    the draft ledger (:func:`_review_for_draft`), never taken from the caller.
    ``reviewed_body_sha256`` is the digest :func:`review_draft` printed with
    the body the operator read (ARIA-MEDIUM-512): when the draft's latest
    body is another one — re-drafted between the review and the mint — the
    mint refuses ``ack_mint_body_not_reviewed`` and writes nothing, so an ack
    never authorizes a body its operator did not read.

    ARIA-MEDIUM-254 — the row is the operator's signed act: ``ssh-keygen``
    signs it with ``signing_key`` (the operator's private key, or its public
    half with the key in ssh-agent; never read or stored) in the
    ``aria-operator-request`` namespace as an ``operator_ack`` subject with
    the ADR-0023 terms, the subject printed to ``subject_stream`` (stderr)
    first. ``workspace_root`` is a checkout on main: its committed
    allowed-signers file must verify the signature here, as consumption
    will, or nothing is written. As root, the signing environment must be
    root-only (ARIA-LOW-266). ``expires_in_hours`` defaults to, and may not
    exceed, the namespace's lifetime bound; consumption refuses after it.

    The ``reason`` field is validated by the CLI layer
    (``_validate_reason`` from Plan ARIA-V2 §AUDITTRAIL-HIGH-005a)
    BEFORE reaching this function. Here we just trust the string
    and persist.
    """
    refuse_untrusted_signing_environment(workspace_root, act="operator_ack")
    if actor_class not in OPERATOR_ACTOR_CLASSES:
        raise GovernanceError(f"ack_mint_actor_class_invalid: {actor_class!r}")
    root = ensure_tools_dir(base_dir)
    scope, _body = _review_for_draft(kind, draft_id, root)
    reviewed = str(reviewed_body_sha256 or "").strip().lower()
    if reviewed != scope.body_sha256:
        raise GovernanceError(
            f"ack_mint_body_not_reviewed: draft {draft_id!r} holds body sha256 "
            f"{scope.body_sha256}, not the reviewed {reviewed or '<none>'}; read it with "
            f"`aria-kernel ack scope --draft-id {draft_id} --kind {kind}` and mint for that body"
        )
    anchor, anchor_reason = _anchor_for(workspace_root, root)
    if anchor is None:
        raise GovernanceError(f"ack_mint_anchor_unavailable: {anchor_reason}")
    entry = anchor.namespaces[SIGNATURE_NAMESPACE]
    bound = int(entry.expiry_hours or 0)
    hours = bound if expires_in_hours is None else expires_in_hours
    if isinstance(hours, bool) or not 0 < hours <= bound:
        raise GovernanceError(f"ack_mint_expiry_out_of_range: {expires_in_hours!r}")
    now = datetime.now(timezone.utc).replace(microsecond=0)
    row_dict = _mint_row_body(
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
        signed_key_id=None,
        operator_terms={"actor_class": actor_class, "audience": anchor.audience,
                        "expires_at": utc_iso(now + timedelta(hours=hours))},
    )
    # The schema owner judges the row before the operator is asked to sign it.
    AckLedgerRow(**{**row_dict, "signature": "", "signer_principal": signer_principal})
    signed = sign_operator_subject(
        row_dict, namespace=entry.namespace, domain_tag=str(entry.domain_tag), signing_key=signing_key,
        signer_principal=signer_principal, subject_stream=subject_stream if subject_stream is not None else sys.stderr,
    )
    refused = operator_ack_reason(signed, anchor, now=now)
    if refused is not None:
        raise GovernanceError(f"ack_mint_signature_unverified: {refused}")
    row = AckLedgerRow(**signed)
    append_declared_jsonl(_ledger_path(root), signed, expected_surface="ack_ledger")
    _announce_mint(root, row, {"signer_principal": row.signer_principal, "expires_at": row.expires_at,
                               "anchor_commit": anchor.commit})
    return row


def _consumption_row(
    target_row: dict[str, Any],
    *,
    root: Path,
    consumed_at: str,
    materialize_event_id: str,
) -> dict[str, Any]:
    """The ``aria/ack-consumption/v1`` transition for ``target_row``.

    An HMAC mint row's transition is signed with the mint row's key. An
    operator ack's transition carries no signature (ARIA-MEDIUM-254): no
    kernel key signs for the operator, and the transition binds its mint row
    by ``parent_ack_ledger_hash`` on the hash-chained ledger
    (:func:`_transition_binding_reason`).
    """
    signed_key_id = target_row.get("signed_key_id")
    transition_row: dict[str, Any] = {
        "$schema": "aria/ack-consumption/v1",
        "schema_version": 1,
        "event": "consumed",
        "ack_id": target_row["ack_id"],
        "consumed_at": consumed_at,
        "consumed_by_event_id": materialize_event_id,
        "signed_key_id": signed_key_id,
        "parent_ack_ledger_hash": target_row.get("ledger_hash"),
        "draft_id": target_row.get("draft_id"),
        "intent_id": target_row.get("intent_id"),
        "target_path": target_row.get("target_path"),
    }
    if target_row.get("row_kind") == OPERATOR_ACK_ROW_KIND:
        return transition_row
    key = _resolve_key(root, key_id=str(signed_key_id))
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
    row_dict, row = _hmac_signed_mint_row(
        root,
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
            _consumption_row(persisted_mint, root=root, consumed_at=_utc_now(),
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
    workspace_root: str | Path,
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
    (``ack_token_already_consumed``); and, last, a row that is not the
    operator's signed act or that the anchor refuses
    (``ack_token_signature_invalid: reason=<why>``, ARIA-MEDIUM-254): an
    HMAC operator row minted before the operator signed acks
    (``operator_signature_required``: its key never outlives the job that
    minted it), no checkout on main at ``workspace_root`` (an ``anchor_*``
    or anchor reason), terms the registry refuses at this moment (expired,
    another audience, a class it does not admit) or a signature
    ``ssh-keygen`` does not verify against the committed allowed-signers
    file.

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
        refused: str | None = ACK_OPERATOR_SIGNATURE_REQUIRED
        if target_row.get("row_kind") == OPERATOR_ACK_ROW_KIND:
            anchor, refused = _anchor_for(workspace_root, root)
            if anchor is not None:
                refused = operator_ack_reason(target_row, anchor, now=datetime.now(timezone.utc))
        if refused is not None:
            raise GovernanceError(
                f"ack_token_signature_invalid: ack_id={ack_id!r} reason={refused}"
            )
        persisted_transition = txn.append_declared_jsonl(
            ledger_path,
            _consumption_row(target_row, root=root, consumed_at=_utc_now(),
                             materialize_event_id=materialize_event_id),
            expected_surface="ack_ledger",
        )
    return _announce_consumption(root, target_row, persisted_transition)


def _transition_binding_reason(row: dict[str, Any], mints: dict[str, dict[str, Any]]) -> str | None:
    """Why an unsigned consumption transition does not bind an operator ack's mint row, or None."""
    mint = mints.get(str(row.get("ack_id")))
    if mint is None or mint.get("row_kind") != OPERATOR_ACK_ROW_KIND:
        return "consumption_unbound"
    if not mint.get("ledger_hash") or row.get("parent_ack_ledger_hash") != mint.get("ledger_hash"):
        return "consumption_parent_mismatch"
    return None


def _is_transition(row: dict[str, Any]) -> bool:
    return row.get("event") == "consumed" or row.get("$schema") == "aria/ack-consumption/v1"


def _verify_ledger_row(
    row: dict[str, Any],
    *,
    root: Path,
    anchor: tuple[AllowedSigners | None, str | None] | None,
    mints: dict[str, dict[str, Any]] | None,
    workspace_root: str | Path | None,
) -> tuple[dict[str, Any], tuple[AllowedSigners | None, str | None] | None, dict[str, dict[str, Any]] | None]:
    """One row's verdict; the anchor and the mint index are resolved on first need and handed back for reuse."""
    if row.get("row_kind") == OPERATOR_ACK_ROW_KIND:
        anchor = anchor if anchor is not None else _anchor_for(workspace_root, root)
        signers, reason = anchor
        if signers is None:
            return {"valid": False, "reason": f"anchor_unavailable:{reason}"}, anchor, mints
        refused = operator_ack_reason(row, signers, now=None)
        return {"valid": refused is None, "reason": refused}, anchor, mints
    if _is_transition(row) and row.get("signed_key_id") is None:
        if mints is None:
            mints = {
                str(mint.get("ack_id")): mint
                for mint in load_declared_jsonl(_ledger_path(root), expected_surface="ack_ledger")
                if not _is_transition(mint)
            }
        refused = _transition_binding_reason(row, mints)
        return {"valid": refused is None, "reason": refused}, anchor, mints
    signed_key_id = row.get("signed_key_id")
    if not signed_key_id:
        return {"valid": False, "reason": "missing_signed_key_id"}, anchor, mints
    try:
        key = _resolve_key(root, key_id=signed_key_id)
    except GovernanceError as exc:
        return {"valid": False, "reason": str(exc)}, anchor, mints
    expected = _hmac_sign(key["secret"], _canonical_row_bytes(row))
    actual = row.get("signature") or ""
    valid = hmac.compare_digest(expected, actual)
    return {"valid": valid, "reason": None if valid else "signature_mismatch"}, anchor, mints


def verify_row(
    row: dict[str, Any],
    *,
    base_dir: str | Path,
    workspace_root: str | Path | None = None,
) -> dict[str, Any]:
    """Plan ARIA-V3 §A5 — one ledger row's verdict ``{"valid": bool, "reason": str|None}``.

    An operator ack (ARIA-MEDIUM-254) verifies by ``ssh-keygen`` against the
    allowed-signers file committed at ``workspace_root``'s commit on main
    (signature only: its expiry is a consumption term, not an audit one);
    without a checkout it is ``anchor_unavailable:anchor_unbound``, never a
    pass. Its unsigned consumption transition is valid when it binds that
    mint row on this ledger. An HMAC row (autonomous, or an operator row
    minted before the operator signed acks) re-computes the HMAC under its
    ``signed_key_id``.
    """
    return _verify_ledger_row(row, root=Path(base_dir), anchor=None, mints=None, workspace_root=workspace_root)[0]


def verify_range(
    *,
    base_dir: str | Path,
    last_n: int | None = None,
    workspace_root: str | Path | None = None,
) -> dict[str, Any]:
    """Plan ARIA-V3 §A5 — verify the last N ledger rows (:func:`verify_row` per row).

    Returns a structured result the CLI can pretty-print. ``last_n``
    None means full ledger. The anchor is resolved once, at the first
    operator row.
    """
    root = ensure_tools_dir(base_dir)
    all_rows = load_declared_jsonl(_ledger_path(root), expected_surface="ack_ledger")
    mints = {str(row.get("ack_id")): row for row in all_rows if not _is_transition(row)}
    rows = all_rows[-last_n:] if last_n is not None else all_rows
    anchor: tuple[AllowedSigners | None, str | None] | None = None
    results: list[dict[str, Any]] = []
    for row in rows:
        outcome, anchor, _ = _verify_ledger_row(row, root=root, anchor=anchor, mints=mints,
                                                workspace_root=workspace_root)
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
    "operator_ack_reason",
    "record_autonomous_ack",
    "revoke_key",
    "revoked_keys",
    "rotate_key",
    "verify_range",
    "verify_row",
]
