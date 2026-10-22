"""Architecture Spine Gate (Plan 019 Phase 5.5; contract ``aria/architecture-spine/v2``).

WHY. Plan 019's auth/schema/event remediation phases each fix one invariant;
without a cross-invariant guardrail a remediation can silently regress an
unrelated one. The spine gate snapshots five architectural invariants before
and after a remediation and rejects the round if any of them got worse.

WHAT an invariant is (ARIA-HIGH-045, ARIA-HIGH-525, ARIA-MEDIUM-526):

- Each invariant IS the finding set of the one adapter that owns its rule
  (``SPINE_INVARIANTS``). The gate holds no rule of its own: the static
  producers it used to keep were second copies that measured the wrong set
  (a ``getRepository(`` grep, 199 of 323 legal per-tenant entities called
  violations, and 243 of 243 events "missing" a ``.json`` schema where the
  catalogs are ``.schema.ts``).
- A measurement is the owner's violation SET by location-free identity
  (``finding_subject.adapter_violation_keys``), never a count: a swap of one
  violation for another is one regression plus one improvement, and a net
  improvement cannot absorb a newly introduced violation. Totals (declared
  events, entities, observations) are not measurements at all, and
  ``InvariantMeasurement`` refuses any other field (tier 1).
- The set is read from the run the refresh produced
  (``spine_orchestrator.refresh_spine_adapters`` returns the stored rows), in
  the TOOLS ROOT the gate was given. ``<workspace>/aria-tools/runs.jsonl`` is
  gitignored and production keeps its store outside the workspace, so the old
  readers saw a pending stub on both sides, silently clean. Without a refresh
  (``require_fresh_adapter_runs=False``) the latest recorded run of the tools
  root is read and the provenance says so.
- Coverage is explicit. ``measured`` carries the set; ``unmeasured`` (the
  owner did not run ``ok``, its artifact is unreadable, the set exceeds its
  row budget, the producer changed) and ``excluded`` (the owner is
  quarantined) carry a reason and nothing to compare. Unmeasured fails closed
  through the plan's ``unavailable`` comparison; excluded is named, and a
  quarantine since the baseline is unmeasured, never a pass.

Lifecycle:

- ``take_baseline`` measures every invariant and records an
  ``architecture_spine_baseline`` row carrying ``spine_contract``.
- ``take_postcheck`` measures again, compares with the plan's latest
  baseline (``compare_spine_measurements``) and records exactly one of
  ``architecture_spine_regression`` (any introduced violation),
  ``architecture_spine_unmeasured`` (no regression, some invariant not
  comparable) or ``architecture_spine_postcheck`` (clean).
- ``max_regression_rounds`` consecutive regressions for one plan (no clean
  postcheck between; an unmeasured row neither counts nor resets) record a
  HUMAN_REQUIRED item; the counter is read from the hash-chained ledger.
- A cycle keeps a regressed plan's baseline until a clean postcheck resolves
  it. A retained baseline from the count-only contract is superseded by a
  fresh one that names what it supersedes and the regressions it held.

Distinct from ``architecture.py`` (Plan 016 Faz E1), which reviews a single
architecture decision; the spine gate guards invariants across remediation
rounds.
"""
from __future__ import annotations

import json
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any, Callable, Mapping

from .finding_subject import adapter_violation_keys
from .governance_reader import read_governance_rows
from .human_required import record_human_required
from .runs_reader import latest_run_for_tool, raw_findings_count
from .runtime_artifacts import run_raw_findings
from .tool_registry import (
    GovernanceError,
    append_tools_governance,
    ensure_tools_dir,
    get_tool,
    utc_now,
)
from .digest import sha256_fingerprint


@dataclass(frozen=True)
class SpineInvariant:
    """One spine invariant and the adapter that owns its rule.

    ``kind`` is persisted vocabulary (baseline/postcheck rows); its values
    and order never change. ``adapter_id`` is the rule's owner: the adapter
    whose finding set IS the invariant.
    """
    kind: str
    adapter_id: str


# ARIA-HIGH-045 / ARIA-MEDIUM-516 — the ONE declaration of the spine: which
# invariants it holds and which adapter owns each. The spine refresh's
# adapter set derives from it (spine_orchestrator imports SPINE_ADAPTER_IDS),
# so the refresh can no longer name an adapter that has no manifest
# (schema-drift-adapter) or one no invariant reads (test-gap-adapter).
# ``harness_security`` (Plan 020 Phase 10) is agent-harness-security-adapter's
# 7 rules over .claude/agents, .github/workflows, tools/aria-{poc,adapters}
# and aria-kernel surfaces.
SPINE_INVARIANTS: tuple[SpineInvariant, ...] = (
    SpineInvariant("tenant_scoping", "tenant-scoping-adapter"),
    SpineInvariant("event_contracts", "event-contracts-adapter"),
    SpineInvariant("schema_entity", "typeorm-entity-schema-adapter"),
    SpineInvariant("auth_security", "security-boundary-adapter"),
    SpineInvariant("harness_security", "agent-harness-security-adapter"),
)
INVARIANT_KINDS: tuple[str, ...] = tuple(spec.kind for spec in SPINE_INVARIANTS)
SPINE_ADAPTER_IDS: tuple[str, ...] = tuple(spec.adapter_id for spec in SPINE_INVARIANTS)

