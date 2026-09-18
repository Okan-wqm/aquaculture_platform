"""What a publish may lose past the published tip — and who vouched for it.

``state_store._publish_state_locked`` compares the snapshot being published
with the tip (``state_snapshot.snapshot_continuity``) and, when the two are
not simply continuous, asks this module for a verdict. Two statuses reach
it, and they are not alike:

* ``chain_broken`` — the snapshot's ``prev_snapshot_id`` names a predecessor
  other than the tip although its ``prev_manifest_root`` matched. NOTHING
  makes that publishable, losses or no losses, acknowledgment or none: a
  tree that does not know which snapshot it continues cannot be proven to
  continue anything. bd74c801c refused it by name; the compaction-attestation
  rewrite briefly let a loss-free chain_broken through because it gated on
  the loss list being empty instead of on the status. The status is what is
  gated here, so an empty loss list can never open the gate again.

* ``surfaces_lost`` — a surface the tip carried and the snapshot does not.
  Every such loss must be VOUCHED FOR, by exactly one of two parties:

  - the kernel's own compaction, whose ``state_compacted`` row appended since
    the tip names every path it pruned (``state_compact``). A write-driving
    ledger is never accepted this way: compaction slims ledgers, it does not
    delete them, so its absence is amnesia whatever a row claims;
  - the operator, through ``ARIA_STATE_BOOTSTRAP_ACK`` — validated exactly
    as the bootstrap validates it (the value must name THIS repository, so a
    standing "1" or another repository's ack cannot travel) AND recorded on
    a ``state_publish_losses_accepted_by_ack`` governance row appended since
    the tip. The row is what makes the acceptance durable: the publish
    preamble (``state_store.prepare_publishable_snapshot``) appends it
    BEFORE the snapshot is built, so it lives inside the very commit whose
    losses it accepts, hash-chained under the governance surface that commit
    attests. A publish that finds the ack in its environment but no row for
    the losses refuses by name — the acceptance was never recorded, and an
    unrecorded reduction is the silent one this gate exists to refuse.

The record is bounded by construction: the surfaces are listed inline while
they fit the inline field cap and spill to a digest stub past it, and the
digest over the full sorted list is what the publish verifies against — a
row the append primitive would refuse for size cannot be produced here.
"""

from __future__ import annotations

import hashlib
import json
from typing import Any

# The governance event the publish preamble appends when the operator's
# acknowledgment accepts losses nothing attested, and the fields a later
# publish reads back from it.
LOSSES_ACCEPTED_BY_ACK_EVENT = "state_publish_losses_accepted_by_ack"
ACCEPTED_SURFACES_KEY = "lost_surfaces"
ACCEPTED_SURFACES_DIGEST_KEY = "lost_surfaces_sha256"
ACK_REF_KEY = "ack_ref"

# The publish-side name for an acknowledgment that does not name this
# repository — the bootstrap's refusal for the same value is
# ``state_store_bootstrap_ack_mismatch``; the check is the one function.
ACK_MISMATCH_REFUSAL = "state_publish_reduction_ack_mismatch"


def losses_not_attested_by_compaction(
    store: Any,
    *,
    published: dict[str, Any],
    lost_surfaces: list[str],
) -> list[str]:
    """The lost surfaces no compaction row appended since the tip vouches for.

    ``state_compact`` records the tools-relative paths (and ``dir/``
    prefixes) it pruned on its ``state_compacted`` governance row; the rows
    to consult are those appended after the published tip's own claim of
    the governance ledger (``row_count``), i.e. this run's rows. A lost
    surface is attested when it lives under the tools root and one of
    those paths covers it.

    A write-driving ledger is never accepted this way: compaction slims
    ledgers, it does not delete them, so its absence is amnesia whatever a
    row says — the same line ``memory_gap.write_driving_lost`` draws for
    the daily report.
    """
    from .ledger import LedgerIntegrityError, LedgerReadLimitError
    from .memory_gap import write_driving_lost
    from .state_compact import attested_pruned_paths, prune_attested
    from .state_store import StateStoreRefusal, tools_root

    lost = list(lost_surfaces)
    if not lost:
        return []
    previous_surfaces = published.get("surfaces") or {}
    try:
        attested = attested_pruned_paths(
            tools_root(store),
            governance_rows_since=governance_rows_claimed_by(published),
        )
    except (LedgerIntegrityError, LedgerReadLimitError) as exc:
        raise StateStoreRefusal(
            "state_publish_governance_ledger_unreadable: the compaction "
            f"attestation could not be read ({str(exc)[:200]})"
        ) from exc
    if not attested:
        return lost
    driving = set(write_driving_lost(lost))
    unattested: list[str] = []
    for key in lost:
        claim = previous_surfaces.get(key)
        claim = claim if isinstance(claim, dict) else {}
        if (
            key in driving
            or claim.get("root_kind") != "tools"
            or not prune_attested(str(claim.get("path") or ""), attested)
        ):
            unattested.append(key)
    return unattested


