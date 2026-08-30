"""Scope discipline — the three contracts that keep agents on-task.

Operator requirements (2026-08-29), each closing a measured gap:

1. DECLARED ROUTE — agents state their intended approach BEFORE acting,
   so deviation is detectable at the boundary rather than discovered in
   the diff. The route is the "güzergah beyanı": what path the agent
   believes the fix requires, declared up-front, compared against the
   evidence it later cites.

2. OUT-OF-SCOPE OBSERVATIONS — a model that sees a deficiency outside its
   assignment must NOT fix it (that is the deviation failure mode), but
   must NOT stay silent either: the observation is captured with its
   recommended route and becomes pressure for a separate plan. The
   evidence validator's out-of-scope rejection becomes a CAPTURE, not a
   dead end.

3. NETWORK CONTAINMENT — the codex bridge carries an explicit
   network-off config: the sandbox's default (network disabled under
   workspace-write and read-only) is pinned rather than trusted, so a
   future codex-cli default change cannot silently open egress.
"""

from __future__ import annotations

from typing import Any


# ---------------------------------------------------------------------------
# 1. Declared route
# ---------------------------------------------------------------------------

def require_declared_route(response: dict[str, Any]) -> dict[str, Any] | None:
    """The response must carry a declared_route; return the violation or None.

    The route is the agent's stated approach — WHAT path it intends to take,
    not what it found (that's evidence) or what it did (that's the diff).
    The contract: the route is declared BEFORE the work, so any evidence
    or diff outside it is a deviation the reviewer can NAME.
    """
    route = response.get("declared_route")
    if not isinstance(route, str) or not route.strip():
        return {
            "code": "declared_route_missing",
            "reason": "the agent must declare its intended route (approach) before the work; "
                      "a missing route is an uncheckable deviation, not a style preference",
        }
    if len(route.strip()) < 10:
        return {
            "code": "declared_route_too_thin",
            "reason": f"declared_route={route.strip()!r} is too thin to compare against evidence",
        }
    return None


def route_covers_evidence(declared_route: str, evidence_ref: str) -> bool:
    """Whether a piece of evidence plausibly falls within the declared route.

    This is a HEURISTIC, not a proof: the route is prose, the evidence is a
    path. The check is deliberately loose (substring/keyword overlap) — its
    job is to catch gross deviations (a route about "fix the auth resolver"
    citing a migration in a different service), not to police paraphrase.
    The reviewer — human or adversarial judge — makes the final call.
    """
    route_lower = declared_route.lower()
    ref_lower = evidence_ref.lower()
    # The evidence path's meaningful segments (service, module, file)
    segments = [s for s in ref_lower.replace("/", " ").replace(".", " ").split() if len(s) > 3]
    if not segments:
        return True  # a bare line number or synthetic ref: not enough signal to judge
    overlap = sum(1 for s in segments if s in route_lower)
    return overlap >= max(1, len(segments) // 3)


# ---------------------------------------------------------------------------
# 2. Out-of-scope observation capture
# ---------------------------------------------------------------------------

def capture_out_of_scope_observation(
    *,
    ref: str,
    reason: str,
    response: dict[str, Any],
) -> dict[str, Any]:
    """Build the pressure-ready observation row from a rejected evidence ref.

    The model SAW something outside its assignment. The contract: don't fix
    it, don't discard it — record it with the recommended route so a
    separate plan (another agent, another cycle) can pick it up with full
    context. The observation carries the declaring agent's identity and
    the route it was on when it noticed, so the reader can judge whether
    the sighting is trustworthy (a specialist in the domain) or incidental.
    """
    return {
        "kind": "out_of_scope_observation",
        "ref": ref,
        "rejection_reason": reason,
        "declared_route": response.get("declared_route", ""),
        "recommended_route": response.get("out_of_scope_routes", {}).get(ref, ""),
        "observed_by_agent": response.get("agent_id", ""),
        "note": "seen while on-task; recorded for a separate plan, never acted on in-flight",
    }


def extract_out_of_scope_observations(
    *,
    rejected_errors: list[dict[str, Any]],
    response: dict[str, Any],
) -> list[dict[str, Any]]:
    """Convert every out-of-scope evidence rejection into a pressure observation."""
    observations: list[dict[str, Any]] = []
    for error in rejected_errors:
        if error.get("code") != "agent_evidence_outside_allowed_scope":
            continue
        observations.append(
            capture_out_of_scope_observation(
                ref=str(error.get("path", "")),
                reason=str(error.get("reason", "")),
                response=response,
            )
        )
    return observations


# ---------------------------------------------------------------------------
# 3. Network containment config
# ---------------------------------------------------------------------------

def codex_network_off_config() -> list[str]:
    """The -c overrides that pin the codex sandbox to network-off.

    The sandbox's default already disables network under read-only and
    workspace-write; this pins it explicitly so a codex-cli update changing
    the default cannot silently open egress. The operator requirement is
    absolute: agents work in THIS repo, with NO internet, NO other repos.
    """
    return [
        "-c", "sandbox_workspace_write.network_access=false",
        "-c", "sandbox_read_only.network_access=false",
    ]
