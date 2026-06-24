from __future__ import annotations

import hashlib
import re
import subprocess
from pathlib import Path
from typing import Any

from .capability_resolver import resolve_capability
from .draft_intent import (
    BANNED_PHRASES_DEFAULT,
    AcceptanceTest,
    SkillDraftIntent,
)
from .draft_pii_filter import mask_pii_in_intent
from .ledger import (
    append_declared_jsonl,
    append_jsonl as _append_jsonl,
    load_declared_jsonl,
    load_jsonl as _load_jsonl,
)
from .runtime_profile import enforce_profile_for_write
from .tool_registry import GovernanceError, append_tools_governance, ensure_tools_dir, utc_now


# Plan ARIA-V3 §A3 — skill grammar contract (required sections in
# the rendered body). Locked by I-V3-07b. Adding a section requires
# matching draft_validator update + I-V3-07b parametrization.
_SKILL_REQUIRED_SECTIONS: tuple[str, ...] = (
    "Validation checklist",
)


FIXTURE_RE = re.compile(r"^##\s+Fixture:\s*(.+)$", re.MULTILINE)
MIN_FIXTURES = 3


_DECLARED_SURFACE_BY_JSONL_SUFFIX: dict[str, str] = {
    "skill-genesis/requests.jsonl": "skill_genesis_requests",
    "skill-genesis/drafts.jsonl": "skill_genesis_drafts",
    "skill-genesis/sandbox.jsonl": "skill_genesis_sandbox",
    "skill-genesis/materializations.jsonl": "skill_genesis_materializations",
    "dispatch/requests.jsonl": "dispatch_requests",
}


def _declared_surface_name(path: str | Path) -> str | None:
    concrete = Path(path)
    if len(concrete.parts) >= 2:
        suffix = "/".join(concrete.parts[-2:])
        if suffix in _DECLARED_SURFACE_BY_JSONL_SUFFIX:
            return _DECLARED_SURFACE_BY_JSONL_SUFFIX[suffix]
    return _DECLARED_SURFACE_BY_JSONL_SUFFIX.get(concrete.name)


def append_jsonl(path: Path, record: dict[str, Any]) -> dict[str, Any]:
    surface = _declared_surface_name(path)
    if surface is not None:
        return append_declared_jsonl(path, record, expected_surface=surface)
    return _append_jsonl(path, record)


def load_jsonl(path: Path) -> list[dict[str, Any]]:
    surface = _declared_surface_name(path)
    if surface is not None:
        return load_declared_jsonl(path, expected_surface=surface)
    return _load_jsonl(path)


def request_skill_genesis(
    *,
    capability_gap_key: str,
    title: str,
    convergent: bool = False,
    seed: dict[str, Any] | None = None,
    base_dir: str | Path | None = None,
) -> dict[str, Any]:
    """Skill-genesis request.

    Plan ARIA-V6 §2d v2 — ``convergent`` kwarg routes the request
    through ``convergent_skill_authoring`` (evidence-grounded
    primary↔challenger debate with 3 CROSS-VERIFY gates + judge-
    consensus 100% precision exit) instead of the legacy
    ``draft_skill`` CLI path.

    When ``convergent=True``, ``seed`` MUST be supplied with the
    F-012-adapter-seeds.jsonl row contents (declared_scope,
    claim_types, must_satisfy, calibration_corpus_path,
    adapter_lang). The request is persisted with ``convergent=true``
    so the CLI seed-batcher can replay it.
    """
    enforce_profile_for_write("skill_genesis", base_dir=base_dir)
    if not capability_gap_key.strip() or not title.strip():
        raise GovernanceError("capability_gap_key and title are required")
    if convergent and not seed:
        raise GovernanceError(
            "request_skill_genesis_convergent_requires_seed: "
            "convergent=True needs seed (declared_scope, claim_types, "
            "must_satisfy, calibration_corpus_path)"
        )
    capability_resolution = resolve_capability(
        capability_key=capability_gap_key,
        requested_kind="skill",
        title=title,
        existing_capabilities=_existing_capabilities((seed or {}).get("existing_capabilities")),
        base_dir=base_dir,
    )
    if capability_resolution.get("decision") == "reuse":
        raise GovernanceError("capability_resolution_reuse_blocks_skill_genesis")
    row: dict[str, Any] = {
        "schema_version": 1,
        "recorded_at": utc_now(),
        "request_id": _id("skill-request", capability_gap_key),
        "capability_gap_key": capability_gap_key,
        "capability_resolution_ref": capability_resolution.get("ledger_hash"),
        "title": title,
        "status": "requested",
        "convergent": bool(convergent),
    }
    if convergent and seed:
        row["seed"] = seed
    return append_jsonl(ensure_tools_dir(base_dir) / "skill-genesis" / "requests.jsonl", row)


