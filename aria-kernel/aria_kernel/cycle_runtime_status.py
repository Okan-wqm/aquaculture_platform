"""A tool failure is a TOOL status, not a cycle integrity failure (ARIA-HIGH-098).

WHY. ``cycle._runtime_status`` returned ``integrity_failed`` for ANY non-ok
tool run, and the autonomy orchestrator fails closed on that verdict. On
2026-09-04 ``test-gap-adapter`` overran its budget by 651 ms and the morning
never planned; on 2026-09-12 (trial eleven, ``cyc-20260912T221237Z-auto``)
``agent-harness-security-adapter`` returned ``evidence_error`` — its 48
findings lacked the per-finding ``evidence`` list — nine of ten tools were
``ok``, the artifact index verified 10/10, the plan in the store was
CONVERGED, and after 40 minutes the run ended ``cycle_failed``: the funnel
counter, the knowledge signer, the memory hook and the V9 implementation
phase never ran. One adapter's contract slip was priced as the store being
untrustworthy, which it was not.

WHAT. One rule, read by every producer and projection of a cycle's verdict
(``cycle``, ``runtime_artifacts``, ``autonomy_orchestrator``):

* ``integrity_failed`` — the STORE cannot be trusted: the artifact index
  did not verify, or a run's own artifact is missing / mismatched / never
  written (``INTEGRITY_ARTIFACT_STATUSES``, or the run status
  ``integrity_failed`` that ``tool_health.record_run`` assigns on a failed
  artifact write). The orchestrator fails closed on this and only this.
* ``degraded`` — the index is valid and at least one tool run is non-ok
  (``budget_exceeded``, ``evidence_error``, ``crash``, ``schema_error``,
  ``scope_violation``, ``tool_unhealthy``, ``environment_unavailable``).
  The tool's raw findings are already quarantined by ``feedback_store``
  (``invalid_evidence``) and the tool itself by ``tool_health``; the cycle
  records the tool and its class and continues. ``observability`` has
  admitted ``degraded`` as a cycle-metrics status since before this
  module; nothing produced it.
* ``failed`` — a phase raised or declared itself failed; unchanged.
* ``ok`` — nothing above.

The class a degraded tool is recorded with is the run status itself, or
``artifact_missing`` when the run's artifact — not the tool — is what
failed. ``tool_degradation`` turns N consecutive degraded cycles of one
tool into a HUMAN_REQUIRED record so a permanently broken adapter is never
quietly tolerated.
"""
from __future__ import annotations

from typing import Any, Mapping

RUNTIME_OK = "ok"
RUNTIME_DEGRADED = "degraded"
RUNTIME_INTEGRITY_FAILED = "integrity_failed"
RUNTIME_FAILED = "failed"
RUNTIME_STATUSES: tuple[str, ...] = (
    RUNTIME_OK, RUNTIME_DEGRADED, RUNTIME_INTEGRITY_FAILED, RUNTIME_FAILED,
)

# A run whose artifact is in one of these states has lost its evidence —
# that is a store fault, whatever the tool did. Mirrors the set
# ``runtime_artifacts.autonomy_output_summary`` re-labels ``integrity_failed``.
INTEGRITY_ARTIFACT_STATUSES: frozenset[str] = frozenset({"missing", "hash_mismatch", "write_failed"})
ARTIFACT_MISSING_CLASS = "artifact_missing"


def tool_run_degradation_class(run: Mapping[str, Any]) -> str | None:
    """None for an ok run with a present artifact; otherwise the class it is recorded under."""
    if str(run.get("artifact_status") or "") in INTEGRITY_ARTIFACT_STATUSES:
        return ARTIFACT_MISSING_CLASS
    status = str(run.get("status") or "")
    if status == RUNTIME_OK:
        return None
    return status or "unknown"


def is_integrity_class(run: Mapping[str, Any]) -> bool:
    """Does this non-ok run indict the STORE rather than the tool?"""
    return tool_run_degradation_class(run) in {ARTIFACT_MISSING_CLASS, RUNTIME_INTEGRITY_FAILED}


def non_ok_runs(run_summary: list[Mapping[str, Any]] | None) -> list[dict[str, Any]]:
    """Every run that is not an ok run with a present artifact."""
    return [dict(run) for run in (run_summary or []) if tool_run_degradation_class(run) is not None]


def runtime_status(
    *,
    phase_failed: bool,
    integrity_valid: bool,
    non_ok: list[Mapping[str, Any]],
) -> str:
    """The cycle's runtime verdict from its three facts."""
    if phase_failed:
        return RUNTIME_FAILED
    if not integrity_valid or any(is_integrity_class(run) for run in non_ok):
        return RUNTIME_INTEGRITY_FAILED
    if non_ok:
        return RUNTIME_DEGRADED
    return RUNTIME_OK


def degraded_tool_records(non_ok: list[Mapping[str, Any]]) -> list[dict[str, Any]]:
    """The per-tool record a degraded cycle carries: who, which run, which class."""
    records: list[dict[str, Any]] = []
    for run in non_ok:
        records.append({
            "tool_id": run.get("tool_id"),
            "run_id": run.get("run_id"),
            "status": run.get("status"),
            "artifact_status": run.get("artifact_status"),
            "degradation_class": tool_run_degradation_class(run),
            "integrity_class": is_integrity_class(run),
        })
    return records


__all__ = [
    "ARTIFACT_MISSING_CLASS",
    "INTEGRITY_ARTIFACT_STATUSES",
    "RUNTIME_DEGRADED",
    "RUNTIME_FAILED",
    "RUNTIME_INTEGRITY_FAILED",
    "RUNTIME_OK",
    "RUNTIME_STATUSES",
    "degraded_tool_records",
    "is_integrity_class",
    "non_ok_runs",
    "runtime_status",
    "tool_run_degradation_class",
]
