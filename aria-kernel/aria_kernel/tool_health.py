from __future__ import annotations

import fnmatch
import json
from collections.abc import Mapping
import dataclasses
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

from .feedback_store import (
    _judgment_key,
    consensus_judge_count,
    load_feedback,
    mark_findings_need_revalidation,
    raw_findings_path,
    record_findings_for_run,
    record_raw_findings_for_run,
)
from .impact_graph import project_map
from .ledger import append_declared_jsonl, append_jsonl as append_chained_jsonl, load_jsonl as load_chained_jsonl
from .ledger_inline import sample_inline_list, spill_evidence_validation
from .quarantine import quarantine_tool
from .runs_reader import READ_PATHS_REF_FIELD, read_paths_reference, read_runs_rows, run_read_paths
from .runtime_artifacts import (
    append_run_by_cycle,
    run_ledger_format,
    write_run_artifact,
)
from .artifact_safety import scrub_json
from .canonical_path import lexical_repo_path, matches_repo_glob
from .evidence_trust import SELF_OUTPUT_PREFIXES
from .tool_registry import GovernanceError, ensure_tools_dir, get_tool, update_tool, utc_now
from .tool_registry import append_tools_governance, update_tools_index


RUN_STATUSES = (
    "ok",
    "schema_error",
    "scope_violation",
    "evidence_error",
    "crash",
    "budget_exceeded",
    "tool_unhealthy",
    "integrity_failed",
    # An environment fault: the workspace could not run the tool at all.
    # Deliberately NOT in the quarantine trigger — it is the harness's
    # failure, and repetition escalates through the uncertainty ledger
    # instead (uncertainty_repeat).
    "environment_unavailable",
)
REQUIRED_RUN_FIELDS = (
    "run_id",
    "tool_id",
    "cycle_id",
    "status",
    "input_hash",
    "output_hash",
    "read_paths",
    "emitted_observations",
    "emitted_findings",
    "evidence_validation",
    "operator_feedback_refs",
    "duration_ms",
    "cost_units",
    "schema_version",
)
# Plan 022 §C-7 / §C-8 — split the pre-fix blanket forbidden tuple into
# two tiers so an explicit `allowed_read_globs` opt-in can lift the soft
# default-deny without weakening the hard sandbox-escape protections.
#
# HARD_FORBIDDEN_READ_GLOBS — non-overridable. A tool MAY NOT read these
# even with an explicit allow entry. Intent: protect git internals and
# secrets from any adapter-side mistake or compromise.
HARD_FORBIDDEN_READ_GLOBS = (
    ".git/**",
    "secrets/**",
    ".env",
    ".env.*",
)
# DEFAULT_DENY_READ_GLOBS — soft deny. A tool MAY read these only when an
# explicit allow pattern lifts the default. Intent: agent self-output,
# generated artifacts, and node_modules-style noise that should be opt-in
# but not always blocked.
DEFAULT_DENY_READ_GLOBS = (
    ".claude/**",
    "agent-workspace/**",
    ".aria-poc/**",
    "aria-tools/**",
    "node_modules/**",
    "dist/**",
    "coverage/**",
    "build/**",
    "tmp/**",
)
# Backwards-compat alias for any external importer (no in-repo importer
# per grep, but defensive). Equivalent to the pre-fix tuple ordering.
DEFAULT_FORBIDDEN_READ_GLOBS = HARD_FORBIDDEN_READ_GLOBS + DEFAULT_DENY_READ_GLOBS
SELF_OUTPUT_MARKERS = SELF_OUTPUT_PREFIXES


# ARIA-HIGH-017 — what a runs.jsonl reader is told about a parsed-output field
# the row bounded: where its whole value is recovered (ledger_inline's digest
# stubs and sample markers name it).
RUNS_ROW_RECOVERY = "the full value persists in this run's runtime artifact (parsed_output)"
# ARIA-HIGH-617 — what the bounded evidence_validation tells its reader. It is
# bounded before the artifact is written from it, so the artifact holds the
# same bounded object, and v1 or a failed write leaves no artifact at all: the
# whole value is rebuilt from the output, never read back.
EVIDENCE_VALIDATION_RECOVERY = (
    "rebuild with evidence_validator.validate_tool_output_evidence over the run "
    "artifact's payload.parsed_output at payload.repo_snapshot when artifact_status "
    "is present; otherwise only the total and digest survive"
)


def runs_path(base_dir: str | Path | None = None) -> Path:
    return ensure_tools_dir(base_dir) / "runs.jsonl"


def health_path(base_dir: str | Path | None = None) -> Path:
    return ensure_tools_dir(base_dir) / "health.jsonl"


def calibration_path(base_dir: str | Path | None = None) -> Path:
    return ensure_tools_dir(base_dir) / "calibration.jsonl"