def _existing_capabilities(values: Any) -> list[dict[str, Any]]:
    if not isinstance(values, list):
        return []
    out: list[dict[str, Any]] = []
    for value in values:
        if isinstance(value, dict):
            out.append(value)
        elif isinstance(value, str) and value.strip():
            out.append({"name": value.strip(), "capability_key": value.strip()})
    return out


def seed_adapter_requests(
    *,
    seeds_path: str | Path,
    base_dir: str | Path | None = None,
) -> list[dict[str, Any]]:
    """Plan ARIA-V6 §2d v2 C3 — batch-mint convergent requests.

    Reads an F-012-adapter-seeds.jsonl file and mints one
    ``request_skill_genesis(convergent=True)`` request per seed row.
    Returns the persisted rows for operator inspection.

    Seed schema (one JSON per line):
      {seed_id, title, capability_gap_key, declared_scope[],
       claim_types[], must_satisfy[], calibration_corpus_path,
       adapter_lang}
    """
    import json as _json
    path = Path(seeds_path)
    if not path.exists():
        raise GovernanceError(f"seed_adapter_requests_path_not_found: {path}")
    rows_out: list[dict[str, Any]] = []
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        try:
            seed = _json.loads(line)
        except _json.JSONDecodeError as exc:
            raise GovernanceError(
                f"seed_adapter_requests_invalid_json: line={line[:120]!r} "
                f"error={exc}"
            ) from exc
        required = {"seed_id", "title", "capability_gap_key",
                    "declared_scope", "claim_types", "must_satisfy",
                    "calibration_corpus_path"}
        missing = required - set(seed.keys())
        if missing:
            raise GovernanceError(
                f"seed_adapter_requests_missing_required: seed_id="
                f"{seed.get('seed_id')!r} missing={sorted(missing)}"
            )
        row = request_skill_genesis(
            capability_gap_key=seed["capability_gap_key"],
            title=seed["title"],
            convergent=True,
            seed=seed,
            base_dir=base_dir,
        )
        rows_out.append(row)
    return rows_out


def validate_calibration_corpus_sanity(
    *,
    corpus_path: str | Path,
    min_fixtures: int = 10,
    min_tp_fraction: float = 0.2,
    min_fp_fraction: float = 0.2,
    max_age_days: int = 90,
) -> dict[str, Any]:
    """Plan ARIA-V6 §2d v2 B-V2-2 — corpus sanity pre-flight.

    BEFORE sandbox runs against the corpus, verify:
      * Fixture count >= min_fixtures
      * TP fraction >= min_tp_fraction AND FP fraction >= min_fp_fraction
        (a corpus that's 100% TP can't distinguish over-fitting)
      * No duplicate fixtures (same finding_fingerprint)
      * Label freshness: most recent label <= max_age_days old

    Returns:
      {"status": "ok"|"failed", "reasons": [...], "stats": {...}}

    Fails-soft (returns failed status, does not raise) so the
    convergent_skill_authoring loop can route a failed sanity check
    to ``authoring_verdict = sandbox_systematic_failure``.
    """
    import datetime as _dt
    import json as _json
    path = Path(corpus_path)
    reasons: list[str] = []
    stats: dict[str, Any] = {"fixture_count": 0, "tp_count": 0, "fp_count": 0}
    if not path.exists():
        return {"status": "failed", "reasons": ["corpus_path_not_found"], "stats": stats}

    fixtures_file = path / "fixtures.jsonl" if path.is_dir() else path
    if not fixtures_file.exists():
        return {"status": "failed", "reasons": ["fixtures_file_not_found"], "stats": stats}

    fingerprints: set[str] = set()
    latest_label: _dt.datetime | None = None
    rows: list[dict[str, Any]] = []
    for line in fixtures_file.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or line == "[]":
            continue
        try:
            row = _json.loads(line)
        except _json.JSONDecodeError:
            reasons.append("fixture_invalid_json")
            continue
        rows.append(row)

    stats["fixture_count"] = len(rows)
    if len(rows) < min_fixtures:
        reasons.append(f"fixture_count_below_floor: {len(rows)} < {min_fixtures}")

    for row in rows:
        label = str(row.get("label") or "").lower()
        if label in ("tp", "true_positive"):
            stats["tp_count"] += 1
        elif label in ("fp", "false_positive"):
            stats["fp_count"] += 1
        fp = row.get("finding_fingerprint")
        if fp:
            if fp in fingerprints:
                reasons.append(f"duplicate_fixture: {fp}")
            fingerprints.add(fp)
        labeled_at = row.get("labeled_at")
        if isinstance(labeled_at, str):
            try:
                lt = _dt.datetime.fromisoformat(labeled_at.replace("Z", "+00:00"))
                if latest_label is None or lt > latest_label:
                    latest_label = lt
            except ValueError:
                continue

    total = stats["tp_count"] + stats["fp_count"]
    if total > 0:
        tp_frac = stats["tp_count"] / total
        fp_frac = stats["fp_count"] / total
        if tp_frac < min_tp_fraction:
            reasons.append(f"tp_fraction_below_floor: {tp_frac:.2f} < {min_tp_fraction}")
        if fp_frac < min_fp_fraction:
            reasons.append(f"fp_fraction_below_floor: {fp_frac:.2f} < {min_fp_fraction}")

    if latest_label is not None:
        now = _dt.datetime.now(_dt.timezone.utc)
        age_days = (now - latest_label).days
        stats["latest_label_age_days"] = age_days
        if age_days > max_age_days:
            reasons.append(f"label_stale: latest={age_days}d > {max_age_days}d")

    return {
        "status": "ok" if not reasons else "failed",
        "reasons": reasons,
        "stats": stats,
    }