# The persisted measurement contract. A baseline row carries it; a block
# without ``coverage`` is from the count-only contract before it (v1).
SPINE_CONTRACT = "aria/architecture-spine/v2"

# 5 consecutive regressions for the same plan_id → HUMAN_REQUIRED
# (Plan 019 §Architecture Spine Gate acceptance).
DEFAULT_MAX_REGRESSION_ROUNDS = 5

# The bytes one invariant's identity set may take in a row. A postcheck row
# holds two blocks per invariant (its own and, through the drifts, the
# baseline's), so 2 x 5 x 64 KiB plus the row's other fields stays inside the
# ledger's 1 MiB row cap (ledger.LEDGER_ROW_MAX_BYTES). A larger set is
# unmeasured by name, never truncated into a different set.
SPINE_IDENTITY_BUDGET_BYTES = 64 * 1024

COVERAGE_STATES: tuple[str, ...] = ("measured", "unmeasured", "excluded")
# The only fields a measured block holds: the set and its size.
_MEASURED_FIELDS = frozenset({"violation_count", "violation_identities"})

_BASELINE_KIND = "architecture_spine_baseline"
_POSTCHECK_KIND = "architecture_spine_postcheck"
_REGRESSION_KIND = "architecture_spine_regression"
_UNMEASURED_KIND = "architecture_spine_unmeasured"
# A verdict resolves (clean) or holds (regression) a plan's baseline; an
# unmeasured comparison is neither.
_VERDICT_KINDS: frozenset[str] = frozenset({_POSTCHECK_KIND, _REGRESSION_KIND})
_COMPARISON_KINDS: frozenset[str] = _VERDICT_KINDS | {_UNMEASURED_KIND}
_SPINE_EVENT_KINDS: frozenset[str] = _COMPARISON_KINDS | {_BASELINE_KIND}

# The one success status of tool_health.RUN_STATUSES.
_OK_RUN_STATUS = "ok"


@dataclass(frozen=True)
class InvariantMeasurement:
    """One invariant's measurement at a point in time.

    ``source`` names the producer (``adapter:<id>@<manifest version>``);
    ``provenance`` (run id, recorded_at, repo_state_id, selection) is
    evidence for a reader and is never compared. The old count-only shape
    cannot be built: a measured value must be the identity set and its size,
    and nothing else.
    """
    invariant: str
    measured_at: str
    measurements: dict[str, Any]
    source: str
    coverage: str = "measured"
    coverage_reason: str | None = None
    provenance: dict[str, Any] = field(default_factory=dict)

    def __post_init__(self) -> None:
        if self.coverage not in COVERAGE_STATES:
            raise GovernanceError(f"spine_measurement_coverage_unknown: {self.invariant}: {self.coverage!r}")
        if self.coverage != "measured":
            if not self.coverage_reason:
                raise GovernanceError(f"spine_measurement_reason_required: {self.invariant} is {self.coverage}")
            if self.measurements:
                raise GovernanceError(f"spine_measurement_unmeasured_has_values: {self.invariant}")
            return
        identities = self.measurements.get("violation_identities")
        if not isinstance(identities, list) or not all(isinstance(value, str) for value in identities):
            raise GovernanceError(f"spine_measurement_without_identities: {self.invariant}")
        if set(self.measurements) != _MEASURED_FIELDS:
            raise GovernanceError(
                f"spine_measurement_fields_unknown: {self.invariant}: {sorted(set(self.measurements) - _MEASURED_FIELDS)}"
            )
        if len(set(identities)) != len(identities):
            raise GovernanceError(f"spine_measurement_identities_not_a_set: {self.invariant}")
        count = self.measurements["violation_count"]
        if type(count) is not int or count != len(identities):
            raise GovernanceError(f"spine_measurement_count_mismatch: {self.invariant}: {count!r} != {len(identities)}")


@dataclass(frozen=True)
class DriftReport:
    """One invariant's removed (improvement) or introduced (regression) violations."""
    invariant: str
    field: str
    baseline_value: Any
    postcheck_value: Any
    direction: str  # "regression" | "improvement"


