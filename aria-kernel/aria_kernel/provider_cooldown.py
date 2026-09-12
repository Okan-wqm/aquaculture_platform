"""Provider quota cooldown — the ledger fact behind `provider_quota_cooldown`.

Operator decision 2026-09-12: a credit/quota exhaustion is a PROVIDER-level
fact and is never answered by a weaker tier. Two lanes answer it in the
same two moves, which this module makes explicit and testable:

* WRITE — an executor's `ClaudeCreditExhausted` arm records a
  `provider_quota_cooldown` governance row naming the provider, the model,
  `quota_unavailable`, the policy's `provider_cooldown_seconds` and the
  resulting `until`, under the claim that ran out. The native planner lane
  (`ci_executor._main`) then releases the claim as REQUEUED under
  `provider_quota_unavailable:<provider>` (a harness-fault reason, so the
  request's requeue budget does not burn for a billing event); the worker
  lane (`worker_executor.main`) exits non-zero and the dispatch hook, which
  owns that claim, reads the row this claim wrote (`provider_cooldown_for_claim`)
  and releases under the same provider-naming reason.
* READ — the next admission asks `active_provider_cooldowns` before it
  probes or claims: the native fleet refuses a cooled provider by name
  (`model_fleet.COOLDOWN_STATUS_REASON`) and admits the next vendor for the
  roles it can serve; the worker dispatch hook, whose write-scope profile
  only the managed Claude route can run, skips the assignment without a
  claim (`worker_dispatch_provider_cooldown`) and the scheduler backs off
  while the cooldown stands. `claude auth status` cannot see quota, so
  without this row the exhausted provider would be re-admitted, re-spawned
  and re-exhausted on every tick.

Every reader indexes the row through ONE contract (`_validated_cooldown`):
a `provider_quota_cooldown` row missing or mistyping any field a reader
uses is refused by name (`GovernanceError`), never skipped — a malformed
cooldown that silently cooled nothing would re-admit an exhausted provider.

`genesis_policy._AdaptiveRuntimePolicy.provider_cooldown_seconds` existed
with no reader before this module; `provider_cooldown_seconds` is the one
accessor for that duration.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

from .genesis_policy import _AdaptiveRuntimePolicy, _adaptive_runtime_policy
from .ledger import load_jsonl
from .tool_registry import GovernanceError, append_tools_governance, ensure_tools_dir, tools_dir

PROVIDER_COOLDOWN_GOVERNANCE_KIND = "provider_quota_cooldown"
# The admission vocabulary the row names — the same word the native
# `runtime_attempt_finished` row uses for the exhausted attempt itself.
PROVIDER_COOLDOWN_REASON = "quota_unavailable"
PROVIDER_COOLDOWN_SCHEMA_VERSION = 1

# The row contract, as data: every non-empty string field a reader indexes
# (`model_fleet._native_runtime_admission`, `worker_dispatch_hook`), the
# two instants, the window and the detection record. A row that fails any
# line of this is refused by name, so a reader can index these keys
# without guarding them.
_ROW_STRING_FIELDS: tuple[str, ...] = (
    "provider", "model", "reason", "recorded_at", "until", "request_id", "claim_id",
)


def _utc_now() -> datetime:
    return datetime.now(timezone.utc)


def _iso(moment: datetime) -> str:
    return moment.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _parse_iso(value: Any) -> datetime | None:
    if not isinstance(value, str) or not value:
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def provider_cooldown_seconds(repo_root: str | Path) -> int:
    """The one cooldown duration, from the adaptive runtime policy.

    An enabled `executor.adaptive_runtime` block supplies its validated
    value; otherwise the duration is the default the same policy dataclass
    declares. The loader pins an enabled block to that same number, so the
    window is the policy's declared duration in every configuration — the
    worker lane, which has no adaptive/legacy split, needs it whether or
    not the native planner lane is switched on.
    """
    policy = _adaptive_runtime_policy(repo_root)
    if policy is not None:
        return policy.provider_cooldown_seconds
    return _AdaptiveRuntimePolicy.provider_cooldown_seconds


def record_provider_cooldown(
    base_dir: str | Path | None,
    *,
    provider: str,
    model: str,
    cooldown_seconds: int,
    request_id: str,
    claim_id: str,
    detection: dict[str, Any],
    now: datetime | None = None,
) -> dict[str, Any]:
    """Append the cooldown row and return it (with its ledger envelope).

    `detection` is the runtime's own credit-exhaustion record (which marker
    matched, on which stream) — kept on the row so the operator can tune the
    marker set from production evidence without a second ledger.
    """
    if cooldown_seconds <= 0:
        raise ValueError(f"provider_cooldown_seconds must be positive, got {cooldown_seconds!r}")
    started = now or _utc_now()
    return append_tools_governance(ensure_tools_dir(base_dir), PROVIDER_COOLDOWN_GOVERNANCE_KIND, {
        "schema_version": PROVIDER_COOLDOWN_SCHEMA_VERSION,
        "provider": provider,
        "model": model,
        "reason": PROVIDER_COOLDOWN_REASON,
        "cooldown_seconds": int(cooldown_seconds),
        "recorded_at": _iso(started),
        "until": _iso(started + timedelta(seconds=int(cooldown_seconds))),
        "request_id": request_id,
        "claim_id": claim_id,
        "detection": detection,
    })


def _malformed(row: dict[str, Any], field: str) -> GovernanceError:
    return GovernanceError(
        f"provider_cooldown_row_malformed:{field} (ledger_hash={row.get('ledger_hash')!r})"
    )


def _validated_cooldown(row: dict[str, Any]) -> dict[str, Any]:
    """The row's details, or a refusal naming the first field that breaks the contract."""
    details = row.get("details")
    if not isinstance(details, dict):
        raise _malformed(row, "details")
    if details.get("schema_version") != PROVIDER_COOLDOWN_SCHEMA_VERSION:
        raise _malformed(row, "schema_version")
    for field in _ROW_STRING_FIELDS:
        value = details.get(field)
        if not isinstance(value, str) or not value:
            raise _malformed(row, field)
    if details["reason"] != PROVIDER_COOLDOWN_REASON:
        raise _malformed(row, "reason")
    for field in ("recorded_at", "until"):
        if _parse_iso(details[field]) is None:
            raise _malformed(row, field)
    seconds = details.get("cooldown_seconds")
    if type(seconds) is not int or seconds <= 0:
        raise _malformed(row, "cooldown_seconds")
    if not isinstance(details.get("detection"), dict):
        raise _malformed(row, "detection")
    return details