def validate_generated_adapter(
    *,
    adapter_manifest: dict[str, Any],
    seed: dict[str, Any],
) -> dict[str, Any]:
    """Plan ARIA-V6 §2d v2 B-V4-1 — pre-register adapter pre-flight.

    BEFORE ``register_tool()`` is called on a freshly authored
    adapter, validate:
      * ``validate_tool_definition()`` passes (delegates to
        tool_registry)
      * ``read_paths`` ⊆ ``seed.declared_scope``
      * ``health_thresholds`` declares explicit ranges (not just keys)
      * ``claim_types`` exactly matches ``seed.claim_types``

    Returns:
      {"status": "ok"|"failed", "reasons": [...]}

    Fails-soft so the convergent_skill_authoring materialize phase
    can route a failed adapter to ``authored_max_rounds`` with the
    failure surfaced in ``judge_consensus_log``.
    """
    from .tool_registry import validate_tool_definition
    reasons: list[str] = []
    try:
        validate_tool_definition(adapter_manifest)
    except GovernanceError as exc:
        reasons.append(f"validate_tool_definition_failed: {exc}")
    declared = set(seed.get("declared_scope") or [])
    read_paths = set(adapter_manifest.get("read_paths") or [])
    extra = read_paths - declared
    if extra:
        reasons.append(f"read_paths_outside_declared_scope: {sorted(extra)}")
    thresholds = adapter_manifest.get("health_thresholds") or {}
    if thresholds:
        for k, v in thresholds.items():
            if not isinstance(v, dict) or "min" not in v or "max" not in v:
                reasons.append(f"health_threshold_missing_range: {k}")
    declared_claims = set(seed.get("claim_types") or [])
    manifest_claims = set(adapter_manifest.get("claim_types") or [])
    if manifest_claims != declared_claims:
        diff = (manifest_claims ^ declared_claims)
        reasons.append(f"claim_types_mismatch_seed: diff={sorted(diff)}")
    return {"status": "ok" if not reasons else "failed", "reasons": reasons}


