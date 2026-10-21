"""ARIA-MEDIUM-129 — did a convention ARIA handed an agent help the work?

WHY. The knowledge graph records that a learned convention entered a
request's envelope: ``agent_invocations`` stamps
``established_knowledge.conventions[].pattern_id`` on the request row at
mint, because the prompt hash is sealed over it. Nothing ever joined that use
to what the work became, so "ARIA learns" could be neither shown nor refuted:
a convention that steered every agent wrong would keep being served at the
same confidence as one that helped.

WHAT. :func:`measure_convention_lift` joins every request to an OUTCOME and
compares, per convention, the requests that carried it with the requests of
the same role and path family that carried no convention:

* the outcome of a request is the change-outcome verdict of the change it
  produced (``implementation_ids.change_id`` -> ``change_outcome``:
  ``gain_confirmed`` is a success, ``regression`` and ``no_gain`` failures),
  else the verdict on the work itself (``derive_request_states``: ACCEPTED a
  success; REJECTED and a permanently unbridgeable acceptance failures). A
  request still in flight, or one that died of queue mechanics
  (``REMINT_ELIGIBLE_DEAD_STATES``: stale lease, stale anchor, cancelled,
  parked for a person), has no outcome and is counted as undecided;
* the baseline of a stratum (role, path family) is its convention-free
  requests with an outcome; a convention's lift is the difference between
  its success rate and the baseline's, standardised over the strata it was
  used in (each stratum weighted by the convention's requests there), and a
  stratum with no baseline contributes nothing;
* below ``MIN_CONVENTION_SAMPLES`` matched requests a convention gets
  ``undecided:insufficient_samples``, never a number; a store with no
  convention-bearing request says so instead of reporting a lift of 0; and a
  ledger that cannot be read is named (``undecided:ledger_unreadable``),
  never shown as an empty measurement (the HIGH-108 doctrine).

WHAT IT IS NOT. Observational: it reports association, not cause, and it
changes nothing. Coupling a negative lift to faster decay or to prompt
selection changes how ARIA learns; that is the operator's decision, recorded
on the finding, and nothing here reads the lift back.
"""
from __future__ import annotations

from collections import defaultdict
from pathlib import Path
from typing import Any

from .agent_invocations import _knowledge_paths, derive_request_states
from .change_outcome import list_change_outcomes
from .ledger import LedgerIntegrityError, load_segments
from .tool_registry import ensure_tools_dir

CONVENTION_LIFT_SCHEMA = "aria/convention-lift/v1"
# The fewest matched requests at which a convention's direction is reported.
# Small on purpose: this is a measurement the operator reads, never a gate
# that acts on the number, and live stores hold few convention-bearing
# requests (0 of 1,614 on aria/state 8e39b2eeb).
MIN_CONVENTION_SAMPLES = 3
_SUCCESS_STATES = frozenset({"ACCEPTED"})
_FAILURE_STATES = frozenset({"REJECTED", "ACCEPTED_PENDING_BRIDGE_PERMANENT_FAIL"})
_SUCCESS_VERDICTS = frozenset({"gain_confirmed"})
_FAILURE_VERDICTS = frozenset({"regression", "no_gain"})
# What a reader of the three ledgers raises when a ledger cannot be read:
# a broken chain, an unreadable file, a row that is not JSON. A programming
# error is not among them and propagates.
_READER_FAULTS: tuple[type[BaseException], ...] = (LedgerIntegrityError, OSError, ValueError)


def _load_requests(root: Path) -> list[dict[str, Any]]:
    return load_segments(root, "agent_invocation_requests")


def _conventions_of(request: dict[str, Any]) -> list[str]:
    knowledge = request.get("established_knowledge")
    conventions = knowledge.get("conventions") if isinstance(knowledge, dict) else None
    return sorted({
        str(item["pattern_id"])
        for item in conventions or []
        if isinstance(item, dict) and isinstance(item.get("pattern_id"), str) and item["pattern_id"]
    })


def _stratum(request: dict[str, Any]) -> str:
    """(role, path family): the request's role and the first two segments of
    each path it concerns — the same paths the convention lookup was keyed by
    (``agent_invocations._knowledge_paths``)."""
    families = sorted({
        "/".join(path.split("/")[:2])
        for path in _knowledge_paths(request.get("evidence_refs"), request.get("allowed_scope"))
    })
    return f"{request.get('role') or 'unknown'}|{'+'.join(families) or 'none'}"


