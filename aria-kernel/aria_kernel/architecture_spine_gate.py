"""Architecture Spine Gate (Plan 019 Phase 5.5).

Why a separate module: Plan 019 auth/schema/event remediation phases
(4, 6, 9) each fix one invariant; without a cross-invariant guardrail
a remediation can silently regress an unrelated invariant. The Spine
Gate snapshots four ARIA invariants before + after each remediation
and rejects the round if any baseline drift surfaces.

The four invariants snapshot per round:

1. **tenant_scoping** — `getRepository()` callsite count (CLAUDE.md
   tenant-isolation rule). Backed by tenant-scoping-adapter
   (Plan 019 Phase 5 commit `aa9dc9d2`) when available; falls back to
   a static repo-wide grep when the adapter is QUARANTINED or
   un-bound.
2. **event_contracts** — count of `interface XEvent extends BaseEvent`
   declarations missing JSON Schema validators (CLAUDE.md §Event
   Contract Rules). Backed by event-contracts-adapter; static-grep
   fallback walks libs/event-contracts/src/**/*.ts.
3. **schema_entity** — count of @Entity decorators violating ADR-011
   (missing schema option, public schema, non-canonical shared schema).
   Pure static check via _TYPEORM_ENTITY_RE.
4. **auth_security** — JWT tenant-source mismatch + missing @UseGuards
   coverage (CLAUDE.md tenant-ID-sourcing rule). Phase 6 will fill the
   real check by binding security-boundary-adapter; Phase 5.5 ships a
   stub that returns a sentinel pending=True measurement so the
   framework is wired but the auth round count stays neutral until
   Phase 6.

Lifecycle (Plan 019 Phase 5.5 §Regression edge):

- `take_baseline(plan_id, cycle_id, ...)` — snapshot all four invariants
  before remediation; persist as `architecture_spine_baseline`
  governance event.
- Remediation work happens in the calling phase.
- `take_postcheck(plan_id, cycle_id, ...)` — snapshot again; compare
  vs the latest baseline for the same plan_id; emit
  `architecture_spine_postcheck` (clean) or
  `architecture_spine_regression` (drift) governance event.
- 5 consecutive regressions for the same plan_id without a clean
  postcheck → emit `human_required_recorded` (reused from
  human_required.py); the round counter is read from the governance
  ledger so it is hash-chain-auditable.

Distinct from `architecture.py` (Plan 016 Faz E1): that module
implements a single architecture-decision review (replace_with_adr /
fix_in_place / etc.). The Spine Gate runs the architectural-invariant
guardrail across multiple remediation rounds.
"""
from __future__ import annotations

import hashlib
import json
import re
import subprocess
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable

from .governance_reader import read_governance_rows
from .human_required import record_human_required
from .ledger import load_jsonl
from .tool_registry import (
    GovernanceError,
    append_tools_governance,
    ensure_tools_dir,
    utc_now,
)


INVARIANT_KINDS = (
    "tenant_scoping",
    "event_contracts",
    "schema_entity",
    "auth_security",
    # Plan 020 Phase 10 — 5th invariant backed by agent-harness-security-
    # adapter (7 detection rules over .claude/agents, .github/workflows,
    # tools/aria-{poc,adapters}, aria-kernel surfaces). The spine gate
    # reads the LATEST adapter run row from runs.jsonl; the fresh
    # orchestrator (Phase 4) is responsible for ensuring that row was
    # taken against the current repo_state_id.
    "harness_security",
)

# 5 consecutive regressions for the same plan_id → HUMAN_REQUIRED
# (Plan 019 §Architecture Spine Gate acceptance).
DEFAULT_MAX_REGRESSION_ROUNDS = 5


@dataclass(frozen=True)
class InvariantMeasurement:
    """One invariant's measurement at a point in time."""
    invariant: str
    measured_at: str
    measurements: dict[str, Any]
    source: str  # "tool_runner:<tool_id>", "static:<fn_name>", "stub:<reason>"