def execute_adapter_against_corpus(
    *,
    adapter_path: str | Path,
    adapter_lang: str,
    corpus_path: str | Path,
    workspace_root: str | Path,
    timeout_seconds: float = 300.0,
) -> dict[str, Any]:
    """Plan ARIA-V6 §2d v2 B-V3-2 — sandbox subprocess executor.

    Runs the freshly authored adapter against the operator-labeled
    calibration corpus. Returns precision / recall / TP / FP / FN
    counts + the raw run output.

    Supports:
      * adapter_lang="typescript" → ``tsx <adapter>``
      * adapter_lang="python"     → ``python3 <adapter>``

    The adapter receives JSON on stdin with the corpus fixtures and
    emits JSON on stdout with finding predictions. The function
    aligns predictions with operator-labeled TP/FP via
    ``finding_fingerprint`` and computes the precision metrics.

    Returns:
      {
        "fixture_count": int,
        "precision": float,           # tp / (tp + fp)
        "recall": float,              # tp / (tp + fn)
        "critical_false_positives": int,
        "true_positives": list[str],
        "false_positives": list[str],
        "false_negatives": list[str],
        "raw_stdout_tail": str,
        "raw_stderr_tail": str,
        "exit_code": int,
      }

    Returns precision=recall=0.0 on subprocess failure (the
    convergent loop interprets as imperfect → loop continues OR
    cap-hits to authored_max_rounds).
    """
    import json as _json
    corpus = Path(corpus_path)
    fixtures_file = corpus / "fixtures.jsonl" if corpus.is_dir() else corpus
    if not fixtures_file.exists():
        return _zero_metrics_result(0, exit_code=-1, stderr="corpus_not_found")

    # Plan 026R §A.3 — route JSONL row read through read_strict_jsonl
    # (tolerant mode) so corrupt rows emit a diagnostic to
    # ``aria-tools/diagnostics/`` instead of being silently dropped.
    from .strict_jsonl_reader import read_strict_jsonl
    fixtures: list[dict[str, Any]] = list(
        read_strict_jsonl(fixtures_file, on_corruption="tolerant")
    )
    if not fixtures:
        return _zero_metrics_result(0, exit_code=-1, stderr="corpus_empty")

    if adapter_lang == "typescript":
        argv = ["tsx", str(adapter_path)]
    elif adapter_lang == "python":
        argv = ["python3", str(adapter_path)]
    else:
        return _zero_metrics_result(
            len(fixtures), exit_code=-1,
            stderr=f"unsupported_adapter_lang: {adapter_lang}",
        )

    stdin_payload = _json.dumps({"fixtures": fixtures}).encode("utf-8")
    try:
        completed = subprocess.run(
            argv,
            cwd=str(Path(workspace_root).resolve()),
            input=stdin_payload,
            capture_output=True,
            timeout=timeout_seconds,
            check=False,
        )
    except subprocess.TimeoutExpired:
        return _zero_metrics_result(
            len(fixtures), exit_code=-2, stderr="subprocess_timeout",
        )
    except FileNotFoundError as exc:
        return _zero_metrics_result(
            len(fixtures), exit_code=-3, stderr=f"runner_not_found: {exc}",
        )

    stdout_text = completed.stdout.decode("utf-8", errors="replace")
    stderr_text = completed.stderr.decode("utf-8", errors="replace")

    if completed.returncode != 0:
        return _zero_metrics_result(
            len(fixtures), exit_code=completed.returncode,
            stdout=stdout_text, stderr=stderr_text,
        )

    try:
        prediction_payload = _json.loads(stdout_text)
    except _json.JSONDecodeError:
        return _zero_metrics_result(
            len(fixtures), exit_code=completed.returncode,
            stdout=stdout_text, stderr=stderr_text + "\nadapter_stdout_not_json",
        )

    predicted: set[str] = {
        str(p.get("finding_fingerprint") or "")
        for p in (prediction_payload.get("findings") or [])
        if p.get("finding_fingerprint")
    }
    critical_fps: set[str] = {
        str(p.get("finding_fingerprint") or "")
        for p in (prediction_payload.get("findings") or [])
        if p.get("severity", "").upper() == "CRITICAL"
        and p.get("finding_fingerprint")
    }
    operator_labels: dict[str, str] = {
        str(f.get("finding_fingerprint") or ""):
            str(f.get("label") or "").lower()
        for f in fixtures
        if f.get("finding_fingerprint")
    }

    true_positives: list[str] = []
    false_positives: list[str] = []
    false_negatives: list[str] = []
    critical_fp_count = 0
    for fp_id in predicted:
        label = operator_labels.get(fp_id, "")
        if label in ("tp", "true_positive"):
            true_positives.append(fp_id)
        elif label in ("fp", "false_positive"):
            false_positives.append(fp_id)
            if fp_id in critical_fps:
                critical_fp_count += 1
        else:
            # Unlabeled fixture — treat as false positive
            false_positives.append(fp_id)
            if fp_id in critical_fps:
                critical_fp_count += 1
    for fingerprint, label in operator_labels.items():
        if label in ("tp", "true_positive") and fingerprint not in predicted:
            false_negatives.append(fingerprint)

    tp = len(true_positives)
    fp = len(false_positives)
    fn = len(false_negatives)
    precision = (tp / (tp + fp)) if (tp + fp) > 0 else 0.0
    recall = (tp / (tp + fn)) if (tp + fn) > 0 else 0.0

    return {
        "fixture_count": len(fixtures),
        "precision": precision,
        "recall": recall,
        "critical_false_positives": critical_fp_count,
        "true_positives": true_positives,
        "false_positives": false_positives,
        "false_negatives": false_negatives,
        "raw_stdout_tail": stdout_text[-4000:],
        "raw_stderr_tail": stderr_text[-4000:],
        "exit_code": completed.returncode,
    }


def _zero_metrics_result(
    fixture_count: int,
    *,
    exit_code: int,
    stdout: str = "",
    stderr: str = "",
) -> dict[str, Any]:
    """Plan ARIA-V6 §2d v2 — degraded-execution metrics envelope."""
    return {
        "fixture_count": fixture_count,
        "precision": 0.0,
        "recall": 0.0,
        "critical_false_positives": 0,
        "true_positives": [],
        "false_positives": [],
        "false_negatives": [],
        "raw_stdout_tail": stdout[-4000:],
        "raw_stderr_tail": stderr[-4000:],
        "exit_code": exit_code,
    }