def governance_rows_claimed_by(published: dict[str, Any]) -> int:
    """How many governance rows the published tip attested — the index from
    which this run's own rows begin."""
    claim = (published.get("surfaces") or {}).get("tools_governance")
    count = claim.get("row_count") if isinstance(claim, dict) else None
    return count if isinstance(count, int) and count >= 0 else 0


def surfaces_digest(surfaces: list[str]) -> str:
    """Content identity of a loss set, order-free."""
    canonical = json.dumps(sorted(surfaces), separators=(",", ":")).encode("utf-8")
    return f"sha256:{hashlib.sha256(canonical).hexdigest()}"


def _governance_rows_since(store: Any, *, since: int) -> list[dict[str, Any]]:
    from .ledger import (
        LedgerIntegrityError,
        LedgerReadLimitError,
        load_declared_jsonl,
    )
    from .state_store import StateStoreRefusal, tools_root

    path = tools_root(store) / "governance.jsonl"
    if not path.exists():
        return []
    try:
        rows = load_declared_jsonl(path, expected_surface="tools_governance")
    except (LedgerIntegrityError, LedgerReadLimitError) as exc:
        raise StateStoreRefusal(
            "state_publish_governance_ledger_unreadable: the loss-acceptance "
            f"record could not be read ({str(exc)[:200]})"
        ) from exc
    return rows[since:]


def ack_accepted_surfaces_since_tip(
    store: Any,
    *,
    published: dict[str, Any],
    ack: str,
    lost_surfaces: list[str],
) -> list[str]:
    """Which of ``lost_surfaces`` an acceptance row appended since the tip,
    under this very acknowledgment, records.

    A row names its surfaces inline while they fit, and always carries the
    digest of its full sorted list; a spilled row therefore vouches for
    ``lost_surfaces`` exactly when the digests agree, an inline row for each
    surface it lists.
    """
    lost = list(lost_surfaces)
    if not lost:
        return []
    whole = surfaces_digest(lost)
    accepted: set[str] = set()
    for row in _governance_rows_since(
        store,
        since=governance_rows_claimed_by(published),
    ):
        if row.get("kind") != LOSSES_ACCEPTED_BY_ACK_EVENT:
            continue
        details = row.get("details")
        if not isinstance(details, dict) or details.get(ACK_REF_KEY) != ack:
            continue
        listed = details.get(ACCEPTED_SURFACES_KEY)
        if isinstance(listed, list):
            accepted.update(item for item in listed if isinstance(item, str))
        if details.get(ACCEPTED_SURFACES_DIGEST_KEY) == whole:
            accepted.update(lost)
    return [key for key in lost if key in accepted]