@dataclass(frozen=True)
class DriftReport:
    """One field's drift between baseline and postcheck for one invariant."""
    invariant: str
    field: str
    baseline_value: Any
    postcheck_value: Any
    direction: str  # "regression" | "improvement" | "unchanged"


# ---------------------------- default invariant checks ----------------------------

_GET_REPOSITORY_RE = re.compile(r"(?<![\w.])getRepository\s*\(")
_EVENT_INTERFACE_RE = re.compile(
    r"export\s+interface\s+(\w+Event)\s+extends\s+BaseEvent",
)
_TYPEORM_ENTITY_RE = re.compile(
    r"@Entity\s*\("
    r"(?:\s*['\"](?P<table>\w+)['\"])?"
    r"(?:\s*,\s*\{\s*schema\s*:\s*['\"](?P<schema>\w+)['\"][^}]*\})?"
    r"\s*\)"
)
_SHARED_SCHEMA_TABLES = {
    "audit_logs",
    "gdpr_data_requests",
    "user_consents",
    "user_permissions",
}


def _walk_ts_files(root: Path, sub_dirs: tuple[str, ...]) -> list[Path]:
    """Yield *.ts files under each sub_dir, skipping common artefact roots."""
    paths: list[Path] = []
    for sub in sub_dirs:
        base = root / sub
        if not base.exists():
            continue
        for path in base.rglob("*.ts"):
            rel = path.relative_to(root).as_posix()
            if any(seg in rel for seg in (
                "node_modules/", "dist/", "/__tests__/", ".spec.ts",
                "aria-tools/",
            )):
                continue
            paths.append(path)
    return paths


def _check_tenant_scoping(workspace_root: Path) -> InvariantMeasurement:
    """Static grep for `getRepository(` callsites under apps/ + libs/."""
    callsites = 0
    for path in _walk_ts_files(workspace_root, ("apps", "libs")):
        try:
            content = path.read_text(encoding="utf-8")
        except (OSError, UnicodeDecodeError):
            continue
        callsites += sum(1 for _ in _GET_REPOSITORY_RE.finditer(content))
    return InvariantMeasurement(
        invariant="tenant_scoping",
        measured_at=utc_now(),
        measurements={
            "get_repository_callsite_count": callsites,
        },
        source="static:_check_tenant_scoping",
    )


def _check_event_contracts(workspace_root: Path) -> InvariantMeasurement:
    """Count event interfaces missing JSON Schema validators."""
    contracts_dir = workspace_root / "libs" / "event-contracts" / "src"
    schemas_dir = contracts_dir / "schemas"
    schema_stems = (
        {p.stem.lower().removesuffix(".schema") for p in schemas_dir.rglob("*.json")}
        if schemas_dir.exists() else set()
    )
    missing = 0
    declared = 0
    if contracts_dir.exists():
        for path in contracts_dir.rglob("*.ts"):
            rel = path.relative_to(workspace_root).as_posix()
            if "/schemas/" in rel or rel.endswith(".spec.ts"):
                continue
            try:
                content = path.read_text(encoding="utf-8")
            except (OSError, UnicodeDecodeError):
                continue
            for match in _EVENT_INTERFACE_RE.finditer(content):
                event_name = match.group(1)
                declared += 1
                snake = "".join(
                    ("_" + ch.lower()) if i and ch.isupper() else ch.lower()
                    for i, ch in enumerate(event_name)
                )
                if event_name.lower() not in schema_stems and snake not in schema_stems:
                    missing += 1
    return InvariantMeasurement(
        invariant="event_contracts",
        measured_at=utc_now(),
        measurements={
            "declared_event_count": declared,
            "missing_schema_count": missing,
        },
        source="static:_check_event_contracts",
    )