def draft_skill(
    *,
    request_id: str,
    name: str,
    description: str,
    owners: list[str],
    handoff_agents: list[str],
    base_dir: str | Path | None = None,
) -> dict[str, Any]:
    """Plan 026R §E.3 — skill genesis chain: draft requires request.

    Pre-§E.3 a draft_skill call accepted any request_id string — no
    check that a matching skill-genesis request row existed. Genesis
    chain integrity demands every draft trace to a real request;
    silent acceptance lets a skill enter the pipeline with no
    audit-trail anchor.
    """
    enforce_profile_for_write("skill_genesis", base_dir=base_dir)
    request = _find_request(request_id, base_dir)
    if request is None:
        raise GovernanceError(
            f"skill_draft_request_not_found: request_id={request_id!r}"
        )
    if not re.match(r"^[a-z][a-z0-9-]{1,80}$", name or ""):
        raise GovernanceError("skill name is invalid")
    if not owners or not handoff_agents:
        raise GovernanceError("skill draft requires owners and handoff agents")
    # Plan ARIA-V3 §A3 — kernel emits the SkillDraftIntent (grammar),
    # not the rendered markdown. Body synthesis is delegated to the
    # drafter via worker_executor.py. ``draft.body`` is populated
    # after a passing drafter run + grammar validation.
    intent = _render_skill(
        name=name,
        description=description,
        owners=owners,
        handoff_agents=handoff_agents,
    )
    row = {
        "schema_version": 1,
        "recorded_at": utc_now(),
        "draft_id": f"skill-draft-{name}",
        "request_id": request_id,
        "name": name,
        "target_path": intent.target_path,
        "intent": intent.to_dict(),
        "body": None,
        "status": "draft_shadow",
    }
    return append_jsonl(ensure_tools_dir(base_dir) / "skill-genesis" / "drafts.jsonl", row)


def parse_fixture_blocks(markdown: str) -> list[dict[str, Any]]:
    """Extract `## Fixture: <id>` headers as structured pass-results.

    L1-safe: regex over Markdown structural markers only — no instruction
    execution, no body parsing.
    """
    ids = [match.group(1).strip() for match in FIXTURE_RE.finditer(markdown)]
    return [{"fixture_id": fid, "status": "pass"} for fid in ids if fid]


def sandbox_skill(
    *,
    draft_id: str,
    checklist_results: list[dict[str, Any]] | None = None,
    markdown_path: str | Path | None = None,
    base_dir: str | Path | None = None,
    synthetic_test_mode: bool = False,
    operator_approval_ref: str | None = None,
) -> dict[str, Any]:
    """Validate a skill draft against fixture coverage.

    Plan 026R §E.3 — chain: sandbox requires a matching draft row.

    Two input modes (mutually exclusive):
    - markdown_path: parse `## Fixture: <id>` blocks from skill markdown content (preferred).
    - checklist_results: explicit JSON array — kept for backward compat (deprecated).

    Both paths require at least MIN_FIXTURES (3) entries; failure entries flip
    decision to "fail" without bypassing the minimum-count guard.
    """
    enforce_profile_for_write("skill_genesis", base_dir=base_dir)
    # Plan 026R §E.3 — chain enforcement.
    if _find_draft(draft_id, base_dir) is None:
        raise GovernanceError(
            f"skill_sandbox_draft_not_found: draft_id={draft_id!r}"
        )
    if markdown_path is not None and checklist_results is not None:
        raise GovernanceError("provide either markdown_path or checklist_results, not both")
    source_path: Path | None = None
    source_sha256: str | None = None
    if markdown_path is not None:
        path = Path(markdown_path)
        if not path.exists():
            raise GovernanceError(f"markdown_path not found: {markdown_path}")
        raw_markdown = path.read_text(encoding="utf-8")
        checklist_results = parse_fixture_blocks(raw_markdown)
        source_path = path.resolve()
        source_sha256 = "sha256:" + hashlib.sha256(raw_markdown.encode("utf-8")).hexdigest()
    if checklist_results is None:
        raise GovernanceError("skill sandbox requires markdown_path or checklist_results")
    if markdown_path is None and not synthetic_test_mode:
        raise GovernanceError("skill_checklist_sandbox_requires_synthetic_test_mode")
    if synthetic_test_mode and not (operator_approval_ref or "").strip():
        raise GovernanceError("skill_synthetic_sandbox_requires_operator_approval_ref")
    if len(checklist_results) < MIN_FIXTURES:
        raise GovernanceError(
            f"skill sandbox requires at least {MIN_FIXTURES} fixture entries (## Fixture: <id> blocks or checklist results)"
        )
    failed = [row for row in checklist_results if row.get("status") != "pass"]
    row = {
        "schema_version": 1,
        "recorded_at": utc_now(),
        "draft_id": draft_id,
        "decision": "fail" if failed else "pass",
        "checklist_results": checklist_results,
        "source": "markdown" if markdown_path is not None else "checklist_json",
        "source_path": source_path.as_posix() if source_path is not None else None,
        "source_sha256": source_sha256,
        "synthetic_test_mode": bool(synthetic_test_mode),
        "operator_approval_ref": operator_approval_ref if synthetic_test_mode else None,
    }
    root = ensure_tools_dir(base_dir)
    stored = append_jsonl(root / "skill-genesis" / "sandbox.jsonl", row)
    if synthetic_test_mode:
        append_tools_governance(
            root,
            "skill_genesis_synthetic_sandbox_used",
            {
                "draft_id": draft_id,
                "operator_approval_ref": operator_approval_ref,
                "source": row["source"],
                "sandbox_event_id": stored.get("event_id"),
            },
        )
    return stored