def record_operator_accepted_losses(
    store: Any,
    *,
    snapshot: dict[str, Any],
    previous: dict[str, Any] | None,
) -> tuple[str, ...]:
    """The preamble's half: record the operator's acceptance BEFORE the build.

    Called by ``prepare_publishable_snapshot`` on the snapshot it has just
    built against ``previous``. When that snapshot loses surfaces neither
    compaction attested nor the caller can publish without the operator,
    and ``ARIA_STATE_BOOTSTRAP_ACK`` names this repository, the acceptance
    is appended to the governance ledger and the surfaces are returned so
    the caller rebuilds the snapshot over the row. Without an ack nothing is
    written — the publish then refuses by name, which is the gate's job, not
    this function's. Returns ``()`` when there was nothing to accept.
    """
    from .ledger import LedgerIntegrityError
    from .memory_gap import write_driving_lost
    from .state_snapshot import snapshot_continuity
    from .state_store import StateStoreRefusal, _acknowledged_repository, tools_root
    from .tool_registry import GovernanceError, append_tools_governance
    from .ledger_inline import spill_oversized_inline

    if previous is None:
        return ()
    continuity = snapshot_continuity(snapshot, previous)
    if continuity["status"] != "surfaces_lost":
        return ()
    unattested = losses_not_attested_by_compaction(
        store,
        published=previous,
        lost_surfaces=continuity["lost_surfaces"],
    )
    if not unattested:
        return ()
    ack = _acknowledged_repository(store.repo_root, mismatch_refusal=ACK_MISMATCH_REFUSAL)
    if ack is None:
        return ()
    accepted = sorted(unattested)
    try:
        append_tools_governance(
            tools_root(store),
            LOSSES_ACCEPTED_BY_ACK_EVENT,
            {
                ACK_REF_KEY: ack,
                ACCEPTED_SURFACES_KEY: spill_oversized_inline(
                    ACCEPTED_SURFACES_KEY,
                    accepted,
                    recovery=(
                        "the surfaces the previous snapshot.json claims and "
                        "this commit's does not"
                    ),
                ),
                ACCEPTED_SURFACES_DIGEST_KEY: surfaces_digest(accepted),
                "lost_count": len(accepted),
                "write_driving_lost": list(write_driving_lost(accepted)),
                "previous_snapshot_id": previous.get("snapshot_id"),
                "previous_manifest_root": previous.get("manifest_root"),
            },
        )
    except GovernanceError as exc:
        raise StateStoreRefusal(
            "state_publish_losses_acceptance_record_refused: the acknowledged "
            f"reduction of {len(accepted)} surface(s) could not be recorded "
            f"({exc}); nothing is accepted unrecorded"
        ) from exc
    except LedgerIntegrityError as exc:
        raise StateStoreRefusal(
            "state_publish_governance_ledger_unreadable: the loss-acceptance "
            f"row could not be appended ({str(exc)[:200]}); nothing is "
            "accepted unrecorded"
        ) from exc
    return tuple(accepted)


def vouched_continuity(
    store: Any,
    *,
    snapshot: dict[str, Any],
    published: dict[str, Any],
    continuity: dict[str, Any],
) -> dict[str, Any]:
    """The publish's half: refuse by name, or return the continuity verdict
    enriched with who vouched for each loss.

    ``continuity`` is ``snapshot_continuity(snapshot, published)`` with a
    status other than ``ok``; ``published`` is the tip the ancestry proof
    already matched the snapshot's ``prev_manifest_root`` against.
    """
    from .state_store import StateStoreRefusal, _acknowledged_repository

    status = continuity["status"]
    if status != "surfaces_lost":
        raise StateStoreRefusal(
            f"state_publish_continuity_{status}: the snapshot names "
            f"prev_snapshot_id={snapshot.get('prev_snapshot_id')!r} but the "
            f"published tip is {published.get('snapshot_id')!r}; "
            f"lost_surfaces={continuity['lost_surfaces']}"
        )
    lost = list(continuity["lost_surfaces"])
    unattested = losses_not_attested_by_compaction(
        store,
        published=published,
        lost_surfaces=lost,
    )
    verdict = {
        **continuity,
        "compaction_attested_surfaces": sorted(set(lost) - set(unattested)),
        "ack_accepted_surfaces": [],
    }
    if not unattested:
        return verdict
    ack = _acknowledged_repository(store.repo_root, mismatch_refusal=ACK_MISMATCH_REFUSAL)
    if ack is None:
        raise StateStoreRefusal(
            f"state_publish_continuity_surfaces_lost: lost_surfaces={unattested}"
        )
    accepted = ack_accepted_surfaces_since_tip(
        store,
        published=published,
        ack=ack,
        lost_surfaces=unattested,
    )
    unrecorded = [key for key in unattested if key not in accepted]
    if unrecorded:
        raise StateStoreRefusal(
            "state_publish_losses_acceptance_unrecorded: the acknowledgment "
            "names this repository but no "
            f"{LOSSES_ACCEPTED_BY_ACK_EVENT} row appended since the tip records "
            f"{unrecorded}; publish through prepare_publishable_snapshot, which "
            "records the acceptance before the snapshot is built"
        )
    verdict["ack_accepted_surfaces"] = accepted
    return verdict


__all__ = [
    "ACCEPTED_SURFACES_DIGEST_KEY",
    "ACCEPTED_SURFACES_KEY",
    "ACK_MISMATCH_REFUSAL",
    "ACK_REF_KEY",
    "LOSSES_ACCEPTED_BY_ACK_EVENT",
    "ack_accepted_surfaces_since_tip",
    "governance_rows_claimed_by",
    "losses_not_attested_by_compaction",
    "record_operator_accepted_losses",
    "surfaces_digest",
    "vouched_continuity",
]