@dataclass(frozen=True)
class SpineComparison:
    """A baseline/postcheck comparison: the drifts, and what could not be compared.

    ``unmeasured`` and ``excluded`` are ``{"invariant", "reason"}`` entries;
    an invariant in either has no drift.
    """
    drifts: tuple[DriftReport, ...]
    unmeasured: tuple[dict[str, str], ...]
    excluded: tuple[dict[str, str], ...]


# ---------------------------- measuring the owner adapters ----------------------------


def _identity_budget_issue(identities: list[str]) -> str | None:
    """``identity_set_over_budget`` when the set exceeds its share of a row."""
    encoded = json.dumps(identities, separators=(",", ":"), ensure_ascii=True).encode("utf-8")
    return "identity_set_over_budget" if len(encoded) > SPINE_IDENTITY_BUDGET_BYTES else None


def _not_compared(
    spec: SpineInvariant, coverage: str, reason: str, *, source: str, provenance: dict[str, Any] | None = None,
) -> InvariantMeasurement:
    return InvariantMeasurement(
        invariant=spec.kind, measured_at=utc_now(), measurements={}, source=source,
        coverage=coverage, coverage_reason=reason, provenance=provenance or {},
    )


def _measure_adapter_invariant(
    spec: SpineInvariant, *, tools_root: Path, refresh: Mapping[str, Any] | None,
) -> InvariantMeasurement:
    """The violation set of ``spec``'s owner adapter, from one stored run.

    With a refresh: the row the refresh stored or reused for the adapter
    (``selection: refreshed``), never a newer row another caller recorded.
    Without one: the latest row of the tools root (``latest_recorded``).
    """
    adapter_id = spec.adapter_id
    unknown_source = f"adapter:{adapter_id}"
    if refresh is not None:
        selection = "refreshed"
        states = {state["adapter_id"]: state for state in refresh["adapter_states"]}
        state = states.get(adapter_id)
        if state is None:
            return _not_compared(spec, "unmeasured", "adapter_not_refreshed", source=unknown_source)
        if state["source"] == "quarantined":
            return _not_compared(spec, "excluded", "tool_quarantined", source=unknown_source)
        if state["source"] == "unregistered":
            return _not_compared(spec, "unmeasured", "adapter_unregistered", source=unknown_source)
        version = str(refresh["adapter_versions"][adapter_id])
        row = refresh["adapter_runs"].get(adapter_id)
        if row is None:
            missing = "adapter_run_failed" if state["source"] == "failed" else "adapter_run_missing"
            return _not_compared(spec, "unmeasured", missing, source=f"{unknown_source}@{version}")
    else:
        selection = "latest_recorded"
        try:
            tool = get_tool(adapter_id, base_dir=tools_root)
        except GovernanceError:
            return _not_compared(spec, "unmeasured", "adapter_unregistered", source=unknown_source)
        if tool["status"] == "QUARANTINED":
            return _not_compared(spec, "excluded", "tool_quarantined", source=unknown_source)
        version = str(tool["version"])
        row = latest_run_for_tool(tools_root / "runs.jsonl", tool_id=adapter_id, base_dir=tools_root)
        if row is None:
            return _not_compared(spec, "unmeasured", "adapter_run_missing", source=f"{unknown_source}@{version}")
    source = f"{unknown_source}@{version}"
    provenance = {
        "run_id": str(row["run_id"]),
        "recorded_at": row["recorded_at"],
        "repo_state_id": row["repo_snapshot"]["repo_state_id"],
        "artifact_hash": row.get("artifact_hash"),
        "adapter_version": version,
        "selection": selection,
    }
    if row["status"] != _OK_RUN_STATUS:
        return _not_compared(spec, "unmeasured", f"adapter_run_status:{row['status']}",
                             source=source, provenance=provenance)
    findings = run_raw_findings(row, base_dir=tools_root)
    if findings is None:
        return _not_compared(spec, "unmeasured", "adapter_run_artifact_unresolved",
                             source=source, provenance=provenance)
    if len(findings) != raw_findings_count(row):
        return _not_compared(spec, "unmeasured", "adapter_findings_count_mismatch",
                             source=source, provenance=provenance)
    if not all(isinstance(finding, dict) for finding in findings):
        return _not_compared(spec, "unmeasured", "adapter_findings_malformed",
                             source=source, provenance=provenance)
    identities = adapter_violation_keys(findings)
    over_budget = _identity_budget_issue(identities)
    if over_budget is not None:
        return _not_compared(spec, "unmeasured", over_budget, source=source, provenance=provenance)
    return InvariantMeasurement(
        invariant=spec.kind,
        measured_at=utc_now(),
        measurements={"violation_count": len(identities), "violation_identities": identities},
        source=source,
        provenance=provenance,
    )