def approve_skill_pr(
    *,
    draft_id: str,
    operator_approval_ref: str,
    base_dir: str | Path | None = None,
    operator_synthetic_override: bool = False,
) -> dict[str, Any]:
    from .runtime_profile import enforce_profile_for_write
    enforce_profile_for_write("skill_genesis", base_dir=base_dir)
    if not operator_approval_ref.strip():
        raise GovernanceError("operator approval ref is required")
    draft = _find_draft(draft_id, base_dir)
    if draft is None:
        raise GovernanceError(f"skill_approve_draft_not_found: draft_id={draft_id!r}")
    sandbox = _latest_sandbox(draft_id, base_dir)
    if not sandbox or sandbox.get("decision") != "pass":
        raise GovernanceError("skill draft must pass sandbox before PR approval")
    if sandbox.get("synthetic_test_mode") and not operator_synthetic_override:
        raise GovernanceError("skill_synthetic_sandbox_requires_operator_override")
    row = dict(draft)
    row["recorded_at"] = utc_now()
    row["status"] = "approved_for_skill_pr"
    row["operator_approval_ref"] = operator_approval_ref
    return append_jsonl(ensure_tools_dir(base_dir) / "skill-genesis" / "drafts.jsonl", row)


def materialize_skill(
    *,
    draft_id: str,
    assignment_id: str,
    workspace_root: str | Path,
    gate: "AutoActionGate",  # type: ignore[name-defined]  # noqa: F821
    base_dir: str | Path | None = None,
    run_invariants: bool = False,
    ack_id: str | None = None,
    operator_synthetic_override: bool = False,
) -> dict[str, Any]:
    """Plan ARIA-V3 §A4 — acknowledge parameter REMOVED; gate REQUIRED.

    The gate encapsulates profile + lane + classifier + ack-token
    resolution + the ``materialize_event_id`` UUID that links the
    three-event audit chain.
    """
    from .auto_action_gate import AutoActionGate
    if not isinstance(gate, AutoActionGate):
        raise GovernanceError(
            f"materialize_skill requires gate: AutoActionGate "
            f"(Plan ARIA-V3 §A4); got {type(gate).__name__!r}"
        )
    draft = _find_draft(draft_id, base_dir)
    if draft is None:
        raise GovernanceError(
            f"skill_materialize_draft_not_found: draft_id={draft_id!r}"
        )
    sandbox = _latest_sandbox(draft_id, base_dir)
    if not sandbox or sandbox.get("decision") != "pass":
        raise GovernanceError(
            f"skill_materialize_requires_passing_sandbox: "
            f"draft_id={draft_id!r} sandbox={sandbox}"
        )
    if sandbox.get("synthetic_test_mode") and not operator_synthetic_override:
        raise GovernanceError("skill_synthetic_sandbox_requires_operator_override")
    # Plan 026R §E.3 — chain: materialise requires passing sandbox and explicit approval.
    if draft.get("status") != "approved_for_skill_pr":
        raise GovernanceError("skill draft must be approved_for_skill_pr before materialization")
    dispatch = _find_dispatch(assignment_id, base_dir)
    worktree = Path(str(dispatch.get("worktree_path") or ""))
    if not worktree.is_absolute():
        worktree = Path(workspace_root).resolve() / worktree
    if not worktree.exists():
        raise GovernanceError("dispatch_worktree_missing")
    target_path = str(draft.get("target_path") or "")
    if not target_path.startswith(".claude/skills/") or not target_path.endswith(".md"):
        raise GovernanceError("target_path_not_skill_scoped")
    # Plan ARIA-V3 §A4 + §2g — three-event audit chain link.
    materialize_event_id = gate.materialize_event_id
    # Plan ARIA-V3 §A3 — body comes from the drafter; kernel does
    # not synthesise markdown. Materialize refuses fail-closed when
    # the drafter has not produced a validated body yet.
    body = draft.get("body")
    if not isinstance(body, str) or not body.strip():
        raise GovernanceError(
            f"skill_materialize_requires_drafter_body: draft_id={draft_id!r} "
            f"has no validated body yet (drafter run pending or failed)"
        )
    intent_dict = draft.get("intent") or {}
    if isinstance(intent_dict, dict):
        from .draft_intent import AcceptanceTest as _AT, SkillDraftIntent as _SDI
        from .draft_validator import validate_body_against_intent
        intent_obj = _SDI(
            intent_kind=intent_dict.get("intent_kind", "skill"),
            intent_id=intent_dict.get("intent_id", ""),
            name=intent_dict.get("name", ""),
            target_path=intent_dict.get("target_path", target_path),
            description=intent_dict.get("description", ""),
            required_sections=tuple(intent_dict.get("required_sections") or ()),
            owners=tuple(intent_dict.get("owners") or ()),
            handoff_agents=tuple(intent_dict.get("handoff_agents") or ()),
            shadow_period_days=int(intent_dict.get("shadow_period_days") or 14),
            precision_threshold=float(intent_dict.get("precision_threshold") or 0.85),
            acceptance_tests=tuple(
                _AT(
                    name=t.get("name", ""),
                    expected=t.get("expected", ""),
                    description=t.get("description", ""),
                )
                for t in intent_dict.get("acceptance_tests") or ()
                if isinstance(t, dict)
            ),
            evidence_allowlist=tuple(intent_dict.get("evidence_allowlist") or ()),
            diff_classifier_lane=intent_dict.get("diff_classifier_lane", "L0-main"),
            banned_phrases=tuple(intent_dict.get("banned_phrases") or ()),
        )
        policy_path = Path(__file__).resolve().parent / "data" / "auto_action_policy.json"
        result = validate_body_against_intent(
            body, intent_obj, auto_action_policy_path=policy_path,
        )
        if not result.valid:
            raise GovernanceError(
                "skill_materialize_body_grammar_invalid: "
                + ";".join(result.complaints)
            )
        from .tool_registry import append_tools_governance
        append_tools_governance(
            ensure_tools_dir(base_dir),
            "draft_validated",
            {
                "materialize_event_id": materialize_event_id,
                "draft_id": draft_id,
                "intent_id": intent_obj.intent_id,
                "validator_result": "valid",
                "body_sha256": __import__("hashlib").sha256(body.encode("utf-8")).hexdigest(),
                "kind": "skill",
            },
        )
    # Plan ARIA-V3 §2g event 2 — ack_consumed (operator or auto).
    gate_outcome = gate.acquire_or_consume(
        ack_id=ack_id,
        base_dir=ensure_tools_dir(base_dir),
        draft_id=draft_id,
        intent_id=str(intent_dict.get("intent_id", "")),
        target_path=target_path,
        kind="skill",
        commit_sha_at_mint=_git_head(worktree),
        profile_state_at_mint=f"{gate.profile}:v1",
    )
    target = worktree / target_path
    try:
        target.resolve().relative_to(worktree.resolve())
    except ValueError as exc:
        raise GovernanceError("target_path_escapes_worktree") from exc
    file_sha256_pre = _file_sha256(target)
    target.parent.mkdir(parents=True, exist_ok=True)
    tmp = target.with_name(f".{target.name}.tmp")
    tmp.write_text(body, encoding="utf-8")
    tmp.replace(target)
    status = "accepted"
    validation = None
    if run_invariants:
        completed = subprocess.run(["npm", "run", "invariants:full"], cwd=worktree, text=True, capture_output=True, check=False)
        validation = {"returncode": completed.returncode, "stdout": completed.stdout[-4000:], "stderr": completed.stderr[-4000:]}
        if completed.returncode != 0:
            subprocess.run(["git", "restore", "--", target_path], cwd=worktree, text=True, capture_output=True, check=False)
            status = "rejected"
    # Plan ARIA-V3 §2g event 3 — materialize_committed.
    import hashlib as _hl
    from .tool_registry import append_tools_governance
    append_tools_governance(
        ensure_tools_dir(base_dir),
        "materialize_committed",
        {
            "materialize_event_id": materialize_event_id,
            "target_path": target_path,
            "file_sha256_pre": file_sha256_pre,
            "file_sha256_post": _hl.sha256(body.encode("utf-8")).hexdigest(),
            "commit_sha": _git_head(worktree),
            "draft_id": draft_id,
            "assignment_id": assignment_id,
            "kind": "skill",
            "status": status,
            "ack_consumed_at": gate_outcome.get("consumed_at"),
            "ack_id": gate_outcome.get("ack_id"),
        },
    )
    row = {
        "schema_version": 1,
        "recorded_at": utc_now(),
        "draft_id": draft_id,
        "assignment_id": assignment_id,
        "worktree_path": worktree.as_posix(),
        "target_path": target_path,
        "status": status,
        "validation": validation,
        "materialize_event_id": materialize_event_id,
        "ack_id": gate_outcome.get("ack_id"),
        "gate_profile": gate.profile,
        "gate_lane": gate.lane,
        "gate_human_ack_required": gate.human_ack_required,
    }
    return append_jsonl(ensure_tools_dir(base_dir) / "skill-genesis" / "materializations.jsonl", row)



