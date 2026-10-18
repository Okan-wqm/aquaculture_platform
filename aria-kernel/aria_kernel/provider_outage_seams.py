"""The native admission as an outage detection and restore seam (ARIA-HIGH-366).

WHY. The admission probes each provider's login before anything is claimed.
A logged-out session was DECIDED there (``managed_session_logged_out``, now
``claude_gateway_credential_absent``; ``cli_reported_not_logged_in``) and the request released harness-class as
``native_runtime_admission_unavailable`` — 73 times on 2026-09-18/19 — with no
cooldown, no outage and no signal, so the operator learned nothing and every
waiting timer kept running. The same probe answering "logged in" is the
positive evidence that the login outage is over. Both facts are already on
the admission's candidate rows; this module writes them, once per transition,
through the one cooldown writer (which opens the outage) and the one restore
writer.

ARIA-HIGH-435 (2026-10-11; operator decision: if Z.ai's quota runs out too and
no provider is left, no work may be lost). Z.ai's admission probe is not a
login check: ``zai_runtime.probe_zai_status`` spends one output token on a
real completion, so its refusal is the vendor's own quota or credential
answer (``zai_runtime._classify``: 429/402 and the quota codes read
``quota_or_rate_limited_http_<status>``, 401/403 ``auth_rejected_http_<status>``).
The seam cooled none of it. A Z.ai quota first met at an admission therefore
opened no outage, so the provider-available clock of every role Z.ai heads
(``glm_first``) kept running through a total outage — requests aged into
ANCHOR_STALE, plans waiting on a challenger abandoned — and a Z.ai back-off a
run had written lapsed and was never renewed, so the fleet read Z.ai as
serving: discretionary minting reopened and the planner hook claimed, spent
a probe and released, tick after tick. The refusal now goes through the same
writer as every other detection, so each admission re-probe that meets the
standing outage renews the back-off (doubling to ``MAX_REPROBE_SECONDS``) and
the outage stays one transition with one item. Restoring stays with the
served spawn: an admission that sees a 200 admits, and the spawn restores.
"""
from __future__ import annotations

from datetime import datetime
from pathlib import Path
from typing import Any, Iterable

from .provider_cooldown import PROVIDER_EXHAUSTION_SIGNATURES, record_provider_cooldown
from .provider_outage_ledger import ADMISSION_RESTORABLE_KINDS, open_outages, record_provider_restored

# The status reasons that DECIDE a provider has no usable credential on this
# host, per vendor — the kernel's Claude credential boundary refused
# (ARIA-MEDIUM-563, `claude_runtime.CLAUDE_GATEWAY_CREDENTIAL_ABSENT`), a
# logged-out Codex session (`tools/aria-poc/status_answers.py`) — and the
# signature each is cooled under.
LOGGED_OUT_STATUS_SIGNATURES: dict[str, str] = {
    "claude_gateway_credential_absent": "claude_logged_out",
    "cli_reported_not_logged_in": "codex_logged_out",
    "cli_reported_not_logged_in_with_readonly_path_alias_warning": "codex_logged_out",
}
# ARIA-HIGH-435 — the reasons a REAL completion probe decides (the HTTP status
# follows the prefix; `zai_runtime._classify`), and the signature each is
# cooled under. A refused request (`request_refused_http_*`: a model or route
# the key is not entitled to) and a vendor 5xx are not outage facts.
COMPLETION_PROBE_SIGNATURE_PREFIXES: dict[str, str] = {
    "quota_or_rate_limited_http_": "zai_quota_refusal",
    "auth_rejected_http_": "zai_auth_refusal",
}


def admission_signature(provider: Any, reason: Any) -> str | None:
    """The exhaustion signature an admission row's decided reason names for ``provider``, or None."""
    text = str(reason)
    signature = LOGGED_OUT_STATUS_SIGNATURES.get(text) or next(
        (sig for prefix, sig in COMPLETION_PROBE_SIGNATURE_PREFIXES.items() if text.startswith(prefix)), None)
    if signature is None or PROVIDER_EXHAUSTION_SIGNATURES[signature][0] != provider:
        return None
    return signature


def observe_native_admission(
    base_dir: str | Path | None, *, observations: Iterable[dict[str, Any]], request_id: str,
    cooldown_seconds: int, now: datetime | None = None,
) -> None:
    """Cool (and so open the outage of) each provider a row DECIDES out; close a login outage per logged-in row."""
    rows = list(observations)
    open_logged_out = {i.provider for i in open_outages(base_dir) if i.kind in ADMISSION_RESTORABLE_KINDS}
    for row in rows:
        provider, reason = row.get("provider"), row.get("status_reason")
        signature = admission_signature(provider, reason)
        if signature is not None:
            record_provider_cooldown(
                base_dir, provider=str(provider), model=str(row.get("model")),
                cooldown_seconds=cooldown_seconds, request_id=request_id,
                # No claim exists yet: the admission runs before the lease.
                claim_id=f"admission:{request_id}",
                detection={"signature": signature, "status_reason": reason, "seam": "native_admission"},
                now=now,
            )
        elif row.get("auth_observation") == "available" and provider in open_logged_out:
            record_provider_restored(base_dir, provider=str(provider), seam="native_admission",
                                     request_id=request_id, kinds=ADMISSION_RESTORABLE_KINDS, now=now)


__all__ = [
    "COMPLETION_PROBE_SIGNATURE_PREFIXES", "LOGGED_OUT_STATUS_SIGNATURES", "admission_signature",
    "observe_native_admission",
]