def _default_invariant_checks(
    *, tools_root: Path, refresh: Mapping[str, Any] | None,
) -> dict[str, Callable[[Path], InvariantMeasurement]]:
    """One check per ``SPINE_INVARIANTS`` row, bound to the tools root and the refresh.

    The ``Callable[[Path], InvariantMeasurement]`` shape every
    ``invariant_checks=`` caller already supplies; the workspace argument is
    unused because the owner adapters already read it.
    """
    return {
        spec.kind: (lambda _workspace, _spec=spec: _measure_adapter_invariant(
            _spec, tools_root=tools_root, refresh=refresh,
        ))
        for spec in SPINE_INVARIANTS
    }


# ---------------------------- baseline + postcheck primitives ----------------------------


def _measurements_to_dict(measurements: list[InvariantMeasurement]) -> dict[str, dict[str, Any]]:
    return {m.invariant: {**asdict(m)} for m in measurements}


def _baseline_hash(measurements: list[InvariantMeasurement]) -> str:
    canonical = json.dumps(
        _measurements_to_dict(measurements),
        sort_keys=True,
        separators=(",", ":"),
    )
    return sha256_fingerprint(canonical.encode("utf-8"), hex_chars=16)


def _run_invariant_checks(
    *,
    workspace_root: Path,
    invariant_checks: Mapping[str, Callable[[Path], InvariantMeasurement]],
) -> list[InvariantMeasurement]:
    measurements: list[InvariantMeasurement] = []
    for invariant in INVARIANT_KINDS:
        check_fn = invariant_checks.get(invariant)
        if check_fn is None:
            measurements.append(InvariantMeasurement(
                invariant=invariant, measured_at=utc_now(), measurements={},
                source="missing:no_check_registered",
                coverage="unmeasured", coverage_reason="no_check_registered",
            ))
            continue
        result = check_fn(workspace_root)
        if not isinstance(result, InvariantMeasurement):
            raise GovernanceError(
                f"invariant check {invariant!r} must return InvariantMeasurement, "
                f"got {type(result).__name__}"
            )
        if result.invariant != invariant:
            raise GovernanceError(f"invariant check {invariant!r} returned {result.invariant!r}")
        measurements.append(result)
    return measurements


def _measure_spine(
    *,
    workspace_root: Path,
    tools_root: Path,
    cycle_id: str,
    invariant_checks: Mapping[str, Callable[[Path], InvariantMeasurement]] | None,
    require_fresh_adapter_runs: bool,
    freshness_max_age_seconds: int | None,
) -> list[InvariantMeasurement]:
    """Measure every invariant; the default checks read what the refresh stored.

    Plan 020 Phase 4.B — with ``require_fresh_adapter_runs`` (and no
    synthetic ``invariant_checks``) the refresh re-runs any owner adapter
    whose latest run is not a fresh ``ok`` run of this working tree, and its
    result is what the checks read (ARIA-HIGH-525). Synthetic checks skip the
    refresh: the caller is feeding the measurements.
    """
    if invariant_checks is None:
        refresh: Mapping[str, Any] | None = None
        if require_fresh_adapter_runs:
            # Lazy: the orchestrator imports this module's declaration.
            from .spine_orchestrator import (
                DEFAULT_FRESHNESS_MAX_AGE_SECONDS,
                refresh_spine_adapters,
            )
            refresh = refresh_spine_adapters(
                base_dir=tools_root,
                workspace_root=workspace_root,
                freshness_max_age_seconds=(
                    freshness_max_age_seconds or DEFAULT_FRESHNESS_MAX_AGE_SECONDS
                ),
                cycle_id=cycle_id,
            )
        invariant_checks = _default_invariant_checks(tools_root=tools_root, refresh=refresh)
    return _run_invariant_checks(workspace_root=workspace_root, invariant_checks=invariant_checks)


def _record_baseline(
    *,
    plan_id: str,
    cycle_id: str,
    workspace_root: str | Path,
    base_dir: str | Path | None,
    invariant_checks: Mapping[str, Callable[[Path], InvariantMeasurement]] | None,
    require_fresh_adapter_runs: bool,
    freshness_max_age_seconds: int | None,
    supersedes: dict[str, Any] | None,
) -> dict[str, Any]:
    if not plan_id.strip():
        raise GovernanceError("plan_id is required")
    if not cycle_id.strip():
        raise GovernanceError("cycle_id is required")
    tools_root = ensure_tools_dir(base_dir)
    measurements = _measure_spine(
        workspace_root=Path(workspace_root).resolve(), tools_root=tools_root, cycle_id=cycle_id,
        invariant_checks=invariant_checks, require_fresh_adapter_runs=require_fresh_adapter_runs,
        freshness_max_age_seconds=freshness_max_age_seconds,
    )
    details: dict[str, Any] = {
        "plan_id": plan_id,
        "cycle_id": cycle_id,
        "spine_contract": SPINE_CONTRACT,
        "baseline_hash": _baseline_hash(measurements),
        "invariant_measurements": _measurements_to_dict(measurements),
        "fresh_adapter_runs_required": require_fresh_adapter_runs,
    }
    if supersedes is not None:
        details["supersedes"] = supersedes
    append_tools_governance(tools_root, _BASELINE_KIND, details)
    return details


