"""ADR-0018 B1 — the signed terms that bound where and how long a request is valid.

WHY. Review round 2 (ai-safety AISAFETY-HIGH-001, security GSEC-MEDIUM-001)
showed that consume-once rests on the ingestion ledger: a request copied
into another store, or an ``aria/state`` rolled back past the row that spent
it, would be admitted again forever. A signed request therefore carries
three terms the operator's signature covers and every verifier re-checks:

* ``audience`` — the repository the request is for, so a row copied from
  another store does not speak here;
* ``expires_at`` — at most the operator-act lifetime after ``authored_at``,
  so a rollback can re-admit a request only inside a bounded window (and the
  merge lane refuses an expired request outright);
* ``grounding_digest`` — the admitted evidence refs at record time
  (``finding_grounding.grounding_digest``), so refs that change after
  signing never ground the request.

WHAT. :func:`request_terms_reason` judges the three against the anchor's
values: the audience is ``repository`` of ``docs/aria/policy/operators.json``
and the lifetime is the request entry's bound in the namespace registry,
both read as git objects at the anchor commit proven on main
(``operator_request_signature.AllowedSigners``) — never the working tree a
runner-uid process can edit (ARIA-LOW-267, ADR-0023).
"""
from __future__ import annotations

import re
from datetime import datetime, timedelta, timezone
from typing import Any

REQUEST_EXPIRED = "request_expired"
REQUEST_EXPIRY_INVALID = "request_expiry_invalid"
REQUEST_AUDIENCE_MISMATCH = "request_audience_mismatch"
GROUNDING_DIGEST_MISSING = "grounding_digest_missing"
TERMS_REASONS: tuple[str, ...] = (
    REQUEST_EXPIRED, REQUEST_EXPIRY_INVALID, REQUEST_AUDIENCE_MISMATCH, GROUNDING_DIGEST_MISSING,
)
_DIGEST_RE = re.compile(r"^sha256:[0-9a-f]{64}$")


def utc_iso(moment: datetime) -> str:
    return moment.astimezone(timezone.utc).isoformat()


def parse_utc(value: Any) -> datetime | None:
    """An ISO-8601 timestamp WITH a zone, or None; a naive time is never guessed."""
    if not isinstance(value, str) or not value:
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    return parsed if parsed.tzinfo is not None else None


def request_terms_reason(row: dict[str, Any], *, now: datetime, audience: str, max_hours: int) -> str | None:
    """Why the request's signed terms refuse it at ``now`` for the anchor's audience and bound, or None."""
    if row.get("audience") != audience:
        return REQUEST_AUDIENCE_MISMATCH
    authored = parse_utc(row.get("authored_at"))
    expires = parse_utc(row.get("expires_at"))
    if authored is None or expires is None or not authored < expires <= authored + timedelta(hours=max_hours):
        return REQUEST_EXPIRY_INVALID
    if now >= expires:
        return REQUEST_EXPIRED
    digest = row.get("grounding_digest")
    if not isinstance(digest, str) or _DIGEST_RE.fullmatch(digest) is None:
        return GROUNDING_DIGEST_MISSING
    return None


__all__ = [
    "GROUNDING_DIGEST_MISSING",
    "REQUEST_AUDIENCE_MISMATCH",
    "REQUEST_EXPIRED",
    "REQUEST_EXPIRY_INVALID",
    "TERMS_REASONS",
    "parse_utc",
    "request_terms_reason",
    "utc_iso",
]