def _check_schema_entity(workspace_root: Path) -> InvariantMeasurement:
    """Count @Entity decorators violating ADR-011."""
    missing_schema = 0
    public_schema = 0
    non_canonical_shared = 0
    total_entities = 0
    apps_root = workspace_root / "apps"
    if apps_root.exists():
        for path in apps_root.rglob("*.entity.ts"):
            rel = path.relative_to(workspace_root).as_posix()
            if any(seg in rel for seg in ("node_modules/", "dist/", "/__tests__/", ".spec.ts")):
                continue
            try:
                content = path.read_text(encoding="utf-8")
            except (OSError, UnicodeDecodeError):
                continue
            for match in _TYPEORM_ENTITY_RE.finditer(content):
                total_entities += 1
                table = match.group("table")
                schema = match.group("schema")
                if schema is None and table is not None:
                    missing_schema += 1
                elif schema == "public":
                    public_schema += 1
                elif schema == "shared" and table not in _SHARED_SCHEMA_TABLES:
                    non_canonical_shared += 1
    return InvariantMeasurement(
        invariant="schema_entity",
        measured_at=utc_now(),
        measurements={
            "total_entities": total_entities,
            "missing_schema_violation_count": missing_schema,
            "public_schema_violation_count": public_schema,
            "non_canonical_shared_count": non_canonical_shared,
        },
        source="static:_check_schema_entity",
    )


def _check_auth_security(workspace_root: Path) -> InvariantMeasurement:
    """Plan 019 Phase 6.C — read latest security-boundary-adapter run from runs.jsonl.

    Operator critique #2: don't write a new auth-access-boundary-adapter;
    the existing tools/aria-adapters/security-boundary-adapter.ts covers
    @UseGuards / public-write-endpoint / dangerous-html / raw-security-
    sensitive-import rules and was bound to the registry in Plan 019
    Phase 6.0. This check reads the LATEST adapter run from runs.jsonl
    (cheap, non-recursive) instead of invoking the adapter from inside
    the spine gate.

    Operator workflow:
      aria-kernel tool run --tool-id security-boundary-adapter ...
      aria-kernel spine baseline --plan-id X --cycle-id Y
    The spine gate reads the most-recent run and surfaces its raw
    findings/observations counts as the auth_security invariant.

    Falls back to pending=True when no adapter run exists yet — the
    operator must run the adapter at least once before the spine gate
    can capture an auth baseline.
    """
    runs_path = workspace_root / "aria-tools" / "runs.jsonl"
    if not runs_path.exists():
        return InvariantMeasurement(
            invariant="auth_security",
            measured_at=utc_now(),
            measurements={
                "pending": True,
                "reason": "no aria-tools/runs.jsonl found",
            },
            source="stub:no_runs_ledger",
        )
    # Plan 026R §A.3 — strict runs.jsonl reader via runs_reader. A
    # corrupt row surfaces as GovernanceError; missing/empty ledger
    # yields None (pending) per the legacy contract.
    from .runs_reader import latest_run_for_tool
    try:
        latest = latest_run_for_tool(runs_path, tool_id="security-boundary-adapter")
    except OSError:
        latest = None
    if latest is None:
        return InvariantMeasurement(
            invariant="auth_security",
            measured_at=utc_now(),
            measurements={
                "pending": True,
                "reason": "no security-boundary-adapter run in runs.jsonl yet; run via tool_runner first",
            },
            source="stub:no_adapter_runs",
        )
    runner = latest.get("runner") or {}
    return InvariantMeasurement(
        invariant="auth_security",
        measured_at=utc_now(),
        measurements={
            "raw_observations_count": int(runner.get("raw_observations_count", 0) or 0),
            "raw_findings_count": int(runner.get("raw_findings_count", 0) or 0),
            "adapter_run_status": str(latest.get("status") or "unknown"),
            "adapter_run_id": str(latest.get("run_id") or ""),
            "adapter_recorded_at": str(latest.get("recorded_at") or ""),
        },
        source="tool_runner:security-boundary-adapter",
    )