def _git_head(path: Path) -> str:
    completed = subprocess.run(["git", "rev-parse", "HEAD"], cwd=path, text=True, capture_output=True, check=False)
    return completed.stdout.strip() if completed.returncode == 0 else "unknown"


def _file_sha256(path: Path) -> str:
    if not path.exists() or not path.is_file():
        return ""
    import hashlib as _hashlib
    return _hashlib.sha256(path.read_bytes()).hexdigest()

def list_skill_genesis(*, base_dir: str | Path | None = None, kind: str = "drafts") -> list[dict[str, Any]]:
    filename = {
        "requests": "requests.jsonl",
        "drafts": "drafts.jsonl",
        "sandbox": "sandbox.jsonl",
        "materializations": "materializations.jsonl",
    }.get(kind, "drafts.jsonl")
    return load_jsonl(ensure_tools_dir(base_dir) / "skill-genesis" / filename)


def _render_skill(
    *,
    name: str,
    description: str,
    owners: list[str],
    handoff_agents: list[str],
) -> SkillDraftIntent:
    """Plan ARIA-V3 §A3 + I-V3-12b — return the grammar, not the body.

    The skill body (markdown including `## Fixture: <id>` blocks the
    sandbox parses) is synthesised by ``worker_executor.py`` drafter
    mode and validated against this intent via
    ``draft_validator.validate_body_against_intent`` before
    materialisation. PII masking applied before the intent reaches
    Claude (AUDITTRAIL-HIGH-008).
    """
    intent = SkillDraftIntent(
        intent_kind="skill",
        intent_id=f"intent-skill-{name}",
        name=name,
        target_path=f".claude/skills/{name}.md",
        description=description,
        required_sections=_SKILL_REQUIRED_SECTIONS,
        owners=tuple(owners),
        handoff_agents=tuple(handoff_agents),
        shadow_period_days=14,
        precision_threshold=0.85,
        acceptance_tests=(
            AcceptanceTest(
                name="true-positive",
                expected="finding_emitted",
                description="canonical true-positive fixture",
            ),
            AcceptanceTest(
                name="false-positive-guard",
                expected="no_finding",
                description="false-positive suppression test",
            ),
            AcceptanceTest(
                name="handoff-resolves",
                expected="handoff_dispatch_recorded",
                description="post-emit handoff to declared agents",
            ),
        ),
        evidence_allowlist=tuple(),
        diff_classifier_lane="L0-main",
    )
    return mask_pii_in_intent(intent)  # type: ignore[return-value]