@dataclass(frozen=True)
class RecordedRun:
    """What ``record_run`` stored, by value.

    ``row`` is the runs.jsonl row exactly as appended (ledger hash included).
    ``validate_run_envelope`` works on a COPY of the caller's envelope and the
    store may downgrade that copy (``scope_violation``, ``evidence_error``,
    ``integrity_failed``), so the caller's own dict is never what was stored:
    a caller that judged the run by it read a status the store never held
    (ARIA-MEDIUM-516). Returning the stored row is the only way a caller sees
    a run, so it can only see the recorded one.
    """

    row: dict[str, Any]
    health_decision: dict[str, Any]


def record_run(
    run: dict[str, Any],
    base_dir: str | Path | None = None,
) -> RecordedRun:
    envelope = validate_run_envelope(run)
    tool = get_tool(envelope["tool_id"], base_dir)
    emission_count = _count(envelope["emitted_observations"]) + _count(envelope["emitted_findings"])
    if emission_count and not can_emit_operator_facing(envelope["tool_id"], base_dir=base_dir):
        raise GovernanceError(
            f"{tool['status']} tool cannot emit operator-facing observations or findings",
        )
    # SE-1-R2 appellate R4 — the map the run's findings are attributed
    # against is resolved BEFORE the first write of the run (artifact, run
    # row, run-by-cycle index, raw findings). A store that cannot attribute
    # (`service_key_map_unavailable`, `project_manifest_unreadable`) refuses
    # the whole run by name here; resolved after the appends, the refusal
    # left a run claiming N emitted findings that findings.jsonl never got,
    # and no health decision.
    emitted_findings = list(envelope["emitted_findings"]) if isinstance(envelope["emitted_findings"], list) else []
    project_roots = project_map(base_dir=base_dir) if emitted_findings else None

    scope_violations = find_scope_violations(tool, envelope["read_paths"])
    if scope_violations and envelope["status"] == "ok":
        envelope["status"] = "scope_violation"
        envelope["scope_violations"] = scope_violations
    if envelope["status"] == "ok" and envelope["evidence_validation"].get("valid") is False:
        envelope["status"] = "evidence_error"
    # ARIA-HIGH-617 — scrubbed, then bounded, once, before the artifact and
    # the row are written from it: evidence_validation echoes the adapter's
    # own entries (reported paths, finding and belief ids, evidence sources),
    # and the scrub's marker is longer than the shortest credential shapes, so
    # a bound taken before the scrub did not hold on the row.
    envelope["evidence_validation"] = spill_evidence_validation(
        scrub_json(envelope["evidence_validation"]), recovery=EVIDENCE_VALIDATION_RECOVERY,
    )

    raw_findings = envelope.pop("raw_findings", None)
    artifact_payload = envelope.pop("_runtime_artifact_payload", None)
    ledger_format = run_ledger_format(base_dir)
    if ledger_format in ("v2-shadow", "v2"):
        artifact = write_run_artifact(
            base_dir=base_dir,
            run_id=envelope["run_id"],
            cycle_uid=envelope["cycle_id"],
            tool_id=envelope["tool_id"],
            kind="tool_run",
            run_status=envelope["status"],
            repo_state_id=(envelope.get("repo_snapshot") or {}).get("repo_state_id") if isinstance(envelope.get("repo_snapshot"), dict) else None,
            payload=_runtime_artifact_payload(envelope, raw_findings, artifact_payload),
        )
        envelope["schema_version"] = 2
        envelope["run_ledger_format"] = ledger_format
        envelope["artifact_ref"] = artifact.get("artifact_ref")
        envelope["artifact_refs"] = [artifact["artifact_ref"]] if isinstance(artifact.get("artifact_ref"), dict) else []
        envelope["artifact_hash"] = artifact.get("artifact_hash")
        envelope["artifact_status"] = artifact.get("artifact_status")
        envelope["artifact_error"] = artifact.get("artifact_error")
        if artifact.get("artifact_status") != "present":
            envelope["status"] = "integrity_failed"
            envelope.setdefault("evidence_validation", {}).setdefault("errors", []).append(
                {
                    "code": "run_artifact_write_failed",
                    "artifact_id": artifact.get("artifact_id"),
                    "error": artifact.get("artifact_error"),
                },
            )
            envelope["evidence_validation"]["valid"] = False
        if ledger_format == "v2":
            runner = envelope.get("runner")
            if isinstance(runner, dict):
                runner.pop("raw_findings_sample", None)
    else:
        envelope["artifact_status"] = "legacy_inline_or_sample_only"
    # ORPHAN-HIGH-798 — the runs.jsonl row carried emitted_observations and
    # emitted_findings arrays inline. In v2/v2-shadow (the formats that write
    # an artifact above), the artifact already contains the full payload via
    # _runtime_artifact_payload; the row only needs the counts. v1 writes NO
    # artifact, so stripping the arrays there would lose the observation
    # content entirely (adversarial review caught this) — v1 keeps them.
    # The arrays for record_findings_for_run were copied above (before the
    # artifact write), so they are stripped from the row here only when the
    # artifact exists.
    envelope["emitted_counts"] = {
        "observations": _count(envelope.get("emitted_observations")),
        "findings": _count(envelope.get("emitted_findings")),
    }
    if ledger_format in ("v2-shadow", "v2"):
        envelope.pop("emitted_observations", None)
        envelope.pop("emitted_findings", None)
    run_row = append_jsonl(runs_path(base_dir), {"recorded_at": utc_now(), **_ledger_row_fields(envelope)})
    if ledger_format in ("v2-shadow", "v2"):
        append_run_by_cycle(base_dir=base_dir, cycle_uid=envelope["cycle_id"], run_row=run_row)
    record_raw_findings_for_run(envelope, raw_findings, base_dir=base_dir)
    if project_roots is not None:
        record_findings_for_run(
            envelope, emitted_findings=emitted_findings, project_roots=project_roots, base_dir=base_dir,
        )
    decision = evaluate_health(envelope["tool_id"], base_dir=base_dir, latest_run=envelope)
    append_jsonl(health_path(base_dir), decision)
    if envelope["status"] == "tool_unhealthy":
        append_tools_governance(
            ensure_tools_dir(base_dir),
            "tool_unhealthy",
            {"tool_name": envelope["tool_id"], "reason": envelope.get("runner", {}).get("stderr_sample", "tool unhealthy")},
        )
    update_tools_index(ensure_tools_dir(base_dir))
    return RecordedRun(row=run_row, health_decision=decision)