def _check_harness_security(workspace_root: Path) -> InvariantMeasurement:
    """Plan 020 Phase 10 — read latest agent-harness-security-adapter run.

    Same pattern as _check_auth_security: read the LATEST adapter run from
    runs.jsonl + surface the raw findings/observations counts as the
    harness_security invariant. The Phase 4 fresh orchestrator ensures
    that row matches the current repo_state_id when require_fresh_adapter
    _runs=True.
    """
    runs_path = workspace_root / "aria-tools" / "runs.jsonl"
    if not runs_path.exists():
        return InvariantMeasurement(
            invariant="harness_security",
            measured_at=utc_now(),
            measurements={
                "pending": True,
                "reason": "no aria-tools/runs.jsonl found",
            },
            source="stub:no_runs_ledger",
        )
    # Plan 026R §A.3 — strict runs.jsonl reader via runs_reader (same
    # contract as _check_auth_security above).
    from .runs_reader import latest_run_for_tool
    try:
        latest = latest_run_for_tool(runs_path, tool_id="agent-harness-security-adapter")
    except OSError:
        latest = None
    if latest is None:
        return InvariantMeasurement(
            invariant="harness_security",
            measured_at=utc_now(),
            measurements={
                "pending": True,
                "reason": "no agent-harness-security-adapter run in runs.jsonl yet",
            },
            source="stub:no_adapter_runs",
        )
    runner = latest.get("runner") or {}
    return InvariantMeasurement(
        invariant="harness_security",
        measured_at=utc_now(),
        measurements={
            "raw_observations_count": int(runner.get("raw_observations_count", 0) or 0),
            "raw_findings_count": int(runner.get("raw_findings_count", 0) or 0),
            "adapter_run_status": str(latest.get("status") or "unknown"),
            "adapter_run_id": str(latest.get("run_id") or ""),
            "adapter_recorded_at": str(latest.get("recorded_at") or ""),
        },
        source="tool_runner:agent-harness-security-adapter",
    )


