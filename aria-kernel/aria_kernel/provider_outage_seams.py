"""The native admission as an outage detection and restore seam (ARIA-HIGH-366).

WHY. The admission probes each provider's login before anything is claimed.
A logged-out session was DECIDED there (``managed_session_logged_out``,
``cli_reported_not_logged_in``) and the request released harness-class as
``native_runtime_admission_unavailable`` — 73 times on 2026-09-18/19 — with no
cooldown, no outage and no signal, so the operator learned nothing and every
waiting timer kept running. The same probe answering "logged in" is the
positive evidence that the login outage is over. Both facts are already on
the admission's candidate rows; this module writes them, once per transition,
through the one cooldown writer (which opens the outage) and the one restore
writer.
"""
from __future__ import annotations

from pathlib import Path
from typing import Any, Iterable

from .provider_cooldown import PROVIDER_EXHAUSTION_SIGNATURES, record_provider_cooldown
from .provider_outage_ledger import ADMISSION_RESTORABLE_KINDS, open_outages, record_provider_restored

# The status reasons that DECIDE a logged-out managed session, per vendor
# (`tools/aria-poc/status_answers.py`), and the signature each is cooled under.
LOGGED_OUT_STATUS_SIGNATURES: dict[str, str] = {
    "managed_session_logged_out": "claude_logged_out",
    "cli_reported_not_logged_in": "codex_logged_out",
    "cli_reported_not_logged_in_with_readonly_path_alias_warning": "codex_logged_out",
}


def observe_native_admission(
    base_dir: str | Path | None, *, observations: Iterable[dict[str, Any]], request_id: str,
    cooldown_seconds: int,
) -> None:
    """Open a ``logged_out`` outage per logged-out provider row; close it per logged-in row."""
    rows = list(observations)
    open_logged_out = {i.provider for i in open_outages(base_dir) if i.kind in ADMISSION_RESTORABLE_KINDS}
    for row in rows:
        provider, reason = row.get("provider"), row.get("status_reason")
        signature = LOGGED_OUT_STATUS_SIGNATURES.get(str(reason))
        if signature is not None and PROVIDER_EXHAUSTION_SIGNATURES[signature][0] == provider:
            record_provider_cooldown(
                base_dir, provider=str(provider), model=str(row.get("model")),
                cooldown_seconds=cooldown_seconds, request_id=request_id,
                # No claim exists yet: the admission runs before the lease.
                claim_id=f"admission:{request_id}",
                detection={"signature": signature, "status_reason": reason, "seam": "native_admission"},
            )
        elif row.get("auth_observation") == "available" and provider in open_logged_out:
            record_provider_restored(base_dir, provider=str(provider), seam="native_admission",
                                     request_id=request_id, kinds=ADMISSION_RESTORABLE_KINDS)


__all__ = ["LOGGED_OUT_STATUS_SIGNATURES", "observe_native_admission"]