def validate_run_envelope(run: dict[str, Any]) -> dict[str, Any]:
    if not isinstance(run, dict):
        raise GovernanceError("run envelope must be a JSON object")
    missing = [field for field in REQUIRED_RUN_FIELDS if field not in run]
    if missing:
        raise GovernanceError(f"run envelope missing required field(s): {', '.join(missing)}")
    candidate = dict(run)
    for field in ("run_id", "tool_id", "cycle_id", "input_hash", "output_hash"):
        if not isinstance(candidate[field], str) or not candidate[field].strip():
            raise GovernanceError(f"{field} must be a non-empty string")
    if candidate["status"] not in RUN_STATUSES:
        raise GovernanceError(f"unknown run status: {candidate['status']}")
    if not isinstance(candidate["read_paths"], list):
        raise GovernanceError("read_paths must be an array")
    if not isinstance(candidate["evidence_validation"], dict):
        raise GovernanceError("evidence_validation must be an object")
    if not isinstance(candidate["operator_feedback_refs"], list):
        raise GovernanceError("operator_feedback_refs must be an array")
    if not isinstance(candidate["duration_ms"], (int, float)) or candidate["duration_ms"] < 0:
        raise GovernanceError("duration_ms must be a non-negative number")
    if not isinstance(candidate["cost_units"], (int, float)) or candidate["cost_units"] < 0:
        raise GovernanceError("cost_units must be a non-negative number")
    return candidate


def evaluate_health(
    tool_id: str,
    *,
    base_dir: str | Path | None = None,
    latest_run: dict[str, Any] | None = None,
) -> dict[str, Any]:
    tool = get_tool(tool_id, base_dir)
    runs = list(read_runs_rows(runs_path(base_dir), tool_id=tool_id, base_dir=Path(base_dir) if base_dir is not None else None))
    latest = latest_run or (runs[-1] if runs else None)
    decision = {
        "schema_version": 1,
        "at": utc_now(),
        "tool_id": tool_id,
        "status": tool["status"],
        "action": "none",
        "reason": "no health transition required",
        "metrics": compute_metrics(tool, runs, base_dir=base_dir),
    }
    if latest is None:
        return decision

    quarantine_reason = immediate_quarantine_reason(tool, latest, base_dir=base_dir)
    if quarantine_reason is None:
        metrics = compute_metrics(tool, runs, base_dir=base_dir)
        if metrics["critical_false_positives"] > tool["health_thresholds"]["critical_false_positives"]:
            quarantine_reason = "operator-confirmed critical false positive"
    if quarantine_reason:
        updated = quarantine_tool(tool_id, quarantine_reason, base_dir=base_dir, run_id=latest["run_id"])
        revalidation_count = mark_findings_need_revalidation(tool_id, base_dir=base_dir)
        decision.update(
            {
                "status": updated["status"],
                "action": "quarantine",
                "reason": quarantine_reason,
                "metrics": compute_metrics(updated, list(read_runs_rows(runs_path(base_dir), tool_id=tool_id, base_dir=Path(base_dir) if base_dir is not None else None)), base_dir=base_dir),
                "revalidation_required": revalidation_count,
            },
        )
        return decision

    calibrate_reason = auto_calibrate_reason(tool, runs, base_dir=base_dir)
    if calibrate_reason and tool["status"] not in ("CALIBRATE", "QUARANTINED"):
        # Plan 022 §C-2b — kernel-internal auto-transition. tool_health is
        # the audited health-monitor; it owns the auto-calibrate decision
        # and writes via _update_tool_internal so the public update_tool()
        # status guard does not self-block this trusted path.
        from .tool_registry import _update_tool_internal
        updated = _update_tool_internal(
            tool_id,
            {
                "status": "CALIBRATE",
                "last_transition": {
                    "at": utc_now(),
                    "from": tool["status"],
                    "to": "CALIBRATE",
                    "reason": calibrate_reason,
                },
            },
            base_dir,
        )
        append_jsonl(
            calibration_path(base_dir),
            {
                "schema_version": 1,
                "at": utc_now(),
                "tool_id": tool_id,
                "reason": calibrate_reason,
                "previous_status": tool["status"],
                "status": "CALIBRATE",
            },
        )
        decision.update(
            {
                "status": updated["status"],
                "action": "calibrate",
                "reason": calibrate_reason,
                "metrics": compute_metrics(updated, runs, base_dir=base_dir),
            },
        )
    return decision