def _cooldown_rows(base_dir: str | Path | None) -> list[dict[str, Any]]:
    """Every `provider_quota_cooldown` row, validated, in ledger (time) order."""
    governance = tools_dir(base_dir) / "governance.jsonl"
    if not governance.is_file():
        return []
    return [_validated_cooldown(row) for row in load_jsonl(governance)
            if row.get("kind") == PROVIDER_COOLDOWN_GOVERNANCE_KIND]


def active_provider_cooldowns(
    base_dir: str | Path | None, *, now: datetime | None = None,
) -> dict[str, dict[str, Any]]:
    """The latest unexpired cooldown per provider, keyed by provider.

    Reads `governance.jsonl` (the only place the row lives). An expired row
    does not cool anything; a malformed row is refused by name (see
    `_validated_cooldown`). The newest row per provider wins, so a later
    shorter cooldown is not shadowed by an earlier longer one.
    """
    moment = now or _utc_now()
    active: dict[str, dict[str, Any]] = {}
    for details in _cooldown_rows(base_dir):
        # Ledger order is time order: the last row seen per provider is the
        # newest and is the one that decides. Expiry is applied AFTER the
        # walk so an older, longer cooldown cannot outlive a newer, shorter one.
        active[details["provider"]] = details
    return {provider: details for provider, details in active.items()
            if _parse_iso(details["until"]) > moment}


def provider_cooldown_for_claim(
    base_dir: str | Path | None, *, claim_id: str,
) -> dict[str, Any] | None:
    """The newest cooldown row written under `claim_id`, or None.

    The worker dispatch hook owns the claim its executor child runs under;
    the child's `except ClaudeCreditExhausted` arm records the cooldown
    under that claim and exits non-zero. This is how the hook tells a quota
    exhaustion apart from a crash without parsing stderr: the durable row
    the child wrote, keyed on the identity only the two of them share.
    """
    match: dict[str, Any] | None = None
    for details in _cooldown_rows(base_dir):
        if details["claim_id"] == claim_id:
            match = details
    return match


__all__ = [
    "PROVIDER_COOLDOWN_GOVERNANCE_KIND",
    "PROVIDER_COOLDOWN_REASON",
    "PROVIDER_COOLDOWN_SCHEMA_VERSION",
    "active_provider_cooldowns",
    "provider_cooldown_for_claim",
    "provider_cooldown_seconds",
    "record_provider_cooldown",
]