def _outcome(request: dict[str, Any], state: str | None, verdicts: dict[str, str]) -> bool | None:
    """True (success), False (failure) or None (no outcome yet)."""
    ids = request.get("implementation_ids")
    change_id = ids.get("change_id") if isinstance(ids, dict) else None
    verdict = verdicts.get(str(change_id)) if change_id else None
    if verdict in _SUCCESS_VERDICTS:
        return True
    if verdict in _FAILURE_VERDICTS:
        return False
    if state in _SUCCESS_STATES:
        return True
    if state in _FAILURE_STATES:
        return False
    return None


def measure_convention_lift(*, base_dir: str | Path | None = None) -> dict[str, Any]:
    """Per convention: its requests' success rate against the matched baseline."""
    root = ensure_tools_dir(base_dir)
    try:
        requests = _load_requests(root)
        states = derive_request_states(base_dir=root)
        verdicts = {
            str(row.get("change_id")): str(row.get("verdict"))
            for row in list_change_outcomes(base_dir=root)
            if row.get("change_id")
        }
    except _READER_FAULTS as exc:
        return {
            "$schema": CONVENTION_LIFT_SCHEMA,
            "status": "undecided:ledger_unreadable",
            "reason": f"{type(exc).__name__}: {str(exc)[:300]}",
            "conventions": [],
        }

    baseline: dict[str, list[bool]] = defaultdict(list)
    used: dict[str, dict[str, list[bool]]] = defaultdict(lambda: defaultdict(list))
    undecided: dict[str, int] = defaultdict(int)
    bearing = 0
    for request in requests:
        request_id = str(request.get("request_id") or "")
        if not request_id:
            continue
        conventions = _conventions_of(request)
        bearing += bool(conventions)
        outcome = _outcome(request, states.get(request_id), verdicts)
        if outcome is None:
            for pattern_id in conventions:
                undecided[pattern_id] += 1
            continue
        stratum = _stratum(request)
        if not conventions:
            baseline[stratum].append(outcome)
        for pattern_id in conventions:
            used[pattern_id][stratum].append(outcome)

    if not bearing:
        return {
            "$schema": CONVENTION_LIFT_SCHEMA,
            "status": "no_convention_bearing_requests",
            "requests_considered": len(requests),
            "convention_bearing_requests": 0,
            "conventions": [],
            "baselines": _baseline_view(baseline),
        }
    rows = [
        _convention_row(pattern_id, used.get(pattern_id, {}), baseline, undecided.get(pattern_id, 0))
        for pattern_id in sorted(set(used) | set(undecided))
    ]
    return {
        "$schema": CONVENTION_LIFT_SCHEMA,
        "status": "measured",
        "min_samples": MIN_CONVENTION_SAMPLES,
        "requests_considered": len(requests),
        "convention_bearing_requests": bearing,
        "conventions": rows,
        "baselines": _baseline_view(baseline),
    }


def _baseline_view(baseline: dict[str, list[bool]]) -> dict[str, dict[str, int]]:
    return {
        stratum: {"n": len(outcomes), "successes": sum(outcomes)}
        for stratum, outcomes in sorted(baseline.items())
    }


def _convention_row(
    pattern_id: str,
    strata: dict[str, list[bool]],
    baseline: dict[str, list[bool]],
    undecided: int,
) -> dict[str, Any]:
    outcomes = [outcome for stratum in strata.values() for outcome in stratum]
    matched = {stratum: values for stratum, values in strata.items() if baseline.get(stratum)}
    matched_n = sum(len(values) for values in matched.values())
    measured = matched_n >= MIN_CONVENTION_SAMPLES
    lift = (
        round(
            sum(
                len(values) * (sum(values) / len(values) - sum(baseline[stratum]) / len(baseline[stratum]))
                for stratum, values in matched.items()
            ) / matched_n,
            4,
        )
        if measured else None
    )
    baseline_rate = (
        round(
            sum(len(values) * sum(baseline[stratum]) / len(baseline[stratum]) for stratum, values in matched.items())
            / matched_n,
            4,
        )
        if measured else None
    )
    return {
        "pattern_id": pattern_id,
        "status": "measured" if measured else "undecided:insufficient_samples",
        "n": len(outcomes),
        "matched_n": matched_n,
        "undecided_requests": undecided,
        "success_rate": round(sum(outcomes) / len(outcomes), 4) if outcomes else None,
        "baseline_rate": baseline_rate,
        "lift": lift,
        "strata": len(strata),
        "matched_strata": len(matched),
    }


__all__ = [
    "CONVENTION_LIFT_SCHEMA",
    "MIN_CONVENTION_SAMPLES",
    "measure_convention_lift",
]