def can_emit_operator_facing(
    tool_id: str,
    *,
    base_dir: str | Path | None = None,
) -> bool:
    return get_tool(tool_id, base_dir)["status"] == "ACTIVE"


# ARIA-HIGH-617 — how many scope violations a runs row carries inline when its
# artifact holds the whole list (``payload.scope_violations``).
_SCOPE_VIOLATIONS_ROW_SAMPLE = 20
SCOPE_VIOLATIONS_POINTER = "/payload/scope_violations"


def _ledger_row_fields(envelope: dict[str, Any]) -> dict[str, Any]:
    """The run as runs.jsonl stores it: its read-set lists bounded by bytes in every format.

    ARIA-HIGH-523 — the read set is the one repository-sized field of a run
    row, and the artifact written above already holds it
    (``_runtime_artifact_payload`` → ``payload.read_paths``, stored scrubbed,
    so the address is taken over the scrubbed list). Only a present artifact
    can stand in for a list by reference. The envelope itself keeps the list:
    the health check below judges it in memory, before any reader could
    resolve the artifact.

    ARIA-HIGH-617 — ``read_paths`` is the adapter's own report (bounded only
    by the 12 MiB stdout cap) and ``scope_violations`` is derived from it, so
    an unbounded inline list made the row too large to append (1 MiB cap).
    The append comes before ``evaluate_health``, so the run went unrecorded
    and its tool was never quarantined. Both lists now pass through
    ``ledger_inline.sample_inline_list``, bounded by bytes whatever the
    adapter reported, taken over the scrubbed lists as the artifact stores
    them:

    * a present artifact: ``read_paths_ref`` names the read set, and the row
      keeps the first violations with a marker pointing at
      ``payload.scope_violations``;
    * no artifact (v1 writes none; a failed write, which the adapter itself
      can cause, left none): each list stays whole up to the per-field inline
      budget, as before, and beyond it the row keeps the entries that fit, in
      order, plus a ``digest_only`` marker, since nothing else holds the list.
      Such a run is ``integrity_failed`` (a failed write) or carries
      ``legacy_inline_or_sample_only`` (v1), which declares samples.

    ``evidence_validation`` names the same adapter-reported entries again
    (``read_path_outside_snapshot`` errors carry each path); ``record_run``
    has already scrubbed and then bounded it, the order every list here takes.
    """
    fields = dict(envelope)
    read_paths = scrub_json(fields.pop("read_paths"))
    violations = fields.pop("scope_violations", None)
    if fields.get("artifact_status") == "present" and isinstance(fields.get("artifact_ref"), dict):
        fields[READ_PATHS_REF_FIELD] = read_paths_reference(read_paths)
        if isinstance(violations, list):
            fields.update(sample_inline_list(
                "scope_violations", scrub_json(violations), limit=_SCOPE_VIOLATIONS_ROW_SAMPLE,
                json_pointer=SCOPE_VIOLATIONS_POINTER, recovery="the run artifact holds the whole list at json_pointer",
            ))
        return fields
    unrecoverable = (
        f"no artifact holds the whole list (artifact_status={fields.get('artifact_status')}); "
        "only its total and digest survive"
    )
    fields.update(sample_inline_list("read_paths", read_paths, limit=None, json_pointer=None, recovery=unrecoverable))
    if isinstance(violations, list):
        fields.update(sample_inline_list(
            "scope_violations", scrub_json(violations), limit=None, json_pointer=None, recovery=unrecoverable,
        ))
    return fields