DEFAULT_INVARIANT_CHECKS: dict[str, Callable[[Path], InvariantMeasurement]] = {
    "tenant_scoping": _check_tenant_scoping,
    "event_contracts": _check_event_contracts,
    "schema_entity": _check_schema_entity,
    "auth_security": _check_auth_security,
    "harness_security": _check_harness_security,
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
    return "sha256:" + hashlib.sha256(canonical.encode("utf-8")).hexdigest()[:16]


def _run_invariant_checks(
    *,
    workspace_root: Path,
    invariant_checks: dict[str, Callable[[Path], InvariantMeasurement]] | None,
) -> list[InvariantMeasurement]:
    checks = invariant_checks if invariant_checks is not None else DEFAULT_INVARIANT_CHECKS
    measurements: list[InvariantMeasurement] = []
    for invariant in INVARIANT_KINDS:
        check_fn = checks.get(invariant)
        if check_fn is None:
            measurements.append(InvariantMeasurement(
                invariant=invariant,
                measured_at=utc_now(),
                measurements={"unmapped": True},
                source="missing:no_check_registered",
            ))
            continue
        result = check_fn(workspace_root)
        if not isinstance(result, InvariantMeasurement):
            raise GovernanceError(
                f"invariant check {invariant!r} must return InvariantMeasurement, "
                f"got {type(result).__name__}"
            )
        measurements.append(result)
    return measurements


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
    """Snapshot all four invariants + persist a hash-chained governance event.

    Returns the persisted event details (including baseline_hash + the
    full per-invariant measurements). Operator scripts use the returned
    dict to thread the baseline_hash through the remediation work; the
    matching `take_postcheck` call uses plan_id to resolve the latest
    baseline automatically.

    Plan 020 Phase 4.B — require_fresh_adapter_runs (default True):
      When True, calls spine_orchestrator.refresh_spine_adapters BEFORE
      running invariant checks. The orchestrator re-runs any of the
      5 spine adapters whose latest row is stale (different repo_state_id
      OR older than freshness_max_age_seconds) so the invariant readers
      downstream see fresh rows by construction.

      Set False for smoke tests / backward-compat callers that genuinely
      want the cached-row behaviour. Frozen profile callers must set
      False (or pre-warm caches), because the orchestrator itself routes
      through tool_runner.run_tool which is profile-gated.

      freshness_max_age_seconds defaults to the orchestrator's own
      DEFAULT_FRESHNESS_MAX_AGE_SECONDS (600) when None.
    """
    if not plan_id.strip():
        raise GovernanceError("plan_id is required")
    if not cycle_id.strip():
        raise GovernanceError("cycle_id is required")
    repo = Path(workspace_root).resolve()
    tools_root = ensure_tools_dir(base_dir)

    # Plan 020 Phase 4.B — fresh adapter orchestrator chokepoint.
    # require_fresh_adapter_runs=True (default) AND invariant_checks is None
    # → run the orchestrator. When invariant_checks is provided (smoke
    # tests / fixture overrides), the caller is by definition feeding
    # synthetic measurements; running real adapters would pollute the
    # test snapshot with unrelated data + force every test to register
    # 5 adapters in its isolated tools dir. Tier-2 "make it automatic"
    # — caller's intent (real vs synthetic) drives the default.
    if require_fresh_adapter_runs and invariant_checks is None:
        # Local import keeps the spine_orchestrator pull lazy — callers
        # that explicitly opt out of fresh runs (smoke tests, frozen
        # profile cached-baseline path) avoid importing the orchestrator
        # at all.
        from .spine_orchestrator import (
            DEFAULT_FRESHNESS_MAX_AGE_SECONDS,
            refresh_spine_adapters,
        )
        refresh_spine_adapters(
            base_dir=base_dir,
            workspace_root=repo,
            freshness_max_age_seconds=(
                freshness_max_age_seconds or DEFAULT_FRESHNESS_MAX_AGE_SECONDS
            ),
            cycle_id=cycle_id,
        )

    measurements = _run_invariant_checks(
        workspace_root=repo, invariant_checks=invariant_checks,
    )
    bh = _baseline_hash(measurements)
    details = {
        "plan_id": plan_id,
        "cycle_id": cycle_id,
        "baseline_hash": bh,
        "invariant_measurements": _measurements_to_dict(measurements),
        "fresh_adapter_runs_required": require_fresh_adapter_runs,
    }
    append_tools_governance(tools_root, "architecture_spine_baseline", details)
    return details


def detect_drift(
    *,
    baseline_measurements: dict[str, dict[str, Any]],
    postcheck_measurements: dict[str, dict[str, Any]],
) -> list[DriftReport]:
    """Compare two measurement dicts; emit a DriftReport per changed field.

    Direction:
        regression  — postcheck value > baseline (more violations)
        improvement — postcheck value < baseline (fewer violations)
        unchanged   — values equal
    Non-numeric fields (e.g. pending=True stub) compare by equality only;
    pending==pending is NOT treated as drift.
    """
    drifts: list[DriftReport] = []
    for invariant in INVARIANT_KINDS:
        b_block = baseline_measurements.get(invariant) or {}
        p_block = postcheck_measurements.get(invariant) or {}
        b_meas = b_block.get("measurements") or {}
        p_meas = p_block.get("measurements") or {}
        all_fields = sorted(set(b_meas.keys()) | set(p_meas.keys()))
        for field_name in all_fields:
            b_val = b_meas.get(field_name)
            p_val = p_meas.get(field_name)
            if b_val == p_val:
                continue
            if isinstance(b_val, (int, float)) and isinstance(p_val, (int, float)):
                if p_val > b_val:
                    direction = "regression"
                elif p_val < b_val:
                    direction = "improvement"
                else:
                    direction = "unchanged"
            else:
                # Non-numeric mismatch is treated as a drift but not
                # automatically a regression (operator interprets).
                direction = "regression"
            drifts.append(DriftReport(
                invariant=invariant,
                field=field_name,
                baseline_value=b_val,
                postcheck_value=p_val,
                direction=direction,
            ))
    return drifts


def _latest_baseline_for_plan(
    tools_root: Path,
    plan_id: str,
) -> dict[str, Any] | None:
    """Plan 025 §A.2 — uses shared governance_reader helper (STRICT)."""
    governance = tools_root / "governance.jsonl"
    latest: dict[str, Any] | None = None
    latest_ts = ""
    for row in read_governance_rows(governance, base_dir=tools_root):
        if row.get("kind") != "architecture_spine_baseline":
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
    """
    governance = tools_root / "governance.jsonl"
    relevant: list[str] = []  # most-recent-first list of event kinds
    for row in read_governance_rows(
        governance, reverse=True, base_dir=tools_root,
    ):
        kind = row.get("kind")
        if kind not in ("architecture_spine_postcheck", "architecture_spine_regression"):
            continue
        details = row.get("details") or {}
        if details.get("plan_id") != plan_id:
            continue
        if kind == "architecture_spine_postcheck":
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
    """Snapshot invariants again + diff vs latest baseline for the same plan_id.

    Emits exactly one of:
      architecture_spine_postcheck   — no regressions, plan can advance
      architecture_spine_regression  — at least one regression, plan blocked

    After `max_regression_rounds` consecutive regressions for the same
    plan_id (without an intervening clean postcheck), also emits a
    HUMAN_REQUIRED record via record_human_required().

    Plan 020 Phase 4.B — require_fresh_adapter_runs (default True): see
    take_baseline; same orchestrator chokepoint applies so the postcheck
    invariants read freshly-produced adapter rows.
    """
    if not plan_id.strip():
        raise GovernanceError("plan_id is required")
    if not cycle_id.strip():
        raise GovernanceError("cycle_id is required")
    if max_regression_rounds < 1:
        raise GovernanceError("max_regression_rounds must be >= 1")
    repo = Path(workspace_root).resolve()
    tools_root = ensure_tools_dir(base_dir)

    # Same tier-2 "make it automatic" rule as take_baseline: synthetic
    # invariant_checks bypass orchestrator; real callers go through it.
    if require_fresh_adapter_runs and invariant_checks is None:
        from .spine_orchestrator import (
            DEFAULT_FRESHNESS_MAX_AGE_SECONDS,
            refresh_spine_adapters,
        )
        refresh_spine_adapters(
            base_dir=base_dir,
            workspace_root=repo,
            freshness_max_age_seconds=(
                freshness_max_age_seconds or DEFAULT_FRESHNESS_MAX_AGE_SECONDS
            ),
            cycle_id=cycle_id,
        )

    baseline = _latest_baseline_for_plan(tools_root, plan_id)
    if baseline is None:
        raise GovernanceError(
            f"no baseline recorded for plan_id={plan_id!r}; "
            "call take_baseline first"
        )

    measurements = _run_invariant_checks(
        workspace_root=repo, invariant_checks=invariant_checks,
    )
    postcheck_dict = _measurements_to_dict(measurements)
    drifts = detect_drift(
        baseline_measurements=baseline.get("invariant_measurements", {}),
        postcheck_measurements=postcheck_dict,
    )
    regressions = [d for d in drifts if d.direction == "regression"]

    details: dict[str, Any] = {
        "plan_id": plan_id,
        "cycle_id": cycle_id,
        "baseline_hash": baseline.get("baseline_hash"),
        "postcheck_measurements": postcheck_dict,
        "drift_count": len(drifts),
        "regression_count": len(regressions),
        "drifts": [asdict(d) for d in drifts],
    }
    if regressions:
        append_tools_governance(tools_root, "architecture_spine_regression", details)
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
                        f"{d.invariant}.{d.field} ({d.baseline_value}→{d.postcheck_value})"
                        for d in regressions[:5]
                    )
                ),
                base_dir=base_dir,
            )
            details["human_required_emitted"] = True
            details["round_count"] = round_count
    else:
        append_tools_governance(tools_root, "architecture_spine_postcheck", details)
    return details


def list_spine_events(
    *,
    plan_id: str | None = None,
    base_dir: str | Path | None = None,
) -> list[dict[str, Any]]:
    """Return all spine events (baseline / postcheck / regression).

    Optionally filtered to a single plan_id. Useful for operator status
    queries via `aria-kernel spine status --plan-id X`.

    Plan 025 §A.2 — uses shared governance_reader helper (STRICT).
    """
    tools_root = ensure_tools_dir(base_dir)
    governance = tools_root / "governance.jsonl"
    out: list[dict[str, Any]] = []
    for row in read_governance_rows(governance, base_dir=tools_root):
        if row.get("kind") not in (
            "architecture_spine_baseline",
            "architecture_spine_postcheck",
            "architecture_spine_regression",
        ):
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