def take_baseline(
    *,
    plan_id: str,
    cycle_id: str,
    workspace_root: str | Path,
    base_dir: str | Path | None = None,
    invariant_checks: dict[str, Callable[[Path], InvariantMeasurement]] | None = None,
    require_fresh_adapter_runs: bool = True,
    freshness_max_age_seconds: int | None = None,
) -> dict[str, Any]:
    """Measure every invariant and record an ``architecture_spine_baseline`` row.

    Returns the recorded details (``baseline_hash``, ``spine_contract`` and
    the per-invariant measurements); ``take_postcheck`` resolves the plan's
    latest baseline by ``plan_id``.

    ``require_fresh_adapter_runs`` (default True) refreshes the owner
    adapters first and measures the runs the refresh stored. False reads the
    latest recorded run of each owner in the tools root (frozen profiles,
    where run_tool is gated, must pass False). ``freshness_max_age_seconds``
    defaults to the orchestrator's DEFAULT_FRESHNESS_MAX_AGE_SECONDS (600).
    """
    return _record_baseline(
        plan_id=plan_id, cycle_id=cycle_id, workspace_root=workspace_root, base_dir=base_dir,
        invariant_checks=invariant_checks, require_fresh_adapter_runs=require_fresh_adapter_runs,
        freshness_max_age_seconds=freshness_max_age_seconds, supersedes=None,
    )


def _take_cycle_baseline(
    *, plan_id: str, cycle_id: str, workspace_root: str | Path,
    base_dir: str | Path | None = None,
) -> dict[str, Any]:
    """Keep a failed plan's baseline until a native clean postcheck resolves it.

    Explicit ``take_baseline`` remains a fresh-capture operation. The cycle
    phase cannot silently replace an unresolved comparison obligation merely
    because a later cycle has started. Retention follows the latest VERDICT
    (regression or clean); an unmeasured comparison is neither. Reuse keeps
    the selected observation's cycle and hash; the sidecar identifies the
    current consumer without relabeling that row.

    ARIA-HIGH-045 — a retained baseline from the count-only contract (no
    ``spine_contract``) cannot be compared with a v2 measurement, so it is
    superseded: a fresh baseline is recorded naming the hash, the contract
    and the unresolved regressions it replaces, and later cycles reuse that
    one until a v2 verdict exists.
    """
    if not plan_id.strip():
        raise GovernanceError("plan_id is required")
    if not cycle_id.strip():
        raise GovernanceError("cycle_id is required")
    root = ensure_tools_dir(base_dir)
    verdict = _latest_plan_comparison(root, plan_id, _VERDICT_KINDS)
    if verdict is None or verdict["kind"] == _POSTCHECK_KIND:
        return take_baseline(
            plan_id=plan_id, cycle_id=cycle_id,
            workspace_root=workspace_root, base_dir=root,
        )
    previous = verdict["details"]
    baseline = _latest_baseline_for_plan(root, plan_id)
    if baseline is None or not previous.get("baseline_hash"):
        raise GovernanceError("architecture_spine_unresolved_baseline_unavailable")
    held_hash = previous["baseline_hash"]
    current = baseline.get("spine_contract") == SPINE_CONTRACT
    if baseline.get("baseline_hash") == held_hash and not current:
        return _record_baseline(
            plan_id=plan_id, cycle_id=cycle_id, workspace_root=workspace_root, base_dir=root,
            invariant_checks=None, require_fresh_adapter_runs=True, freshness_max_age_seconds=None,
            supersedes={
                "baseline_hash": held_hash,
                "spine_contract": baseline.get("spine_contract"),
                "unresolved_regressions": [
                    drift for drift in previous["drifts"] if drift.get("direction") == "regression"
                ],
            },
        )
    superseded = baseline.get("supersedes")
    if baseline.get("baseline_hash") == held_hash:
        reason = "unresolved_regression"
    elif current and isinstance(superseded, dict) and superseded.get("baseline_hash") == held_hash:
        reason = "superseded_pre_v2_regression"
    else:
        raise GovernanceError("architecture_spine_unresolved_baseline_unavailable")
    return {
        **baseline,
        "baseline_reuse": {
            "cycle_id": cycle_id,
            "previous_postcheck_cycle_id": previous.get("cycle_id"),
            "reason": reason,
        },
    }