def _runtime_artifact_payload(
    envelope: dict[str, Any],
    raw_findings: Any,
    artifact_payload: Any,
) -> dict[str, Any]:
    payload = artifact_payload if isinstance(artifact_payload, dict) else {}
    return {
        "run_id": envelope.get("run_id"),
        "cycle_id": envelope.get("cycle_id"),
        "tool_id": envelope.get("tool_id"),
        "status": envelope.get("status"),
        "input_hash": envelope.get("input_hash"),
        "output_hash": envelope.get("output_hash"),
        "stdout": payload.get("stdout"),
        "stderr": payload.get("stderr"),
        "parsed_output": payload.get("parsed_output"),
        "raw_observations": payload.get("raw_observations"),
        "raw_findings": raw_findings if isinstance(raw_findings, list) else [],
        "read_paths": envelope.get("read_paths", []),
        # The whole list the runs row samples, at SCOPE_VIOLATIONS_POINTER (ARIA-HIGH-617).
        "scope_violations": envelope.get("scope_violations", []),
        "evidence_validation": envelope.get("evidence_validation"),
        "runner": envelope.get("runner"),
        "repo_snapshot": envelope.get("repo_snapshot"),
        "no_silent_loss": {
            "reason_code": "artifact_backed_runtime_output",
            "truncated": False,
            "summarized": True,
        },
    }


def immediate_quarantine_reason(
    tool: dict[str, Any],
    run: dict[str, Any],
    *,
    base_dir: str | Path | None = None,
) -> str | None:
    # ``run`` is the writer's in-memory envelope (the list inline) or a stored
    # row (ARIA-HIGH-523: the set by reference); run_read_paths reads both.
    if run["status"] == "scope_violation" or find_scope_violations(tool, run_read_paths(run, base_dir=base_dir)):
        return "scope violation: read outside declared scope or forbidden generated/secrets path"
    if run["status"] == "schema_error":
        return "invalid output schema"
    if run["status"] == "evidence_error" or has_self_output_evidence(run):
        return "self-output evidence or invalid evidence chain"
    # Plan 022 §C-5 — scope-out write detection. The pre-fix
    # repository_mutation_attempt path catches ANY mutation; this finer
    # check distinguishes scope-out writes (a hard sandbox-escape signal)
    # from in-scope writes that may still be intentional. Surfaces a
    # specific reason so operator audit can triage faster.
    runner_block = run.get("runner") or {}
    scope_out = runner_block.get("scope_out_mutations") or []
    if scope_out:
        sample = ", ".join(scope_out[:3])
        return f"scope-out mutation: adapter wrote outside declared scope ({sample})"
    if run["evidence_validation"].get("repository_mutation_attempt"):
        return "repository mutation attempt"
    if run["status"] == "crash" and run["evidence_validation"].get("ledger_corruption"):
        return "crash corrupted ledger state"
    if run["status"] == "tool_unhealthy":
        return "tool runner unhealthy"
    # environment_unavailable is intentionally absent from this trigger:
    # quarantine prices the TOOL, and a workspace that cannot run any tool
    # is not evidence about one.
    if run["status"] == "integrity_failed":
        return "runtime artifact integrity failed"
    if has_critical_false_positive(run):
        return "operator-confirmed critical false positive"
    return None


def auto_calibrate_reason(
    tool: dict[str, Any],
    runs: list[dict[str, Any]],
    *,
    base_dir: str | Path | None = None,
) -> str | None:
    metrics = compute_metrics(tool, runs, base_dir=base_dir)
    thresholds = tool["health_thresholds"]
    if metrics["judged_samples"] >= 10 and metrics["precision"] < thresholds["precision_min"]:
        return "precision below threshold after judged samples"
    if metrics["non_critical_false_positives_30d"] >= thresholds["non_critical_false_positives_30d"]:
        return "three non-critical false positives in 30 days"
    if metrics["contradictions_last_10"] >= 2:
        return "repeated contradiction with another ACTIVE tool"
    if metrics["last_10_runs"] >= 10 and metrics["crash_rate_last_10"] > thresholds["crash_rate_last_10"]:
        return "crash rate above threshold over last 10 runs"
    if metrics["budget_exceeded_7d"] >= 2:
        return "budget use above declared cap twice in 7 days"
    return None


