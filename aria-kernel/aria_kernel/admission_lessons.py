"""ARIA-HIGH-370 — kernel-attributed failure modes gate candidate admission.

WHY. The 2026-10-06 loop RCA (blocker 7) measured a planner that re-admitted
the same candidate after every failure, and nothing between the record of
those failures and the next admission read them. The lesson reader
(ARIA-HIGH-309) tells the NEXT PLANNER what failed; it cannot stop the
synthesizer from minting the identical plan again.

WHAT. :func:`admission_verdict` judges a converted candidate before it is
admitted, against :class:`AdmissionHistory` (the plan ledger and procedural
memory, read ONCE per synthesis).

Identity — what the candidate is about, stable across the facts that change
between attempts (review of #1829, HIGH-3):

* failing CI: the workflow file and the failing ``job::step`` signature
  (``plan_content.failing_signature``, written by the synthesizer). The run
  id is provenance (``provenance_refs``) since #1731 and is not identity;
* an F finding: its ARIA-HIGH-363 subject (``finding_subject_key``), so the
  re-seeded refs of #1826 and a sibling finding of the same subject are the
  same candidate; a finding without a subject is itself;
* anything else: the grounds of its evidence refs (path before the line).

Refusal — the last :data:`LESSON_EPISODE_THRESHOLD` episodes of earlier
plans with that identity, counting only failures attributed to the PLAN
(attribution role ``drafter``) and successes, all failed in one mode. A
challenger's or critic's refused output is that agent's lesson, never a
reason to refuse the drafter's candidate. Unattributed episodes are skipped.

Half-open breaker — a refused identity is re-admitted for ONE probe when
:data:`PROBE_INTERVAL` has passed since its newest counted failure, or when
the gate epoch (``attribution_void.gate_epoch``) differs from the one that
failure was recorded under: the gate that refused it may have changed. A
probe that fails the same way closes the breaker for another interval.
Second review of #1829 (M5): the probe is RECORDED (``admission/probes.jsonl``,
:func:`record_probe`); a probe that died unattributed would otherwise leave
the verdict at "probe" every cycle. A second probe needs ``PROBE_INTERVAL``
since the first or a gate epoch the first was not granted under.

An identity that cannot be known — a failing-CI plan without
``failing_signature`` because gh returned no job data (M4) — is never counted
and never refused.

Composition with #1826 (``plan_slot_policy``): the slot policy cools a red
workflow for three days after ANY failed plan and the F loop guards cool a
subject after any failure; this brake engages only on a RECURRING attributed
mode, after the slot policy has ordered the candidates, and holds the
identity until the probe interval or a gate change.
"""
from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Mapping

from .agent_eval import LESSON_EPISODE_THRESHOLD, list_performance_observations
from .ledger import load_declared_jsonl
from .tool_registry import ensure_tools_dir_readonly, parse_utc_stamp

RECURRING_ATTRIBUTED_FAILURE = "recurring_attributed_failure"
RECURRING_FAILURE_PROBE = "recurring_attributed_failure_probe"
#: Seven days: two of the slot policy's three-day failing-CI cool-offs plus
#: one, so a refused identity is retried at most weekly.
PROBE_INTERVAL = timedelta(days=7)
PROBES_PATH = Path("admission") / "probes.jsonl"
PROBES_SURFACE = "admission_probes"


def _grounds(refs: Any) -> list[str]:
    return sorted({str(ref).split(":", 1)[0].strip() for ref in refs}) if isinstance(refs, list) else []


def candidate_identity(
    plan_content: Mapping[str, Any], findings: Mapping[str, Mapping[str, Any]] | None,
) -> str | None:
    """What a plan is about; None when it cannot be known (see the module docstring)."""
    from .finding_subject import finding_subject_key

    signature = plan_content.get("failing_signature")
    finding = plan_content.get("finding_id")
    provenance = plan_content.get("provenance_refs")
    red_run = isinstance(provenance, list) and any(str(ref).startswith("gh-run-list:") for ref in provenance)
    if red_run and not (isinstance(signature, Mapping) and signature.get("failed")):
        return None
    if isinstance(signature, Mapping):
        canonical: list[Any] = ["failing_ci", signature.get("workflow_path"), sorted(signature.get("failed") or [])]
    elif isinstance(finding, str) and finding.strip():
        key = finding_subject_key((findings or {}).get(finding) or {})
        canonical = ["subject", key] if key is not None else ["finding", finding]
    else:
        canonical = ["refs", _grounds(plan_content.get("evidence_refs"))]
    return "sha256:" + hashlib.sha256(json.dumps(canonical, sort_keys=True).encode("utf-8")).hexdigest()