def _latest_plan_comparison(root: Path, plan_id: str, kinds: frozenset[str]) -> dict[str, Any] | None:
    """The plan's most recent comparison row whose kind is in ``kinds``."""
    for row in read_governance_rows(root / "governance.jsonl", reverse=True, base_dir=root):
        if row.get("kind") not in kinds:
            continue
        if (row.get("details") or {}).get("plan_id") == plan_id:
            return row
    return None


def _named_invariants(value: Any) -> bool:
    """A list of ``{"invariant", "reason"}`` entries naming spine invariants."""
    return isinstance(value, list) and all(
        isinstance(entry, dict) and entry.get("invariant") in INVARIANT_KINDS
        and isinstance(entry.get("reason"), str) and entry["reason"]
        for entry in value
    )


def _plan_comparison_obligation(root: Path, plan_id: str) -> dict[str, Any] | None:
    """Project native comparison evidence for the existing planning decision.

    Absence preserves unenrolled historical plans. An enrolled plan without
    a completed, anchored comparison is unavailable, not observed clean, and
    so is a comparison some invariant could not take part in
    (``invariant_unmeasured``). The caller carries this one captured
    descriptor to its planner request.
    """
    row = _latest_plan_comparison(root, plan_id, _COMPARISON_KINDS)
    baseline = _latest_baseline_for_plan(root, plan_id)
    if row is None and baseline is None:
        return None
    observation = {
        "plan_id": plan_id,
        "postcheck_ledger_hash": row.get("ledger_hash") if row else None,
        "baseline_hash": (row.get("details") or {}).get("baseline_hash") if row else None,
    }
    if row is None:
        return {**observation, "status": "unavailable", "reason": "postcheck_missing"}
    details = row.get("details") or {}
    if (baseline is None or not observation["baseline_hash"]
            or baseline.get("baseline_hash") != observation["baseline_hash"]):
        return {**observation, "status": "unavailable", "reason": "baseline_anchor_unavailable"}
    drifts, count = details.get("drifts"), details.get("regression_count")
    if (not isinstance(drifts, list) or not all(isinstance(drift, dict) for drift in drifts)
            or type(count) is not int or count < 0
            or type(details.get("drift_count")) is not int
            or details["drift_count"] != len(drifts)
            or not observation["postcheck_ledger_hash"]):
        return {**observation, "status": "unavailable", "reason": "comparison_shape_unavailable"}
    if any(drift.get("direction") not in {"regression", "improvement"}
           or drift.get("invariant") not in INVARIANT_KINDS
           or not isinstance(drift.get("field"), str) or not drift["field"]
           or "baseline_value" not in drift or "postcheck_value" not in drift
           for drift in drifts):
        return {**observation, "status": "unavailable", "reason": "comparison_shape_unavailable"}
    regressions = [drift for drift in drifts if drift.get("direction") == "regression"]
    if (count != len(regressions)
            or (row["kind"] == _REGRESSION_KIND) != bool(count)):
        return {**observation, "status": "unavailable", "reason": "comparison_shape_unavailable"}
    if row["kind"] == _UNMEASURED_KIND:
        unmeasured = details.get("unmeasured_invariants")
        if not _named_invariants(unmeasured) or not unmeasured:
            return {**observation, "status": "unavailable", "reason": "comparison_shape_unavailable"}
        return {
            **observation, "status": "unavailable", "reason": "invariant_unmeasured",
            "unmeasured_invariants": unmeasured,
        }
    result = {
        **observation,
        "status": "regression" if count else "clean",
        "regressions": regressions,
    }
    # A v1 row predates exclusion and claims none; a v2 row names its own.
    if "excluded_invariants" in details:
        if not _named_invariants(details["excluded_invariants"]):
            return {**observation, "status": "unavailable", "reason": "comparison_shape_unavailable"}
        result["excluded_invariants"] = details["excluded_invariants"]
    return result


def _stored_measurement(block: Any, side: str) -> tuple[InvariantMeasurement | None, str | None]:
    """A stored block as a measurement, or the reason it is not one."""
    if not isinstance(block, Mapping):
        return None, f"{side}_missing"
    if "coverage" not in block:
        # The count-only contract (v1) observed no violation set.
        return None, f"{side}_pre_v2"
    try:
        return InvariantMeasurement(
            invariant=block["invariant"], measured_at=block["measured_at"],
            measurements=dict(block["measurements"]), source=block["source"],
            coverage=block["coverage"], coverage_reason=block["coverage_reason"],
            provenance=dict(block["provenance"]),
        ), None
    except (GovernanceError, KeyError, TypeError, ValueError):
        return None, f"{side}_malformed"