def _find_request(
    request_id: str, base_dir: str | Path | None,
) -> dict[str, Any] | None:
    """Plan 026R §E.3 — chain anchor lookup for draft_skill."""
    for row in reversed(list_skill_genesis(base_dir=base_dir, kind="requests")):
        if row.get("request_id") == request_id:
            return row
    return None


def _find_draft(
    draft_id: str, base_dir: str | Path | None,
) -> dict[str, Any] | None:
    """Plan 026R §E.3 — return None on miss instead of raising, so the
    callers (sandbox_skill, materialize_skill) can emit specific
    chain-violation errors rather than the generic legacy raise."""
    for row in reversed(list_skill_genesis(base_dir=base_dir, kind="drafts")):
        if row.get("draft_id") == draft_id:
            return row
    return None


def _latest_sandbox(
    draft_id: str, base_dir: str | Path | None,
) -> dict[str, Any] | None:
    """Plan 026R §E.3 — return the latest sandbox row for a draft_id."""
    latest: dict[str, Any] | None = None
    for row in list_skill_genesis(base_dir=base_dir, kind="sandbox"):
        if row.get("draft_id") == draft_id:
            latest = row
    return latest


def _find_dispatch(assignment_id: str, base_dir: str | Path | None) -> dict[str, Any]:
    for row in reversed(load_jsonl(ensure_tools_dir(base_dir) / "dispatch" / "requests.jsonl")):
        if row.get("assignment_id") == assignment_id:
            return row
    raise GovernanceError(f"dispatch request not found: {assignment_id}")


def _id(prefix: str, value: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", value.lower()).strip("-")[:48] or "skill"
    return f"{prefix}-{slug}"