@dataclass(frozen=True)
class AdmissionHistory:
    """Plan identities and drafter episodes, read once per synthesis."""

    identities: Mapping[str, str]
    episodes: tuple[Mapping[str, Any], ...]
    findings: Mapping[str, Mapping[str, Any]] | None
    now: datetime
    probes: tuple[Mapping[str, Any], ...] = ()

    @classmethod
    def load(
        cls, base_dir: str | Path | None, *, findings: Mapping[str, Mapping[str, Any]] | None,
        now: datetime | None = None,
    ) -> "AdmissionHistory":
        from .plan_convergence import events_file

        root = ensure_tools_dir_readonly(base_dir)
        identities: dict[str, str] = {}
        episodes: tuple[Mapping[str, Any], ...] = ()
        probes: tuple[Mapping[str, Any], ...] = ()
        if root is not None:
            ledger = events_file(root)
            rows = load_declared_jsonl(ledger, expected_surface="plan_convergence_events") if ledger.is_file() else []
            for row in rows:
                content = row["payload"].get("plan_content") if row["event_type"] == "plan_started" else None
                identity = candidate_identity(content, findings) if isinstance(content, dict) else None
                if identity is not None:
                    identities[str(row["plan_id"])] = identity
            episodes = tuple(row for row in list_performance_observations(base_dir=root) if row["role"] == "drafter")
            probe_path = root / PROBES_PATH
            if probe_path.is_file():
                probes = tuple(load_declared_jsonl(probe_path, expected_surface=PROBES_SURFACE))
        return cls(identities, episodes, findings, now or datetime.now(timezone.utc), probes)


def _counted(row: Mapping[str, Any]) -> bool:
    """A success, or a failure the evidence attributed to the plan itself."""
    if row["success"]:
        return True
    return bool(row["attributable"]) and str((row.get("attribution") or {}).get("role") or row["role"]) == "drafter"


def admission_verdict(
    history: AdmissionHistory, plan_content: Mapping[str, Any], *, threshold: int = LESSON_EPISODE_THRESHOLD,
) -> dict[str, Any] | None:
    """None when no recorded lesson bears on the candidate; else the lesson
    with ``reason`` :data:`RECURRING_ATTRIBUTED_FAILURE` (refuse) or
    :data:`RECURRING_FAILURE_PROBE` (the breaker's one half-open admission)."""
    from .attribution_void import gate_epoch

    identity = candidate_identity(plan_content, history.findings)
    if identity is None:
        return None
    same = {plan for plan, other in history.identities.items() if other == identity}
    window = [row for row in history.episodes if row["plan_id"] in same and _counted(row)][-threshold:]
    if len(window) < threshold or any(row["success"] for row in window):
        return None
    modes = {str(row["failure_mode"]) for row in window}
    if len(modes) != 1:
        return None
    newest = window[-1]
    failed_at = parse_utc_stamp(str(newest.get("occurred_at") or ""))
    epoch = newest.get("gate_epoch")
    probe_at = failed_at + PROBE_INTERVAL if failed_at is not None else None
    if probe_at is not None and history.now >= probe_at:
        reason, why = RECURRING_FAILURE_PROBE, "probe_interval_elapsed"
    elif isinstance(epoch, str) and epoch != gate_epoch():
        reason, why = RECURRING_FAILURE_PROBE, "gate_epoch_changed"
    else:
        reason, why = RECURRING_ATTRIBUTED_FAILURE, "breaker_open"
    if reason == RECURRING_FAILURE_PROBE and _probe_spent(history, identity, failed_at):
        reason, why = RECURRING_ATTRIBUTED_FAILURE, "probe_spent"
    return {
        "reason": reason, "breaker": why, "candidate_identity": identity, "failure_mode": modes.pop(),
        "episodes": len(window), "plan_ids": [str(row["plan_id"]) for row in window],
        "probe_after": probe_at.isoformat() if probe_at is not None else None,
    }


def _probe_spent(history: AdmissionHistory, identity: str, failed_at: datetime | None) -> bool:
    """A probe was granted after the newest failure, inside its interval, under this epoch."""
    from .attribution_void import gate_epoch

    for row in reversed(history.probes):
        granted = parse_utc_stamp(str(row.get("admitted_at") or ""))
        if row.get("candidate_identity") != identity or granted is None:
            continue
        if failed_at is not None and granted < failed_at:
            return False
        return history.now < granted + PROBE_INTERVAL and row.get("gate_epoch") == gate_epoch()
    return False


def record_probe(*, base_dir: str | Path, lesson: Mapping[str, Any], cycle_id: str) -> dict[str, Any]:
    """Record the one half-open probe the breaker granted."""
    from .attribution_void import gate_epoch
    from .ledger import append_declared_jsonl
    from .tool_registry import ensure_tools_dir, utc_now

    path = ensure_tools_dir(base_dir) / PROBES_PATH
    path.parent.mkdir(parents=True, exist_ok=True)
    return append_declared_jsonl(path, {
        "schema_version": 1, "candidate_identity": lesson["candidate_identity"], "breaker": lesson["breaker"],
        "plan_ids": list(lesson["plan_ids"]), "admitted_at": utc_now(), "gate_epoch": gate_epoch(),
        "cycle_id": cycle_id,
    }, expected_surface=PROBES_SURFACE)


__all__ = [
    "PROBE_INTERVAL", "RECURRING_ATTRIBUTED_FAILURE", "RECURRING_FAILURE_PROBE", "AdmissionHistory",
    "admission_verdict", "candidate_identity", "record_probe",
]