def compare_spine_measurements(
    *,
    baseline: Mapping[str, Any],
    postcheck: Mapping[str, Any],
) -> SpineComparison:
    """Compare two stored measurement maps invariant by invariant.

    Per invariant, in order:
      1. a baseline block that is not a v2 measurement → unmeasured;
      2. baseline ``excluded`` → excluded, named (nothing to compare against);
      3. a postcheck block that is not a v2 measurement → unmeasured;
      4. baseline unmeasured → unmeasured (``baseline:<reason>``);
      5. postcheck excluded with a measured baseline → unmeasured
         (``<reason>_since_baseline``): a quarantine between the two must not
         turn into a pass;
      6. postcheck unmeasured → unmeasured (``postcheck:<reason>``);
      7. a different producer (manifest version) → unmeasured
         ``producer_changed``: two producers' sets are not one set over time;
      8. otherwise removed identities are one ``improvement`` and introduced
         identities one ``regression`` (field ``violation_identities``).
    No other field is compared.
    """
    drifts: list[DriftReport] = []
    unmeasured: list[dict[str, str]] = []
    excluded: list[dict[str, str]] = []
    for invariant in INVARIANT_KINDS:
        base, base_issue = _stored_measurement(baseline.get(invariant), "baseline")
        if base is None:
            unmeasured.append({"invariant": invariant, "reason": str(base_issue)})
            continue
        if base.coverage == "excluded":
            excluded.append({"invariant": invariant, "reason": str(base.coverage_reason)})
            continue
        post, post_issue = _stored_measurement(postcheck.get(invariant), "postcheck")
        if post is None:
            reason = str(post_issue)
        elif base.coverage == "unmeasured":
            reason = f"baseline:{base.coverage_reason}"
        elif post.coverage == "excluded":
            reason = f"{post.coverage_reason}_since_baseline"
        elif post.coverage == "unmeasured":
            reason = f"postcheck:{post.coverage_reason}"
        elif post.source != base.source:
            reason = "producer_changed"
        else:
            before = set(base.measurements["violation_identities"])
            after = set(post.measurements["violation_identities"])
            removed, introduced = sorted(before - after), sorted(after - before)
            if removed:
                drifts.append(DriftReport(
                    invariant=invariant, field="violation_identities",
                    baseline_value=removed, postcheck_value=[], direction="improvement",
                ))
            if introduced:
                drifts.append(DriftReport(
                    invariant=invariant, field="violation_identities",
                    baseline_value=[], postcheck_value=introduced, direction="regression",
                ))
            continue
        unmeasured.append({"invariant": invariant, "reason": reason})
    return SpineComparison(drifts=tuple(drifts), unmeasured=tuple(unmeasured), excluded=tuple(excluded))


def _latest_baseline_for_plan(
    tools_root: Path,
    plan_id: str,
) -> dict[str, Any] | None:
    """Plan 025 §A.2 — uses shared governance_reader helper (STRICT)."""
    governance = tools_root / "governance.jsonl"
    latest: dict[str, Any] | None = None
    latest_ts = ""
    for row in read_governance_rows(governance, base_dir=tools_root):
        if row.get("kind") != _BASELINE_KIND:
            continue
        details = row.get("details") or {}
        if details.get("plan_id") != plan_id:
            continue
        ts = str(row.get("ts") or "")
        if ts >= latest_ts:
            latest_ts = ts
            latest = details
    return latest


def _consecutive_regression_count(
    tools_root: Path,
    plan_id: str,
) -> int:
    """Count regressions for plan_id since the last clean postcheck.

    Plan 025 §A.2 — uses shared governance_reader helper with
    reverse=True so iteration is newest-first (streak counter
    semantics). The helper preserves the ORIGINAL forward line
    number in any diagnostic, so operators investigating a
    corruption event can locate the row in the file directly.
    An unmeasured comparison is not a verdict: it neither counts
    nor breaks the streak.
    """
    governance = tools_root / "governance.jsonl"
    relevant: list[str] = []  # most-recent-first list of event kinds
    for row in read_governance_rows(
        governance, reverse=True, base_dir=tools_root,
    ):
        kind = row.get("kind")
        if kind not in _VERDICT_KINDS:
            continue
        details = row.get("details") or {}
        if details.get("plan_id") != plan_id:
            continue
        if kind == _POSTCHECK_KIND:
            return len(relevant)  # clean postcheck breaks the streak
        relevant.append(kind)
    return len(relevant)