def _fold_consensus_rows(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """One settled judgment = one consensus row, whatever the ledger holds.

    JJ-1 made a group RE-SETTLEABLE: the anchor upgrade appends a second
    consensus row over its own 2-judge predecessor (and a judge trickling in
    later can append a third). Counting rows then counts one settled question
    two or three times, and the number it inflates is `judged_samples` /
    `true_positive` — i.e. `precision`, the number the ACTIVE gate compares
    to `precision_min`. Anchored findings would weigh more than un-anchored
    ones for no reason anybody chose.

    Folds on the (run, finding, group) identity every judgment lane already
    keys on (`feedback_store._judgment_key`), keeping the row with the most
    judges; later rows win ties, so the freshest settlement is the one that
    counts. Non-consensus rows are untouched: an operator verdict and a
    consensus about the same finding are two independent judgments and the
    precision lane is meant to see both.
    """
    best: dict[tuple[str, str, str], int] = {}
    keep: dict[tuple[str, str, str], int] = {}
    for index, row in enumerate(rows):
        if not isinstance(row, dict) or row.get("source_type") != "ai_consensus":
            continue
        key = _judgment_key(row)
        count = consensus_judge_count(row)
        if key not in best or count >= best[key]:
            best[key] = count
            keep[key] = index
    kept = set(keep.values())
    return [
        row for index, row in enumerate(rows)
        if not (isinstance(row, dict) and row.get("source_type") == "ai_consensus")
        or index in kept
    ]


@dataclass(frozen=True)
class EmissionScope:
    """ARIA-MEDIUM-229 — the findings the adapter version in force emits.

    The version in force is the one that produced the tool's latest ok run:
    runs carry no identity that moves when an adapter's SOURCE changes (the
    registry version and ``tool_manifest_hash`` describe the registry
    entry; ed848c05 rewrote doc-staleness without touching either), so what
    the latest complete run emitted is the only faithful record of what the
    version emits. ``fingerprints`` are its findings' fingerprints;
    ``finding_ids`` maps the version's own finding ids to them, so a
    judgment row that predates fingerprints is keyed through the id the
    version itself still uses — never through a guess.
    """

    run_id: str | None
    fingerprints: frozenset[str]
    finding_ids: Mapping[str, str] = dataclasses.field(default_factory=dict)

    def fingerprint_of(self, judgment: Mapping[str, Any]) -> str | None:
        """The in-scope fingerprint a judgment is about, or None."""
        stamped = str(judgment.get("finding_fingerprint") or "")
        if stamped:
            return stamped if stamped in self.fingerprints else None
        return self.finding_ids.get(str(judgment.get("finding_id") or ""))

    def covers(self, judgment: Any) -> bool:
        return isinstance(judgment, Mapping) and self.fingerprint_of(judgment) is not None


def current_emission_scope(
    tool_id: str,
    runs: list[dict[str, Any]],
    *,
    base_dir: str | Path | None = None,
) -> EmissionScope:
    """The fingerprints the tool's latest ok run emitted (:class:`EmissionScope`).

    Read from the raw-findings ledger, where every run records every
    finding it emitted under its run id; compaction keeps the newest row per
    fingerprint, which for the latest run is its own. No ok run: an empty
    scope, so nothing is judged in it.
    """
    latest = next((run for run in reversed(runs) if run.get("status") == "ok"), None)
    if latest is None or not latest.get("run_id"):
        return EmissionScope(run_id=None, fingerprints=frozenset())
    run_id = str(latest["run_id"])
    path = raw_findings_path(base_dir)
    fingerprints: set[str] = set()
    finding_ids: dict[str, str] = {}
    for row in load_chained_jsonl(path) if path.exists() else []:
        if row.get("tool_id") != tool_id or str(row.get("run_id") or "") != run_id:
            continue
        fingerprint = str(row.get("finding_fingerprint") or "")
        if not fingerprint:
            continue
        fingerprints.add(fingerprint)
        finding_id = str(row.get("finding_id") or "")
        if finding_id:
            finding_ids[finding_id] = fingerprint
    return EmissionScope(run_id=run_id, fingerprints=frozenset(fingerprints), finding_ids=finding_ids)


def compute_metrics(
    tool: dict[str, Any],
    runs: list[dict[str, Any]],
    *,
    base_dir: str | Path | None = None,
    emission_scope: EmissionScope | None = None,
) -> dict[str, Any]:
    """Health and precision metrics for one tool over its recorded runs.

    ARIA-MEDIUM-229 — PRECISION (``judged_samples``, ``precision`` and the
    judged-source counts behind ``precision_status``) is measured on the
    version in force: only judgments of findings in ``emission_scope``
    (default :func:`current_emission_scope`) count, whichever run they were
    judged on. A judgment of a finding the version no longer emits is
    history about a retired version and is reported as ``judged_retired``;
    one the scope cannot key is ``judged_unkeyed``. The false-positive
    SAFETY signals (the 30-day non-critical count, critical false
    positives) stay unscoped: a harm a past version did is still a harm.
    """
    now = datetime.now(timezone.utc)
    scope = emission_scope if emission_scope is not None else current_emission_scope(
        str(tool["tool_id"]), runs, base_dir=base_dir,
    )
    judged = 0
    true_positive = 0
    false_positive = 0
    non_critical_30d = 0
    human_judged = 0
    ai_consensus_judged = 0
    judged_retired = 0
    judged_unkeyed = 0
    feedback_rows = _fold_consensus_rows(
        load_feedback(tool_id=tool["tool_id"], base_dir=base_dir),
    )
    feedback_by_run: dict[str, list[dict[str, Any]]] = {}
    for feedback in feedback_rows:
        feedback_by_run.setdefault(str(feedback.get("run_id")), []).append(feedback)
    for run in runs:
        combined_feedback = list(run.get("operator_feedback_refs", [])) + feedback_by_run.get(
            str(run.get("run_id")),
            [],
        )
        for feedback in combined_feedback:
            kind = feedback_kind(feedback)
            if kind == "false_positive" and feedback_severity(feedback) != "critical" and _within_days(run, now, 30):
                non_critical_30d += 1
            if kind not in ("true_positive", "false_positive"):
                continue
            if not scope.covers(feedback):
                keyed = isinstance(feedback, Mapping) and (
                    feedback.get("finding_fingerprint") or feedback.get("finding_id")
                )
                if keyed:
                    judged_retired += 1
                else:
                    judged_unkeyed += 1
                continue
            judged += 1
            source_type = str(feedback.get("source_type") or "human")
            if source_type == "ai_consensus":
                ai_consensus_judged += 1
            elif source_type != "ai_judge":
                human_judged += 1
            if kind == "true_positive":
                true_positive += 1
            else:
                false_positive += 1

    last_10 = runs[-10:]
    crash_count = sum(1 for run in last_10 if run.get("status") == "crash")
    cap = tool["health_thresholds"].get("max_cost_units")
    budget_exceeded_7d = sum(
        1
        for run in runs
        if _within_days(run, now, 7)
        and (
            run.get("status") == "budget_exceeded"
            or (cap is not None and float(run.get("cost_units", 0)) > float(cap))
        )
    )

    precision = 0.0 if judged == 0 else true_positive / max(true_positive + false_positive, 1)
    # ORPHAN-HIGH-798 — use the same counts-first helper as every other
    # reader: post-798 rows carry emitted_counts (the arrays moved to the
    # artifact payload), pre-798 rows carry the arrays. Without this,
    # new rows silently contribute 0 to raw_findings and precision_status
    # misclassifies tools as no_findings_to_judge.
    def _emitted_count(run: dict[str, Any], kind: str) -> int:
        counts = run.get("emitted_counts")
        if isinstance(counts, dict):
            return int(counts.get(kind, 0))
        legacy = run.get(f"emitted_{kind}")
        if isinstance(legacy, list):
            return len(legacy)
        if isinstance(legacy, int):
            return legacy
        return 0

    raw_findings = sum(
        _emitted_count(run, "findings") + int(run.get("runner", {}).get("raw_findings_count") or 0)
        for run in runs
    )
    return {
        "judged_samples": judged,
        "precision": precision,
        "precision_status": _precision_status(judged, human_judged, ai_consensus_judged, raw_findings),
        "human_judged_samples": human_judged,
        "ai_consensus_judged_samples": ai_consensus_judged,
        "critical_false_positives": sum(1 for run in runs if has_critical_false_positive(run))
        + sum(
            1
            for feedback in feedback_rows
            if feedback_kind(feedback) == "false_positive" and feedback_severity(feedback) == "critical"
        ),
        "non_critical_false_positives_30d": non_critical_30d,
        "last_10_runs": len(last_10),
        "crash_rate_last_10": 0.0 if not last_10 else crash_count / len(last_10),
        "budget_exceeded_7d": budget_exceeded_7d,
        "contradictions_last_10": sum(
            1 for run in last_10 if run.get("evidence_validation", {}).get("contradicts_active_tool")
        ),
        "precision_scope": {
            "basis": "latest_ok_run_emissions",
            "run_id": scope.run_id,
            "emitted_fingerprints": len(scope.fingerprints),
            "judged_retired": judged_retired,
            "judged_unkeyed": judged_unkeyed,
        },
    }


def _precision_status(judged: int, human_judged: int, ai_consensus_judged: int, raw_findings: int) -> str:
    if judged == 0 and raw_findings == 0:
        return "no_findings_to_judge"
    if judged == 0:
        return "unjudged"
    if human_judged and ai_consensus_judged:
        return "mixed_judged"
    if human_judged:
        return "human_judged"
    if ai_consensus_judged:
        return "ai_consensus_judged"
    return "unjudged"


def find_scope_violations(tool: dict[str, Any], read_paths: list[Any]) -> list[str]:
    """Return the subset of ``read_paths`` that violate the tool's read scope.

    Plan 022 §C-7 / §C-8 — five-tier evaluation order.  The pre-fix
    implementation merged the hard-forbidden and default-deny tiers into a
    single tuple checked BEFORE the allow list, which structurally made
    ``allowed_read_globs`` powerless to lift any default-deny path
    (e.g. an audit tool that legitimately needs ``.claude/agents/**`` could
    not declare it).  The new order:

    1. **Hard-forbidden** (``HARD_FORBIDDEN_READ_GLOBS``) — never overridable.
    2. **Per-tool forbidden** — operator opt-in deny wins over allow.
    3. **Explicit allow** (``allowed_read_globs``) — lifts default-deny.
    4. **Default-deny** (``DEFAULT_DENY_READ_GLOBS``) — applies only when not
       explicitly allowed.
    5. **Legacy** — empty allow list keeps the pre-fix permissive default
       so existing tools without a declared scope are unaffected; declaring
       any allow pattern opts the tool into strict mode.

    The forbidden reads (tiers 1 and 2) lead the returned list; every other
    violation follows, both in reported order. ARIA-HIGH-617: a runs row
    keeps a sample of this list, so a ``.env`` read reported after twenty
    generated-tree reads would otherwise be visible only in the run
    artifact. The order is decided here, by the tiers that define
    "forbidden", so no second copy of the forbidden glob set exists.
    """
    forbidden: list[str] = []
    violations: list[str] = []
    allowed = tool.get("allowed_read_globs", [])
    tool_forbidden = list(tool.get("forbidden_read_globs", []))
    for raw_path in read_paths:
        normalized = lexical_repo_path(raw_path)
        # 1. Hard-forbidden never overridable
        if any(matches_repo_glob(normalized, pattern) for pattern in HARD_FORBIDDEN_READ_GLOBS):
            forbidden.append(normalized)
            continue
        # 2. Per-tool forbidden (operator opt-in deny wins over allow)
        if any(matches_repo_glob(normalized, pattern) for pattern in tool_forbidden):
            forbidden.append(normalized)
            continue
        # 3. Explicit allow lifts default-deny
        if any(matches_repo_glob(normalized, pattern) for pattern in allowed):
            continue
        # 4. Default-deny applies when not explicitly allowed
        if any(matches_repo_glob(normalized, pattern) for pattern in DEFAULT_DENY_READ_GLOBS):
            violations.append(normalized)
            continue
        # 5. Legacy: no allow list = no scope check (preserve pre-fix semantics)
        if not allowed:
            continue
        violations.append(normalized)
    return [*forbidden, *violations]


def has_self_output_evidence(run: dict[str, Any]) -> bool:
    validation = run.get("evidence_validation", {})
    if validation.get("self_output_evidence"):
        return True
    sources = validation.get("evidence_sources", [])
    return any(lexical_repo_path(source).startswith(SELF_OUTPUT_MARKERS) for source in sources)


def has_critical_false_positive(run: dict[str, Any]) -> bool:
    return any(
        feedback_kind(feedback) == "false_positive" and feedback_severity(feedback) == "critical"
        for feedback in run.get("operator_feedback_refs", [])
    )


def feedback_kind(feedback: Any) -> str | None:
    if isinstance(feedback, str):
        return feedback
    if isinstance(feedback, dict):
        return feedback.get("kind") or feedback.get("type") or feedback.get("judgement") or feedback.get("verdict")
    return None


def feedback_severity(feedback: Any) -> str | None:
    if isinstance(feedback, dict):
        return feedback.get("severity")
    return None


def append_jsonl(path: Path, payload: dict[str, Any]) -> dict[str, Any]:
    if path.name == "runs.jsonl":
        return append_declared_jsonl(path, payload, expected_surface="runs")
    if path.name == "health.jsonl":
        return append_declared_jsonl(path, payload, expected_surface="health")
    if path.name == "cycles.jsonl":
        return append_declared_jsonl(path, payload, expected_surface="cycles")
    # ORPHAN-670 — per-run tool calibration joined the declared roster so
    # it survives the nightly publish; a declared surface refuses the
    # legacy chained append, so the store-level wrapper routes it.
    if path.name == "calibration.jsonl":
        return append_declared_jsonl(path, payload, expected_surface="tool_calibration")
    return append_chained_jsonl(path, payload)


def load_jsonl(path: Path, *, tool_id: str | None = None) -> list[dict[str, Any]]:
    rows = load_chained_jsonl(path)
    if tool_id is not None:
        rows = [row for row in rows if row.get("tool_id") == tool_id]
    return rows


def _count(value: Any) -> int:
    if isinstance(value, list):
        return len(value)
    if isinstance(value, int):
        return value
    return 0


def _within_days(run: dict[str, Any], now: datetime, days: int) -> bool:
    raw = run.get("recorded_at") or run.get("at")
    if not raw:
        return True
    try:
        recorded = datetime.fromisoformat(str(raw).replace("Z", "+00:00"))
    except ValueError:
        return True
    return recorded >= now - timedelta(days=days)