def take_postcheck(
    *,
    plan_id: str,
    cycle_id: str,
    workspace_root: str | Path,
    base_dir: str | Path | None = None,
    invariant_checks: dict[str, Callable[[Path], InvariantMeasurement]] | None = None,
    max_regression_rounds: int = DEFAULT_MAX_REGRESSION_ROUNDS,
    require_fresh_adapter_runs: bool = True,
    freshness_max_age_seconds: int | None = None,
) -> dict[str, Any]:
    """Measure again and compare with the latest baseline for the same plan_id.

    Records exactly one of:
      architecture_spine_regression  — at least one introduced violation
      architecture_spine_unmeasured  — no regression, but some invariant
                                       could not be compared (fail-closed:
                                       the plan's comparison is unavailable)
      architecture_spine_postcheck   — clean, the plan can advance
    The details always carry ``unmeasured_invariants`` and
    ``excluded_invariants``.

    After ``max_regression_rounds`` consecutive regressions for the same
    plan_id (without an intervening clean postcheck), also records a
    HUMAN_REQUIRED item via record_human_required().

    ``require_fresh_adapter_runs`` and ``freshness_max_age_seconds``: as
    ``take_baseline``.
    """
    if not plan_id.strip():
        raise GovernanceError("plan_id is required")
    if not cycle_id.strip():
        raise GovernanceError("cycle_id is required")
    if max_regression_rounds < 1:
        raise GovernanceError("max_regression_rounds must be >= 1")
    tools_root = ensure_tools_dir(base_dir)
    baseline = _latest_baseline_for_plan(tools_root, plan_id)
    if baseline is None:
        raise GovernanceError(
            f"no baseline recorded for plan_id={plan_id!r}; "
            "call take_baseline first"
        )

    measurements = _measure_spine(
        workspace_root=Path(workspace_root).resolve(), tools_root=tools_root, cycle_id=cycle_id,
        invariant_checks=invariant_checks, require_fresh_adapter_runs=require_fresh_adapter_runs,
        freshness_max_age_seconds=freshness_max_age_seconds,
    )
    postcheck_dict = _measurements_to_dict(measurements)
    comparison = compare_spine_measurements(
        baseline=baseline["invariant_measurements"], postcheck=postcheck_dict,
    )
    regressions = [d for d in comparison.drifts if d.direction == "regression"]

    details: dict[str, Any] = {
        "plan_id": plan_id,
        "cycle_id": cycle_id,
        "baseline_hash": baseline.get("baseline_hash"),
        "postcheck_measurements": postcheck_dict,
        "drift_count": len(comparison.drifts),
        "regression_count": len(regressions),
        "drifts": [asdict(d) for d in comparison.drifts],
        "unmeasured_invariants": list(comparison.unmeasured),
        "excluded_invariants": list(comparison.excluded),
    }
    if regressions:
        append_tools_governance(tools_root, _REGRESSION_KIND, details)
        round_count = _consecutive_regression_count(tools_root, plan_id)
        if round_count >= max_regression_rounds:
            record_human_required(
                request_id=f"spine-{plan_id}-rounds-{round_count}",
                severity="HIGH",
                reason=(
                    f"Architecture Spine Gate: plan {plan_id} has {round_count} "
                    f"consecutive regressions without a clean postcheck. "
                    f"Operator must intervene; remediation strategy needs review. "
                    f"Latest regressions: "
                    + ", ".join(
                        f"{d.invariant}: introduced {d.postcheck_value}"
                        for d in regressions[:5]
                    )
                ),
                base_dir=base_dir,
            )
            details["human_required_emitted"] = True
            details["round_count"] = round_count
    elif comparison.unmeasured:
        append_tools_governance(tools_root, _UNMEASURED_KIND, details)
    else:
        append_tools_governance(tools_root, _POSTCHECK_KIND, details)
    return details


def list_spine_events(
    *,
    plan_id: str | None = None,
    base_dir: str | Path | None = None,
) -> list[dict[str, Any]]:
    """Return all spine events (baseline / postcheck / regression / unmeasured).

    Optionally filtered to a single plan_id. Useful for operator status
    queries via `aria-kernel spine status --plan-id X`.

    Plan 025 §A.2 — uses shared governance_reader helper (STRICT).
    """
    tools_root = ensure_tools_dir(base_dir)
    governance = tools_root / "governance.jsonl"
    out: list[dict[str, Any]] = []
    for row in read_governance_rows(governance, base_dir=tools_root):
        if row.get("kind") not in _SPINE_EVENT_KINDS:
            continue
        details = row.get("details") or {}
        if plan_id is not None and details.get("plan_id") != plan_id:
            continue
        out.append({
            "kind": row["kind"],
            "ts": row.get("ts"),
            "details": details,
        })
    return out
